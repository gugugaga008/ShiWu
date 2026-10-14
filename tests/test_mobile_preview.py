"""扫码预览安全与生命周期测试：主 API 和 LAN 预览均使用真实临时 HTTP 服务器。"""
from __future__ import annotations

import base64
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from urllib.parse import urlsplit

import cv2
import httpx
import numpy as np
import pytest
import uvicorn
from fastapi import HTTPException

from shiwu.api.boss import mobile_preview as mobile

MAIN_TOKEN = "pytest-main-token"
# 监听必须绑定真实本机地址；仅测试枚举器允许回环地址，生产仍只接受私网网卡。
ADDRESSES = ["127.0.0.1", *(mobile.local_private_ipv4()[:1] or ["127.0.0.1"])]


class Pipeline:
    def __init__(self):
        self.alive = True
        self._stop = threading.Event()
        self._thread = SimpleNamespace(is_alive=lambda: self.alive)

    def stop(self, timeout=5):
        self._stop.set()
        self.alive = False


def runner(name="摄像头 A", jpeg=b"source-a"):
    return SimpleNamespace(name=name, latest_jpeg=jpeg, pipeline=Pipeline(), started_at=time.time())


@pytest.fixture
def preview(monkeypatch):
    runtime = SimpleNamespace(runners={"摄像头 A": runner(), "摄像头 B": runner("摄像头 B", b"source-b")})
    manager = mobile.MobilePreview(runtime)
    runtime.mobile_preview = manager
    monkeypatch.setattr(mobile, "local_private_ipv4", lambda: list(ADDRESSES))
    yield manager
    manager.close()


@pytest.fixture
def api(preview, monkeypatch, tmp_path):
    # 隔离首次导入的全局 runtime，不打开用户库；不启动 ONNX 模型。
    monkeypatch.setenv("SHIWU_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SHIWU_GALLERY_DIR", str(tmp_path / "gallery"))
    monkeypatch.setenv("SHIWU_MACHINE_KEY", "11" * 32)
    monkeypatch.setenv("SHIWU_API_TOKEN", MAIN_TOKEN)
    from shiwu.api.boss import routes
    from shiwu.app import create_app
    monkeypatch.setattr(routes, "runtime", preview.runtime)
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(create_app(), lifespan="off", log_level="error", access_log=False))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and thread.is_alive() and time.monotonic() < deadline:
        time.sleep(0.01)
    assert server.started
    client = httpx.Client(base_url=f"http://127.0.0.1:{port}", headers={"X-Shiwu-Token": MAIN_TOKEN},
                          timeout=3, trust_env=False)
    try:
        yield client
    finally:
        client.close()
        server.should_exit = True
        thread.join(5)
        listener.close()
        assert not thread.is_alive()


def decode(response):
    png = base64.b64decode(response["qr"].split(",", 1)[1])
    image = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert image is not None
    url, points, _ = cv2.QRCodeDetector().detectAndDecode(image)
    # 通用定位器对部分合法矩阵存在盲区；ArUco 定位器独立真实解码，不绕过断言。
    if not url:
        url, points, _ = cv2.QRCodeDetectorAruco().detectAndDecode(image)
    for scale in (0.75, 0.5, 1.5, 1.25):
        if url:
            break
        resized = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
        url, points, _ = cv2.QRCodeDetector().detectAndDecode(resized)
    assert points is not None and url
    parts = urlsplit(url)
    assert parts.scheme == "http" and not parts.query and parts.fragment
    return parts


def lan(response):
    parts = decode(response)
    return httpx.Client(base_url=f"http://{parts.hostname}:{parts.port}", timeout=3, trust_env=False), parts


def auth(parts):
    return {"Authorization": "Bearer " + parts.fragment}


def assert_headers(response):
    for key, value in mobile.SECURITY_HEADERS.items():
        assert response.headers[key] == value
    assert "Access-Control-Allow-Origin" not in response.headers


def wait_closed(port, address=ADDRESSES[0]):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        with socket.socket() as connection:
            connection.settimeout(0.2)
            if connection.connect_ex((address, port)) != 0:
                return
        time.sleep(0.02)
    pytest.fail("撤销或过期后监听仍未关闭")


def test_qr_decoding_uses_independent_detector_on_localization_failure(preview, monkeypatch):
    result = preview.create("摄像头 A")
    monkeypatch.setattr(cv2, "QRCodeDetector", lambda: SimpleNamespace(
        detectAndDecode=lambda image: ("", None, None)))
    # 通用检测器未定位时，仍必须由实际 ArUco 检测器从 PNG 恢复凭据和地址。
    parts = decode(result)
    assert parts.path == "/preview/" + result["id"]
    assert parts.fragment == preview._sessions[result["id"]].token
    assert parts.hostname == result["address"]


def test_api_contract_auth_and_qr(api, preview):
    assert api.post("/boss/mobile-preview", json={"source": "摄像头 A"},
                    headers={"X-Shiwu-Token": "wrong"}).status_code == 401
    response = api.post("/boss/mobile-preview", json={"source": "摄像头 A", "address": ADDRESSES[1]})
    assert response.status_code == 200
    assert_headers(response)
    result = response.json()
    assert set(result) == {"id", "qr", "expires_at", "addresses", "address"}
    assert result["addresses"] == ADDRESSES and result["address"] == ADDRESSES[1]
    assert 595 < result["expires_at"] - time.time() <= 600
    assert MAIN_TOKEN not in response.text
    with lan(result)[0] as client:
        parts = decode(result)
        assert parts.hostname == ADDRESSES[1]
        assert parts.path == "/preview/" + result["id"]
        page = client.get(parts.path)
        assert page.status_code == 200
        assert_headers(page)
        assert parts.fragment not in page.text and MAIN_TOKEN not in page.text
        assert "history.replaceState" in page.text and "Authorization: 'Bearer ' + token" in page.text
        assert "clearFrame" in page.text and "预览已过期" in page.text and "暂无画面" in page.text
        assert "<script src=" not in page.text
        frame = client.get(parts.path + "/frame.jpg", headers=auth(parts))
        assert frame.status_code == 200 and frame.content == b"source-a"
        assert_headers(frame)
    assert api.delete("/boss/mobile-preview/" + result["id"],
                      headers={"X-Shiwu-Token": "wrong"}).status_code == 401
    revoked = api.delete("/boss/mobile-preview/" + result["id"])
    assert revoked.json() == {"success": True}
    assert_headers(revoked)
    wait_closed(parts.port, parts.hostname)
    assert api.delete("/boss/mobile-preview/" + result["id"]).status_code == 200


@pytest.mark.parametrize("address", ["8.8.8.8", "127.0.0.2", "169.254.1.1", "192.0.2.1", "10.1.2.3:80",
                                    "localhost", "http://10.1.2.3", "::1"])
def test_reject_nonlocal_address(api, preview, address):
    response = api.post("/boss/mobile-preview", json={"source": "摄像头 A", "address": address})
    assert response.status_code in (400, 422)
    assert not preview._listeners


def test_no_lan_and_bad_source(api, preview, monkeypatch):
    for body in ({}, {"source": ""}, {"source": 12}):
        assert api.post("/boss/mobile-preview", json=body).status_code == 422
    response = api.post("/boss/mobile-preview", json={"source": "不存在"})
    assert response.status_code == 409 and "画面源" in response.json()["detail"]
    monkeypatch.setattr(mobile, "local_private_ipv4", lambda: [])
    response = api.post("/boss/mobile-preview", json={"source": "摄像头 A"})
    assert response.status_code == 503 and "局域网" in response.json()["detail"]
    monkeypatch.setattr(mobile, "local_private_ipv4", lambda: (_ for _ in ()).throw(OSError()))
    assert api.post("/boss/mobile-preview", json={"source": "摄像头 A"}).status_code == 503
    assert not preview._listeners


def test_wrong_token_single_source_and_no_frame(preview, caplog):
    first = preview.create("摄像头 A")
    second = preview.create("摄像头 B")
    with lan(first)[0] as client:
        a, b = decode(first), decode(second)
        path = a.path + "/frame.jpg"
        for headers in ({}, {"Authorization": "Bearer wrong"}, {"X-Shiwu-Token": MAIN_TOKEN}, auth(b)):
            response = client.get(path, headers=headers)
            assert response.status_code == 401
            assert_headers(response)
        assert client.get(b.path + "/frame.jpg", headers=auth(a)).status_code == 401
        assert client.get(path + "?token=" + a.fragment).status_code == 404
        assert client.get(path + "?source=摄像头 B", headers=auth(a)).status_code == 404
        assert client.get(path, headers=auth(a)).content == b"source-a"
        assert client.get(b.path + "/frame.jpg", headers=auth(b)).content == b"source-b"
        preview.runtime.runners["摄像头 A"].latest_jpeg = None
        response = client.get(path, headers=auth(a))
        assert response.status_code == 204 and not response.content
        assert_headers(response)
    assert a.fragment not in caplog.text and b.fragment not in caplog.text and MAIN_TOKEN not in caplog.text


@pytest.mark.parametrize("path", ["/boss/status", "/boss/preview.jpg", "/boss/pipeline/stop", "/ui/", "/models",
                                  "/", "/attendance/members"])
def test_no_management_routes(preview, path):
    result = preview.create("摄像头 A")
    with lan(result)[0] as client:
        response = client.get(path, headers={"X-Shiwu-Token": MAIN_TOKEN, **auth(decode(result))})
        assert response.status_code == 404
        assert_headers(response)
        for method in ("POST", "DELETE", "OPTIONS", "HEAD"):
            response = client.request(method, path)
            assert response.status_code == 501
            assert_headers(response)


def test_revoke_one_keeps_other_and_reopen(preview):
    first, second = preview.create("摄像头 A"), preview.create("摄像头 B")
    with lan(first)[0] as client:
        a, b = decode(first), decode(second)
        preview.revoke(first["id"])
        response = client.get(a.path + "/frame.jpg", headers=auth(a))
        assert response.status_code == 410
        assert_headers(response)
        assert client.get(b.path + "/frame.jpg", headers=auth(b)).content == b"source-b"
        preview.revoke(second["id"])
    wait_closed(a.port)
    replacement = preview.create("摄像头 A")
    with lan(replacement)[0] as client:
        parts = decode(replacement)
        assert replacement["id"] != first["id"]
        assert client.get(parts.path + "/frame.jpg", headers=auth(a)).status_code == 401
        assert client.get(parts.path + "/frame.jpg", headers=auth(parts)).status_code == 200


def test_expiry_http_and_idle_auto_close(preview):
    keep = preview.create("摄像头 B")
    preview.TTL = 0.8
    expiring = preview.create("摄像头 A")
    with lan(expiring)[0] as client:
        parts = decode(expiring)
        time.sleep(0.85)
        response = client.get(parts.path + "/frame.jpg", headers=auth(parts))
        assert response.status_code == 410
        assert_headers(response)
    preview.revoke(keep["id"])
    idle = preview.create("摄像头 A")
    port = preview._listeners[ADDRESSES[0]].server.server_port
    # 没有任何手机请求，也必须自行过期并关闭监听。
    time.sleep(0.85)
    wait_closed(port)
    assert idle["id"] not in preview._sessions and not preview._listeners


@pytest.mark.parametrize("change", ["stop", "remove", "replace", "pipeline", "restart", "eof"])
def test_source_identity_never_falls_back(preview, change):
    first, keep = preview.create("摄像头 A"), preview.create("摄像头 B")
    original = preview.runtime.runners["摄像头 A"]
    with lan(first)[0] as client:
        parts = decode(first)
        if change == "stop":
            original.pipeline._stop.set()
        elif change == "remove":
            preview.runtime.runners.pop("摄像头 A")
        elif change == "replace":
            preview.runtime.runners["摄像头 A"] = runner(jpeg=b"replacement")
        elif change == "pipeline":
            original.pipeline = Pipeline()
        elif change == "restart":
            original.started_at += 1
        else:
            original.pipeline.alive = False
        assert client.get(parts.path + "/frame.jpg", headers=auth(parts)).status_code == 410
        assert client.get(parts.path).status_code == 410
        b = decode(keep)
        assert client.get(b.path + "/frame.jpg", headers=auth(b)).content == b"source-b"
        # 即使恢复原对象/线程，已撤销的短凭据不能恢复有效。
        preview.runtime.runners["摄像头 A"] = original
        original.pipeline = Pipeline()
        assert client.get(parts.path + "/frame.jpg", headers=auth(parts)).status_code == 410


def test_source_end_closes_without_requests(preview):
    preview.create("摄像头 A")
    port = preview._listeners[ADDRESSES[0]].server.server_port
    preview.runtime.runners["摄像头 A"].pipeline.alive = False
    wait_closed(port)
    assert not preview._listeners


def test_session_limit_concurrent_and_release(preview):
    with ThreadPoolExecutor(max_workers=12) as pool:
        def create(_):
            try:
                return preview.create("摄像头 A")
            except HTTPException as error:
                return error.status_code
        results = list(pool.map(create, range(12)))
    successful = [result for result in results if isinstance(result, dict)]
    assert len(successful) == preview.MAX_SESSIONS
    assert results.count(429) == 12 - preview.MAX_SESSIONS
    assert len({result["id"] for result in successful}) == preview.MAX_SESSIONS
    preview.revoke(successful[0]["id"])
    assert preview.create("摄像头 A")["id"]


def test_runtime_stop_revokes_before_join(api, preview):
    from shiwu.api.boss.runtime import BossRuntime
    result = preview.create("摄像头 A")
    parts = decode(result)
    runtime = preview.runtime
    runtime._broadcast = lambda payload: None
    runtime.pipeline_source = {}
    runtime._sources_brief = lambda: []
    runtime.pipeline_status = lambda: {"running": False}
    original = runtime.runners["摄像头 A"]
    def stop(timeout):
        assert not preview._listeners
        assert result["id"] not in preview._sessions
        original.pipeline._stop.set()
    original.pipeline.stop = stop
    assert BossRuntime.stop_pipeline(runtime, "摄像头 A") == {"running": False}
    wait_closed(parts.port)


def test_close_and_slow_connections_bounded(preview):
    preview.create("摄像头 A")
    listener = preview._listeners[ADDRESSES[0]]
    port = listener.server.server_port
    sockets = []
    try:
        for _ in range(12):
            connection = socket.create_connection(("127.0.0.1", port), timeout=2)
            connection.sendall(b"GET /preview/")
            sockets.append(connection)
        time.sleep(0.1)
        assert listener.server.slots._value == 0
        preview.close()
        wait_closed(port)
        assert not listener.thread.is_alive()
        deadline = time.monotonic() + 3
        while listener.server.slots._value < 8 and time.monotonic() < deadline:
            time.sleep(0.05)
        assert listener.server.slots._value == 8
    finally:
        for connection in sockets:
            connection.close()
    assert not preview._sessions


def test_bind_failure_and_qr_failure_cleanup(preview, monkeypatch):
    def fail(*args, **kwargs):
        raise OSError("端口不可用")
    with monkeypatch.context() as patch:
        patch.setattr(mobile, "_HTTPServer", fail)
        with pytest.raises(HTTPException) as error:
            preview.create("摄像头 A")
        assert error.value.status_code == 503
    with monkeypatch.context() as patch:
        patch.setattr(mobile.qrcode, "make", fail)
        with pytest.raises(OSError):
            preview.create("摄像头 A")
    assert not preview._listeners and not preview._sessions


def test_selected_interface_binding_and_cross_interface_credentials(preview):
    if ADDRESSES[0] == ADDRESSES[1]:
        pytest.skip("无第二个本机 IPv4 网卡")
    first = preview.create("摄像头 A", ADDRESSES[0])
    a = decode(first)
    assert preview._listeners[ADDRESSES[0]].server.server_address == (ADDRESSES[0], a.port)
    # 同一个端口不能从未选择的网卡建立连接。
    with socket.socket() as connection:
        connection.settimeout(0.5)
        assert connection.connect_ex((ADDRESSES[1], a.port)) != 0
    second = preview.create("摄像头 B", ADDRESSES[1])
    b = decode(second)
    assert preview._listeners[ADDRESSES[1]].server.server_address == (ADDRESSES[1], b.port)
    with lan(second)[0] as client:
        assert client.get(a.path).status_code == 410
        assert client.get(a.path + "/frame.jpg", headers=auth(a)).status_code == 410
        assert client.get(b.path + "/frame.jpg", headers=auth(b)).content == b"source-b"
        preview.revoke(first["id"])
        wait_closed(a.port, a.hostname)
        assert client.get(b.path + "/frame.jpg", headers=auth(b)).status_code == 200
    preview.revoke(second["id"])
    wait_closed(b.port, b.hostname)
    assert not preview._listeners


def test_close_and_reopen_keeps_new_listener(preview):
    for _ in range(10):
        preview.create("摄像头 A")
        old = preview._listeners[ADDRESSES[0]]
        preview.close()
        replacement = preview.create("摄像头 A")
        with lan(replacement)[0] as client:
            parts = decode(replacement)
            assert client.get(parts.path + "/frame.jpg", headers=auth(parts)).status_code == 200
        assert not old.thread.is_alive()
        assert replacement["id"] in preview._sessions


def test_create_during_close_join_keeps_new_session(preview, monkeypatch):
    preview.create("摄像头 A")
    old = preview._listeners[ADDRESSES[0]]
    joining, resume = threading.Event(), threading.Event()
    original_join = old.thread.join

    def gated_join(timeout):
        joining.set()
        assert resume.wait(3)
        original_join(timeout)

    monkeypatch.setattr(old.thread, "join", gated_join)
    with ThreadPoolExecutor(max_workers=1) as pool:
        closing = pool.submit(preview.close)
        try:
            assert joining.wait(3)
            replacement = preview.create("摄像头 A")
            assert preview._listeners[ADDRESSES[0]] is not old
        finally:
            resume.set()
        closing.result(timeout=3)
    with lan(replacement)[0] as client:
        parts = decode(replacement)
        assert client.get(parts.path + "/frame.jpg", headers=auth(parts)).content == b"source-a"
    assert replacement["id"] in preview._sessions
    assert not old.thread.is_alive()


def test_list_restores_existing_qr_without_renewal_or_reissuing_credentials(api, preview):
    assert api.get("/boss/mobile-preview", headers={"X-Shiwu-Token": "wrong"}).status_code == 401
    assert api.get("/boss/mobile-preview").json() == []
    created = api.post("/boss/mobile-preview", json={"source": "摄像头 A"}).json()
    parts = decode(created)
    response = api.get("/boss/mobile-preview")
    assert_headers(response)
    assert response.json() == [{**created, "source": "摄像头 A"}]
    for _ in range(3):
        restored = api.get("/boss/mobile-preview").json()[0]
        assert restored["id"] == created["id"]
        assert restored["qr"] == created["qr"]
        assert restored["expires_at"] == created["expires_at"]
    # 即使管理客户端不再展示弹窗，手机仍通过原始凭据读取同一实例。
    with lan(created)[0] as client:
        assert client.get(parts.path + "/frame.jpg", headers=auth(parts)).content == b"source-a"
    assert len(preview._sessions) == 1
    api.delete("/boss/mobile-preview/" + created["id"])
    assert api.get("/boss/mobile-preview").json() == []
    wait_closed(parts.port, parts.hostname)


@pytest.mark.parametrize("reason", ["expiry", "stop", "replace"])
def test_list_never_restores_expired_or_invalid_source_sessions(preview, reason):
    result = preview.create("摄像头 A")
    parts = decode(result)
    if reason == "expiry":
        preview._sessions[result["id"]].deadline = time.monotonic() - 1
    elif reason == "stop":
        preview.runtime.runners["摄像头 A"].pipeline.stop()
    else:
        preview.runtime.runners["摄像头 A"] = runner()
    assert preview.sessions() == []
    wait_closed(parts.port, parts.hostname)


def test_disconnect_source_revokes_all_concurrent_sessions_and_preserves_other_source(api, preview):
    with ThreadPoolExecutor(max_workers=2) as pool:
        created = list(pool.map(lambda _: preview.create("摄像头 A"), range(2)))
    other = preview.create("摄像头 B")
    assert len(preview.sessions()) == 3
    for headers in ({"X-Shiwu-Token": "wrong"},):
        assert api.delete("/boss/mobile-preview", params={"source": "摄像头 A"}, headers=headers).status_code == 401
    response = api.delete("/boss/mobile-preview", params={"source": "摄像头 A"})
    assert response.json() == {"success": True}
    assert_headers(response)
    for result in created:
        parts = decode(result)
        assert preview.frame(result["id"], auth(parts)["Authorization"], result["address"])[0] == 410
    assert [s["id"] for s in preview.sessions()] == [other["id"]]
    with lan(other)[0] as client:
        parts = decode(other)
        assert client.get(parts.path + "/frame.jpg", headers=auth(parts)).content == b"source-b"
    assert api.delete("/boss/mobile-preview", params={"source": "摄像头 A"}).status_code == 200
    assert api.delete("/boss/mobile-preview").status_code == 422
    assert api.delete("/boss/mobile-preview", params={"source": ""}).status_code == 422


def test_list_not_exposed_by_lan_listener(preview):
    created = preview.create("摄像头 A")
    with lan(created)[0] as client:
        assert client.get("/boss/mobile-preview", headers=auth(decode(created))).status_code == 404


def test_local_interface_enumeration_is_private():
    # 使用实际系统接口；允许离线机器返回空列表，不依赖联网或固定网卡。
    for address in mobile.local_private_ipv4():
        import ipaddress
        assert any(ipaddress.IPv4Address(address) in network for network in mobile._PRIVATE_NETWORKS)
