"""临时只读 LAN 预览：独立监听、单源短凭据，不复用主 API 或主 token。"""
from __future__ import annotations

import base64
import ctypes
import hmac
import io
import ipaddress
import logging
import re
import secrets
import socket
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import qrcode
from fastapi import HTTPException
from qrcode.image.pil import PilImage

logger = logging.getLogger(__name__)
_PRIVATE_NETWORKS = tuple(ipaddress.IPv4Network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
_LAN_PREF = ipaddress.IPv4Network("192.168.0.0/16")
_VIRTUAL_IFACE_PREFIXES = (
    "utun", "awdl", "llw", "bridge", "docker", "veth", "cni", "virbr", "vmnet", "vnic")
_PATH = re.compile(r"/preview/([a-f0-9]{24})(/frame\.jpg)?\Z")


def _virtual_iface(name: str) -> bool:
    n = (name or "").lower()
    return any(n.startswith(p) for p in _VIRTUAL_IFACE_PREFIXES)


def _private_ipv4_key(addr: str):
    ip = ipaddress.IPv4Address(addr)
    return (0 if ip in _LAN_PREF else 1, ip)


def local_private_ipv4() -> list[str]:
    """枚举本机已启用接口，只接受 RFC1918 IPv4；不做 DNS 或外网探测。
    优先 192.168/16，并跳过明显虚拟网卡（VPN/Docker 等）。"""
    addresses: dict[str, str] = {}
    if sys.platform == "win32":
        # GetIpAddrTable 的 MIB_IPADDRROW 固定为六个 DWORD（24 字节）。
        size = ctypes.c_ulong(0)
        get_table = ctypes.windll.iphlpapi.GetIpAddrTable
        result = get_table(None, ctypes.byref(size), False)
        if result != 122:  # ERROR_INSUFFICIENT_BUFFER
            raise OSError(result, "无法枚举网络接口")
        buffer = ctypes.create_string_buffer(size.value)
        result = get_table(buffer, ctypes.byref(size), False)
        if result:
            raise OSError(result, "无法枚举网络接口")
        count = ctypes.c_ulong.from_buffer(buffer).value
        for i in range(count):
            # wType 的 DISCONNECTED/DELETED/TRANSIENT 标志不用于可扫描地址。
            row = buffer.raw[4 + i * 24:4 + (i + 1) * 24]
            flags = int.from_bytes(row[22:24], "little")
            if not flags & (8 | 64 | 128):
                addresses.setdefault(socket.inet_ntoa(row[:4]), "")
    else:
        class IfAddrs(ctypes.Structure):
            pass

        IfAddrs._fields_ = [
            ("next", ctypes.POINTER(IfAddrs)), ("name", ctypes.c_char_p),
            ("flags", ctypes.c_uint), ("addr", ctypes.c_void_p),
            ("netmask", ctypes.c_void_p), ("other", ctypes.c_void_p),
            ("data", ctypes.c_void_p),
        ]
        libc = ctypes.CDLL(None, use_errno=True)
        libc.getifaddrs.argtypes = [ctypes.POINTER(ctypes.POINTER(IfAddrs))]
        libc.getifaddrs.restype = ctypes.c_int
        libc.freeifaddrs.argtypes = [ctypes.POINTER(IfAddrs)]
        head = ctypes.POINTER(IfAddrs)()
        if libc.getifaddrs(ctypes.byref(head)):
            raise OSError(ctypes.get_errno(), "无法枚举网络接口")
        try:
            cursor = head
            while cursor:
                item = cursor.contents
                if item.addr and item.flags & 1:  # IFF_UP
                    raw = ctypes.string_at(item.addr, 8)
                    family = raw[1] if sys.platform == "darwin" else int.from_bytes(raw[:2], sys.byteorder)
                    if family == socket.AF_INET:
                        ifname = ""
                        if item.name:
                            ifname = (item.name.decode("utf-8", "replace")
                                      if isinstance(item.name, bytes) else str(item.name))
                        if not _virtual_iface(ifname):
                            addresses.setdefault(socket.inet_ntoa(raw[4:8]), ifname)
                cursor = item.next
        finally:
            libc.freeifaddrs(head)
    return sorted((a for a in addresses if any(ipaddress.IPv4Address(a) in n for n in _PRIVATE_NETWORKS)),
                  key=_private_ipv4_key)


_STYLE = """
body{background:#111827;color:#f9fafb;font-family:system-ui,sans-serif;margin:0;padding:16px;text-align:center}
img{display:block;max-width:100%;max-height:80vh;margin:auto}img[hidden]{display:none}
#status{padding:16px}h1{font-size:20px}
"""
_SCRIPT = """
'use strict';
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const image = document.getElementById('frame');
const status = document.getElementById('status');
const expiresAt = Number(document.body.dataset.expiresAt) * 1000;
let objectURL = null, ended = false, controller = null;
function clearFrame(message) {
  image.hidden = true;
  image.removeAttribute('src');
  if (objectURL) URL.revokeObjectURL(objectURL);
  objectURL = null;
  status.textContent = message;
}
function end(message) {
  ended = true;
  if (controller) controller.abort();
  clearFrame(message);
}
image.onerror = () => clearFrame('暂无画面，等待下一帧');
const expiryTimer = setTimeout(() => end('预览已过期，请在电脑重新扫码'), Math.max(0, expiresAt - Date.now()));
async function poll() {
  if (ended) return;
  if (!token) { end('缺少预览凭据，请重新扫码'); return; }
  if (document.hidden) { clearFrame('页面已暂停'); setTimeout(poll, 1000); return; }
  controller = new AbortController();
  let nextPoll = 1000;
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(location.pathname + '/frame.jpg', {
      headers: {Authorization: 'Bearer ' + token}, cache: 'no-store',
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal
    });
    if (ended) return;
    if (response.status === 401) { end('预览凭据无效，请重新扫码'); return; }
    if (response.status === 410) { end('预览已过期、撤销或画面源已结束'); return; }
    if (response.status === 204) { clearFrame('暂无画面，等待画面源'); }
    else if (response.ok) {
      const blob = await response.blob();
      if (ended || document.hidden) return;
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = URL.createObjectURL(blob);
      image.src = objectURL;
      image.hidden = false;
      nextPoll = 250;
      status.textContent = '实时预览（约每秒四帧）';
    } else { clearFrame('暂时无法获取画面'); }
  } catch (_) {
    if (!ended) clearFrame('连接断开，预览可能已过期、撤销或画面源已结束');
  } finally {
    clearTimeout(timeout);
    if (!ended) setTimeout(poll, nextPoll);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (controller) controller.abort(); clearFrame('页面已暂停'); }
});
window.addEventListener('pagehide', () => { clearTimeout(expiryTimer); end('预览已关闭'); });
poll();
"""
_PAGE = ("<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
         "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
         "<title>识务 · 手机预览</title><style>" + _STYLE + "</style></head>"
         '<body data-expires-at="__EXPIRES_AT__"><h1>识务 · 手机预览</h1>'
         '<p id="status" role="status">正在连接预览…</p><img id="frame" alt="视频画面" hidden>'
         "<script>" + _SCRIPT + "</script></body></html>")


def _hash(text: str) -> str:
    import hashlib
    return base64.b64encode(hashlib.sha256(text.encode()).digest()).decode()


SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'none'; "
        f"script-src 'sha256-{_hash(_SCRIPT)}'; style-src 'sha256-{_hash(_STYLE)}'; "
        "connect-src 'self'; img-src blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
}


@dataclass(repr=False)
class _Session:
    id: str
    token: str
    source: str
    address: str
    runner: Any
    pipeline: Any
    started_at: float | None
    expires_at: float
    deadline: float
    ttl_s: float = 600.0
    qr: str = ""


class _HTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    allow_reuse_address = False
    request_queue_size = 8

    def __init__(self, manager: "MobilePreview", address: str):
        self.manager = manager
        self.slots = threading.BoundedSemaphore(8)
        super().__init__((address, 0), _Handler)
        self.timeout = 0.2

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        request.settimeout(2.0)
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        # 绝对连接期限同时限制慢速逐字节请求和阻塞写入，而非仅空闲超时。
        def disconnect():
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # 客户端已关闭连接

        timer = threading.Timer(5.0, disconnect)
        timer.daemon = True
        timer.start()
        try:
            super().process_request_thread(request, client_address)
        finally:
            timer.cancel()
            self.slots.release()

    def handle_error(self, request, client_address):
        # 不输出请求、Authorization 或异常局部变量，避免泄漏短凭据。
        logger.warning("手机预览连接处理失败")


class _Handler(BaseHTTPRequestHandler):
    server_version = "ShiwuPreview"
    sys_version = ""

    def log_message(self, format, *args):
        pass  # LAN 请求不记访问日志（包括恶意 query 中的凭据）

    def send_error(self, code, message=None, explain=None):
        self._reply(code, "请求无效".encode(), "text/plain; charset=utf-8")

    def _reply(self, code: int, body: bytes = b"", content_type: str = "text/plain; charset=utf-8"):
        self.close_connection = True
        self.send_response(code)
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def do_GET(self):
        match = _PATH.fullmatch(self.path)
        if not match:
            self._reply(404, "页面不存在".encode())
            return
        sid, frame = match.groups()
        manager = self.server.manager
        if frame:
            code, body = manager.frame(sid, self.headers.get("Authorization", ""), self.server.server_address[0])
            self._reply(code, body, "image/jpeg" if code == 200 else "text/plain; charset=utf-8")
        else:
            expires_at = manager.page_expiry(sid, self.server.server_address[0])
            if expires_at is None:
                self._reply(410, "预览已过期、撤销或画面源已结束".encode())
            else:
                self._reply(200, _PAGE.replace("__EXPIRES_AT__", str(expires_at)).encode(),
                            "text/html; charset=utf-8")


@dataclass
class _Listener:
    server: _HTTPServer
    stop: threading.Event = field(default_factory=threading.Event)
    thread: threading.Thread | None = None


class MobilePreview:
    TTL = 600.0
    MAX_SESSIONS = 8

    def __init__(self, runtime):
        self.runtime = runtime
        self._lock = threading.RLock()
        self._sessions: dict[str, _Session] = {}
        self._listeners: dict[str, _Listener] = {}

    @staticmethod
    def _running(runner) -> bool:
        pipeline = runner.pipeline
        return bool(pipeline and pipeline._thread and pipeline._thread.is_alive()
                    and not pipeline._stop.is_set())

    def _valid(self, session: _Session) -> bool:
        return (time.monotonic() < session.deadline and time.time() < session.expires_at
                and self.runtime.runners.get(session.source) is session.runner
                and session.runner.pipeline is session.pipeline
                and session.runner.started_at == session.started_at
                and self._running(session.runner))

    def _stop_locked(self, address: str):
        listener = self._listeners.pop(address, None)
        if listener:
            listener.stop.set()
            listener.server.server_close()
        return listener

    def _prune_locked(self):
        for sid, session in list(self._sessions.items()):
            if not self._valid(session):
                del self._sessions[sid]
        active_addresses = {session.address for session in self._sessions.values()}
        for address in list(self._listeners):
            if address not in active_addresses:
                self._stop_locked(address)

    def _serve(self, address: str, listener: _Listener):
        try:
            while not listener.stop.is_set():
                try:
                    listener.server.handle_request()
                except (OSError, ValueError):
                    if not listener.stop.is_set():
                        raise
                with self._lock:
                    if self._listeners.get(address) is listener:
                        self._prune_locked()
        finally:
            with self._lock:
                if self._listeners.get(address) is listener:
                    for sid, session in list(self._sessions.items()):
                        if session.address == address:
                            del self._sessions[sid]
                    self._stop_locked(address)
                listener.server.server_close()

    def create(self, source: str, address: str | None = None, ttl_s: float | None = None) -> dict:
        if ttl_s is not None:
            try:
                ttl = float(ttl_s)
            except (TypeError, ValueError):
                raise HTTPException(400, "预览有效期须在 60–3600 秒之间") from None
            if not 60 <= ttl <= 3600:
                raise HTTPException(400, "预览有效期须在 60–3600 秒之间")
        else:
            ttl = self.TTL
        try:
            addresses = local_private_ipv4()
        except (OSError, AttributeError):
            raise HTTPException(503, "无法获取本机局域网地址") from None
        if not addresses:
            raise HTTPException(503, "未找到可用的局域网 IPv4 地址，请连接 Wi-Fi 或有线网络")
        if address is not None and address not in addresses:
            raise HTTPException(400, "所选地址不是本机可用的私网 IPv4 地址")
        selected = address if address is not None else addresses[0]
        with self._lock:
            self._prune_locked()
            runner = self.runtime.runners.get(source)
            if runner is None or not self._running(runner):
                raise HTTPException(409, "画面源不存在或已停止，请先启动该画面源")
            if len(self._sessions) >= self.MAX_SESSIONS:
                raise HTTPException(429, "手机预览会话已达上限，请先断开已有手机预览")
            listener = self._listeners.get(selected)
            if listener is None:
                try:
                    listener = _Listener(_HTTPServer(self, selected))
                    self._listeners[selected] = listener
                except OSError:
                    raise HTTPException(503, "无法在所选网卡启动临时预览，请检查网络连接") from None
            session = _Session(secrets.token_hex(12), secrets.token_urlsafe(24), source, selected,
                               runner, runner.pipeline, runner.started_at,
                               time.time() + ttl, time.monotonic() + ttl, ttl)
            port = listener.server.server_port
            # 凭据只在 fragment 中；IP 列表不包含端口、路径或凭据。
            url = f"http://{selected}:{port}/preview/{session.id}#{session.token}"
            try:
                output = io.BytesIO()
                qrcode.make(url, image_factory=PilImage).save(output, format="PNG")
            except Exception:
                self._prune_locked()
                raise
            session.qr = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
            self._sessions[session.id] = session
            if listener.thread is None:
                listener.thread = threading.Thread(target=self._serve, args=(selected, listener),
                                                   daemon=True, name="mobile-preview")
                listener.thread.start()
            return {"id": session.id, "qr": session.qr,
                    "expires_at": session.expires_at, "addresses": addresses, "address": selected,
                    "ttl_s": ttl}

    def sessions(self) -> list[dict]:
        """管理端恢复现有二维码，不续期，也不重新签发手机凭据。"""
        try:
            addresses = local_private_ipv4()
        except (OSError, AttributeError):
            raise HTTPException(503, "无法获取本机局域网地址") from None
        with self._lock:
            self._prune_locked()
            return [{"id": s.id, "source": s.source, "qr": s.qr,
                     "expires_at": s.expires_at, "addresses": addresses, "address": s.address,
                     "ttl_s": s.ttl_s}
                    for s in self._sessions.values()]

    def revoke(self, sid: str) -> dict:
        with self._lock:
            self._sessions.pop(sid, None)
            self._prune_locked()
        # 幂等撤销，已过期或已停止的画面源无需报错。
        return {"success": True}

    def revoke_source(self, source: str) -> dict:
        """按画面源原子撤销，覆盖多标签页同时生成的所有二维码。"""
        with self._lock:
            for sid, session in list(self._sessions.items()):
                if session.source == source:
                    del self._sessions[sid]
            self._prune_locked()
        return {"success": True}

    def invalidate_runner(self, runner):
        with self._lock:
            for sid, session in list(self._sessions.items()):
                if session.runner is runner:
                    del self._sessions[sid]
            self._prune_locked()

    def page_expiry(self, sid: str, address: str) -> float | None:
        with self._lock:
            session = self._sessions.get(sid)
            expires_at = session.expires_at if session and session.address == address and self._valid(session) else None
            self._prune_locked()
            return expires_at

    def frame(self, sid: str, authorization: str, address: str) -> tuple[int, bytes]:
        with self._lock:
            session = self._sessions.get(sid)
            if not authorization.startswith("Bearer "):
                return 401, "缺少预览凭据".encode()
            if session and not hmac.compare_digest(authorization[7:].encode(), session.token.encode()):
                return 401, "预览凭据无效".encode()
            if session is None or session.address != address or not self._valid(session):
                self._prune_locked()
                return 410, "预览已过期、撤销或画面源已结束".encode()
            jpeg = session.runner.latest_jpeg
            return (200, jpeg) if jpeg else (204, b"")

    def close(self):
        with self._lock:
            self._sessions.clear()
            listeners = [self._stop_locked(address) for address in list(self._listeners)]
        for listener in listeners:
            if listener and listener.thread and listener.thread is not threading.current_thread():
                listener.thread.join(1.0)
