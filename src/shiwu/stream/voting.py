"""轨迹级身份投票。

规则：
- 「可靠命中」= 单帧识别出 person 且 similarity >= min_sim。
- 一条轨迹累计到 >= min_hits 次可靠命中后，整条轨迹（包括之前/之后的帧）都打上该身份。
- 冲突（同一轨迹命中多个身份）：命中次数多者胜；平票按相似度总和。
- 同一帧里两条轨迹被投成同一人时，只保留证据最强的那条，其余退回单帧结果，避免一人分身。
- 单帧结果保留在 frame_person_id / frame_similarity 字段，供调试。
- track_id < 0（追踪器未确认的检测）不参与投票。
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class _TrackState:
    votes: Dict[str, List[float]] = field(default_factory=lambda: defaultdict(list))
    last_seen: float = 0.0
    first_seen: float = -1.0
    frames: int = 0
    decided: Optional[str] = None

    def decision(self, min_hits: int):
        best, key = None, None
        for pid, sims in self.votes.items():
            if len(sims) < min_hits:
                continue
            k = (len(sims), sum(sims))
            if key is None or k > key:
                best, key = pid, k
        return best


class TrackVoter:
    def __init__(self, min_sim: float = 0.5, min_hits: int = 1, forget_after_s: float = 10.0):
        self.min_sim, self.min_hits, self.forget_after_s = min_sim, min_hits, forget_after_s
        self.tracks: Dict[int, _TrackState] = {}
        self.changes: List[Dict] = []   # 本次 update 中身份新确定/改变的轨迹（供回填历史帧）

    def reset(self) -> None:
        self.tracks.clear()

    def update(self, faces: List[Dict], now: float) -> List[Dict]:
        """原地给 faces 补字段并返回：person_id/similarity 变为轨迹决策结果。"""
        self.changes = []
        for f in faces:
            f["frame_person_id"] = f.get("person_id")
            f["frame_similarity"] = float(f.get("similarity") or 0.0)
            tid = f.get("track_id", -1)
            if tid is None or tid < 0:
                f["identity_source"] = "frame" if f["frame_person_id"] else "none"
                continue
            st = self.tracks.setdefault(tid, _TrackState())
            st.last_seen, st.frames = now, st.frames + 1
            if st.first_seen < 0:
                st.first_seen = now
            if f["frame_person_id"] and f["frame_similarity"] >= self.min_sim:
                st.votes[f["frame_person_id"]].append(f["frame_similarity"])
            pid = st.decision(self.min_hits)
            if pid != st.decided:
                self.changes.append({"track_id": tid, "person_id": pid, "previous": st.decided,
                                     "first_seen": st.first_seen, "frames_so_far": st.frames,
                                     "votes": {k: len(v) for k, v in st.votes.items()}})
                st.decided = pid
            if pid is None:
                # 轨迹还没有可靠身份：低于 min_sim 的单帧命中也不采信，保守处理
                f["person_id"] = None
                f["identity_source"] = "none"
                f["similarity"] = f["frame_similarity"]
            else:
                sims = st.votes[pid]
                f["person_id"] = pid
                f["similarity"] = max(sims)
                f["identity_source"] = "frame" if f["frame_person_id"] == pid else "track"
            f["track_votes"] = {k: len(v) for k, v in st.votes.items()}

        # 一帧内同一身份只能出现一次
        by_pid: Dict[str, List[Dict]] = defaultdict(list)
        for f in faces:
            if f.get("person_id"):
                by_pid[f["person_id"]].append(f)
        for pid, fs in by_pid.items():
            if len(fs) < 2:
                continue
            def strength(f):
                return (f["frame_person_id"] == pid, f.get("track_votes", {}).get(pid, 0),
                        f["frame_similarity"])
            fs.sort(key=strength, reverse=True)
            for f in fs[1:]:
                f["person_id"] = None
                f["similarity"] = f["frame_similarity"]
                f["identity_source"] = "suppressed_duplicate"

        for tid in [t for t, s in self.tracks.items() if now - s.last_seen > self.forget_after_s]:
            del self.tracks[tid]
        return faces
