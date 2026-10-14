"""采集姓名/分组契约回归测试；模型与持久化桥隔离，不访问用户数据。"""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture
def capture_api(monkeypatch, tmp_path):
    # 全局 runtime 首次导入也只允许打开临时目录。
    monkeypatch.setenv("SHIWU_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("SHIWU_GALLERY_DIR", str(tmp_path / "gallery"))
    monkeypatch.setenv("SHIWU_MACHINE_KEY", "11" * 32)
    from shiwu.api.boss import routes
    from shiwu.api.boss.capture import CaptureConfig, CaptureSession, Cluster, Sample

    session = CaptureSession(None, "file", "test.mp4", CaptureConfig())
    session.status = "ready"
    session.clusters[1] = Cluster(1, [1])
    session.samples[1] = Sample(1, 1, 0.0, 1, {"x": 40, "y": 40, "width": 100, "height": 100},
                                [[65, 70], [115, 70], [90, 95], [70, 115], [110, 115]],
                                0.99, np.array([1, 0], dtype=np.float32), True, {"width": 100}, [])
    session.frame_shapes[1] = (200, 200, 3)
    monkeypatch.setattr(session, "frame_image", lambda _: np.zeros((200, 200, 3), dtype=np.uint8))
    member = {"person_id": "p1", "name": "张三", "role": "staff", "group_id": "existing-group",
              "has_face_data": False}
    members = {"p1": member}
    runtime = SimpleNamespace(captures={session.id: session}, members=Mock(return_value=members),
                              gallery=SimpleNamespace(add=Mock(), count=Mock(return_value={})),
                              name_of=lambda pid: members[pid]["name"], invalidate_people=Mock(),
                              save_portrait=Mock())
    monkeypatch.setattr(routes, "runtime", runtime)

    async def create(name, gid, role):
        m = {"person_id": f"new-person-{len(members)}", "name": name, "role": role, "group_id": gid,
             "has_face_data": False}
        members[m["person_id"]] = m
        return m

    async def update(pid, body):
        members[pid].update(body)
        return members[pid]

    create_member = AsyncMock(side_effect=create)
    update_member = AsyncMock(side_effect=update)
    group = AsyncMock(return_value="default-group")
    primary = AsyncMock(return_value=True)
    monkeypatch.setattr(routes.bridge, "create_member", create_member)
    monkeypatch.setattr(routes.bridge, "update_member", update_member)
    monkeypatch.setattr(routes, "_group_id", group)
    monkeypatch.setattr(routes, "_enroll_primary", primary)
    app = FastAPI()
    app.include_router(routes.router)
    with TestClient(app) as client:
        yield SimpleNamespace(client=client, url=f"/boss/captures/{session.id}/clusters/1/confirm",
                              session=session, runtime=runtime, member=member,
                              create=create_member, update=update_member, group=group, primary=primary)


@pytest.mark.parametrize("body", [{"role": "boss"}, {"name": ""}, {"name": "  \t "}, {"name": None}])
def test_new_capture_requires_independent_nonblank_name(capture_api, body):
    api = capture_api
    response = api.client.post(api.url, json=body)
    assert response.status_code in (400, 422)
    assert api.session.clusters[1].status == "pending"
    api.create.assert_not_awaited()
    api.group.assert_not_awaited()
    api.primary.assert_not_awaited()
    api.runtime.gallery.add.assert_not_called()


def test_new_people_in_same_group_have_distinct_names(capture_api):
    api = capture_api
    response = api.client.post(api.url, json={"name": "  王五  ", "role": "boss"})
    assert response.status_code == 200
    assert response.json()["name"] == "王五"
    assert response.json()["role"] == "boss"
    api.create.assert_awaited_once_with("王五", "default-group", "boss")
    assert api.runtime.gallery.add.call_args.kwargs["name"] == "王五"
    assert api.client.get(f"/boss/captures/{api.session.id}").json()["clusters"][0]["name"] == "王五"
    second = api.client.post("/boss/people", json={"name": "李四", "role": "boss"})
    assert second.status_code == 200
    assert second.json()["name"] == "李四" and second.json()["role"] == "boss"
    assert second.json()["person_id"] != response.json()["person_id"]
    assert second.json()["group_id"] == "default-group"


def test_new_capture_keeps_legacy_default_role_but_not_default_name(capture_api):
    api = capture_api
    response = api.client.post(api.url, json={"name": "李四"})
    assert response.status_code == 200
    assert response.json()["name"] == "李四" and response.json()["role"] == "boss"


def test_attach_keeps_identity_group_and_primary_membership(capture_api):
    api = capture_api
    response = api.client.post(api.url, json={"person_id": "p1"})
    assert response.status_code == 200
    result = response.json()
    assert (result["person_id"], result["name"], result["role"]) == ("p1", "张三", "staff")
    api.update.assert_not_awaited()
    api.create.assert_not_awaited()
    api.group.assert_not_awaited()
    assert api.primary.await_args.args[:2] == ("existing-group", "p1")
    assert api.runtime.gallery.add.call_args.args[0] == "p1"
    assert api.runtime.gallery.add.call_args.kwargs["name"] == "张三"


def test_attach_with_explicit_role_only_does_not_rename(capture_api):
    api = capture_api
    response = api.client.post(api.url, json={"person_id": "p1", "role": "leader"})
    assert response.status_code == 200
    assert response.json()["name"] == "张三"
    assert response.json()["role"] == "leader"
    api.update.assert_awaited_once_with("p1", {"role": "leader"})


def test_explicit_identity_updates_remain_api_compatible(capture_api):
    api = capture_api
    response = api.client.post(api.url, json={"person_id": "p1", "name": " 王总 ", "role": "boss"})
    assert response.status_code == 200
    assert response.json()["name"] == "王总" and response.json()["role"] == "boss"
    api.update.assert_awaited_once_with("p1", {"name": "王总", "role": "boss"})
    assert api.runtime.gallery.add.call_args.kwargs["name"] == "王总"


def test_attach_without_stored_name_cannot_fall_back_to_group(capture_api):
    api = capture_api
    api.member.update(name="  ", role="boss")
    response = api.client.post(api.url, json={"person_id": "p1"})
    assert response.status_code == 400
    api.update.assert_not_awaited()
    api.primary.assert_not_awaited()
    api.runtime.gallery.add.assert_not_called()


def test_attach_missing_member_does_not_create_or_enroll(capture_api):
    api = capture_api
    assert api.client.post(api.url, json={"person_id": "missing"}).status_code == 404
    api.create.assert_not_awaited()
    api.primary.assert_not_awaited()


def test_quality_rejection_does_not_update_identity_or_enroll(capture_api):
    api = capture_api
    api.session.samples[1].bbox["width"] = 20
    response = api.client.post(api.url, json={"person_id": "p1", "name": "新姓名", "role": "boss"})
    assert response.status_code == 400
    assert "质量门槛" in response.json()["detail"]["message"]
    assert api.member["name"] == "张三" and api.member["role"] == "staff"
    api.update.assert_not_awaited()
    api.primary.assert_not_awaited()
    api.runtime.gallery.add.assert_not_called()


def test_ignore_does_not_require_name_or_mutate_person(capture_api):
    api = capture_api
    response = api.client.post(api.url, json={"action": "ignore"})
    assert response.status_code == 200 and response.json()["status"] == "ignored"
    api.create.assert_not_awaited()
    api.update.assert_not_awaited()
    api.runtime.gallery.add.assert_not_called()


@pytest.mark.parametrize("endpoint,method", [("/boss/people", "post"), ("/boss/people/p1", "put")])
def test_people_reject_whitespace_names(capture_api, endpoint, method):
    api = capture_api
    assert getattr(api.client, method)(endpoint, json={"name": " \t "}).status_code == 422
    api.create.assert_not_awaited()
    api.update.assert_not_awaited()


def test_people_name_update_trims_without_changing_role(capture_api):
    api = capture_api
    response = api.client.put("/boss/people/p1", json={"name": " 李四 "})
    assert response.status_code == 200
    assert response.json()["name"] == "李四" and response.json()["role"] == "staff"
    api.update.assert_awaited_once_with("p1", {"name": "李四"})
