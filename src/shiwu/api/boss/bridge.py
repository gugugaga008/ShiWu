"""接口层与数据层之间的桥。

`/boss/*` 需要读成员、建组、注册人脸。这些能力原本由本进程的
`/attendance/*`、`/face/*` 提供，所以历史实现是用 httpx 反过来调自己的端口 ——
多一次本机 HTTP 往返，还得依赖端口号和会话 token。

现在两边在同一个进程里，直接调 repository / service。

- **同步函数**给识别管道线程用。管道跑在普通线程里，没有事件循环，不能 await。
- **异步函数**给 FastAPI 路由用。
"""
from __future__ import annotations

import logging
import sqlite3
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np

from ...database.repository import AttendanceRepository
from ...database.session import AsyncSessionLocal
from ...paths import DATA_DIR
from ...services.attendance_service import AttendanceService

logger = logging.getLogger(__name__)

_DB = DATA_DIR / "attendance.db"


def _joined_at_iso(value) -> Optional[str]:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.isoformat(timespec="seconds")
    text = str(value).strip()
    if " " in text and "T" not in text[:20]:
        text = text.replace(" ", "T", 1)
    return text or None


# ------------------------------------------------------------------ 同步侧
def members_snapshot() -> Dict[str, dict]:
    """管道线程用的成员快照，直接读库，不经过 HTTP。

    与 `AttendanceRepository.get_members()` 同一套过滤条件：未停用、未软删。
    """
    if not _DB.exists():
        return {}
    try:
        con = sqlite3.connect(f"file:{_DB}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as e:
        logger.warning("成员快照读取失败：%s", e)
        return {}
    try:
        rows = con.execute(
            "SELECT id, person_id, group_id, name, role, email, is_active, joined_at "
            "FROM attendance_members "
            "WHERE is_active = 1 AND (is_deleted IS NULL OR is_deleted = 0) "
            "ORDER BY name COLLATE NOCASE"
        ).fetchall()
        enrolled = {r[0] for r in con.execute("SELECT DISTINCT person_id FROM faces")}
    except sqlite3.Error as e:
        logger.warning("成员快照查询失败：%s", e)
        return {}
    finally:
        con.close()

    return {
        r[1]: {"id": r[0], "person_id": r[1], "group_id": r[2], "name": r[3],
               "role": r[4], "email": r[5], "is_active": bool(r[6]),
               "joined_at": _joined_at_iso(r[7]),
               "has_face_data": r[1] in enrolled, "remote_id": None}
        for r in rows
    }


# ------------------------------------------------------------------ 异步侧
def _member_dict(m, has_face_data: bool) -> dict:
    return {"id": m.id, "person_id": m.person_id, "group_id": m.group_id, "name": m.name,
            "role": m.role, "email": m.email, "joined_at": _joined_at_iso(m.joined_at),
            "is_active": m.is_active, "has_face_data": has_face_data,
            "remote_id": getattr(m, "remote_id", None)}


async def _enrolled_person_ids() -> set[str]:
    from ...core import lifespan

    if not lifespan.face_recognizer:
        return set()
    try:
        return set(await lifespan.face_recognizer.get_all_persons(None))
    except Exception as e:  # noqa: BLE001
        logger.debug("读已注册人脸集合失败：%s", e)
        return set()


async def list_members() -> List[dict]:
    async with AsyncSessionLocal() as session:
        repo = AttendanceRepository(session)
        members = await repo.get_members()
        enrolled = await _enrolled_person_ids()
        return [_member_dict(m, m.person_id in enrolled) for m in members]


async def get_group_id_by_name(name: str) -> Optional[str]:
    async with AsyncSessionLocal() as session:
        repo = AttendanceRepository(session)
        for g in await repo.get_groups(active_only=True):
            if g.name == name:
                return g.id
    return None


async def create_group(name: str) -> str:
    async with AsyncSessionLocal() as session:
        repo = AttendanceRepository(session)
        service = AttendanceService(repo)
        group_id = service.generate_id()
        await repo.create_group({"id": group_id, "name": name, "settings": {}})
        await repo.add_audit_log(action="GROUP_CREATED", target_type="group",
                                 target_id=group_id, details=f"Group '{name}' created")
        await session.commit()
    return group_id


async def ensure_group(name: str) -> str:
    """按名字取组，没有就建。"""
    existing = await get_group_id_by_name(name)
    return existing or await create_group(name)


async def create_member(name: str, group_id: str, role: Optional[str]) -> dict:
    async with AsyncSessionLocal() as session:
        repo = AttendanceRepository(session)
        if not await repo.get_group(group_id):
            raise LookupError("组不存在")
        person_id = await AttendanceService(repo).generate_person_id(name=name, group_id=group_id)
        member = await repo.add_member({"name": name, "group_id": group_id,
                                        "role": role, "person_id": person_id})
        await repo.add_audit_log(action="MEMBER_CREATED", target_type="member",
                                 target_id=person_id, details=f"Member '{name}' added")
        await session.commit()
        await session.refresh(member)
        return _member_dict(member, False)


async def update_member(person_id: str, fields: Dict[str, Any]) -> Optional[dict]:
    if not fields:
        return None
    async with AsyncSessionLocal() as session:
        repo = AttendanceRepository(session)
        if not await repo.get_member(person_id):
            return None
        if "group_id" in fields and not await repo.get_group(fields["group_id"]):
            raise LookupError("组不存在")
        member = await repo.update_member(person_id, fields)
        if member is None:
            return None
        await repo.add_audit_log(action="MEMBER_UPDATED", target_type="member",
                                 target_id=person_id,
                                 details=f"Fields updated: {', '.join(fields.keys())}")
        await session.commit()
        await session.refresh(member)
        return _member_dict(member, person_id in await _enrolled_person_ids())


async def delete_member(person_id: str) -> bool:
    async with AsyncSessionLocal() as session:
        repo = AttendanceRepository(session)
        ok = await repo.remove_member(person_id)
        if not ok:
            return False
        await repo.add_audit_log(action="MEMBER_DELETED", target_type="member",
                                 target_id=person_id)
        await session.commit()
    return True


async def enroll_primary_face(group_id: str, person_id: str,
                              image: np.ndarray, face: dict) -> bool:
    """把一张人脸写进识别库（成员的首张模板）。"""
    from ...core import lifespan

    if not lifespan.face_recognizer:
        logger.warning("识别模型未就绪，跳过主模板写入")
        return False
    async with AsyncSessionLocal() as session:
        repo = AttendanceRepository(session)
        service = AttendanceService(repo, face_recognizer=lifespan.face_recognizer)
        try:
            await service.enroll_member(group_id, person_id, image,
                                        face["bbox"], face["landmarks_5"])
            return True
        except Exception as e:  # noqa: BLE001
            logger.warning("主模板写入失败：%s", e)
            return False


async def remove_person_faces(person_id: str) -> bool:
    """删掉某人的全部人脸模板（硬删）。"""
    from ...core import lifespan

    if not lifespan.face_recognizer:
        return False
    try:
        result = await lifespan.face_recognizer.remove_person(person_id, None)
        return bool(result.get("success"))
    except Exception as e:  # noqa: BLE001
        logger.warning("删除人脸模板失败：%s", e)
        return False


async def person_has_faces(person_id: str) -> bool:
    return person_id in await _enrolled_person_ids()
