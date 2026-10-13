"""邮件通知：SMTP（SSL / STARTTLS / 明文）、限流、告警邮件构造（带快照附件）。"""
from __future__ import annotations

import smtplib
import ssl
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import List, Optional


@dataclass
class SmtpConfig:
    host: str = ""
    port: int = 465
    security: str = "ssl"          # ssl | starttls | none
    user: str = ""
    password: str = ""
    sender: str = ""
    recipients: List[str] = field(default_factory=list)
    timeout: float = 15.0
    verify_tls: bool = True

    @classmethod
    def from_settings(cls, s: dict, password: str = "") -> "SmtpConfig":
        to = s.get("smtp_to") or []
        if isinstance(to, str):
            to = [x.strip() for x in to.replace(";", ",").split(",") if x.strip()]
        return cls(host=s.get("smtp_host") or "", port=int(s.get("smtp_port") or 465),
                   security=s.get("smtp_security") or "ssl", user=s.get("smtp_user") or "",
                   password=password, sender=s.get("smtp_from") or s.get("smtp_user") or "",
                   recipients=list(to), verify_tls=bool(s.get("smtp_verify_tls", True)))

    def problems(self) -> List[str]:
        p = []
        if not self.host:
            p.append("未填写 SMTP 服务器")
        if not self.sender:
            p.append("未填写发件人")
        if not self.recipients:
            p.append("未填写收件人")
        if self.password and not self.password.isascii():
            p.append("授权码含非 ASCII 字符（请粘贴邮箱后台生成的授权码）")
        if self.security not in ("ssl", "starttls", "none"):
            p.append("加密方式无效")
        return p


class RateLimiter:
    """滑动窗口：每小时最多 per_hour 封，且两封间隔 ≥ min_interval_s。"""

    def __init__(self, per_hour: int = 6, min_interval_s: float = 60, clock=time.time):
        self.per_hour, self.min_interval_s, self.clock = per_hour, min_interval_s, clock
        self._sent: deque = deque()
        self._lock = threading.Lock()
        self.dropped = 0

    def allow(self) -> tuple:
        with self._lock:
            now = self.clock()
            while self._sent and now - self._sent[0] > 3600:
                self._sent.popleft()
            if self._sent and now - self._sent[-1] < self.min_interval_s:
                self.dropped += 1
                return False, f"限流：距上一封不足 {int(self.min_interval_s)} 秒"
            if self.per_hour and len(self._sent) >= self.per_hour:
                self.dropped += 1
                return False, f"限流：每小时最多 {self.per_hour} 封"
            self._sent.append(now)
            return True, ""


def build_alert_email(cfg: SmtpConfig, ev: dict, snapshot: Optional[bytes] = None,
                      role_label: Optional[str] = None) -> EmailMessage:
    t = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ev.get("ts") or time.time()))
    who = ev.get("name") or "未知人员"
    role = role_label or ev.get("role") or ("陌生人" if ev.get("stranger") else "")
    msg = EmailMessage()
    msg["Subject"] = f"【识务】{who}{f'（{role}）' if role else ''} {t}"
    msg["From"] = formataddr(("识务", cfg.sender))
    msg["To"] = ", ".join(cfg.recipients)
    msg["Message-ID"] = make_msgid(domain="shiwu.local")
    lines = [f"时间：{t}", f"人员：{who}", f"角色：{role or '-'}", f"规则：{ev.get('rule_id') or '-'}",
             f"视频源：{ev.get('source') or '-'}"]
    if ev.get("similarity"):
        lines.append(f"相似度：{ev['similarity']:.2f}")
    lines += ["", "（本邮件由「识务」在本机自动发送；快照见附件）" if snapshot else "（本邮件由「识务」在本机自动发送）"]
    msg.set_content("\n".join(lines))
    if snapshot:
        msg.add_attachment(snapshot, maintype="image", subtype="jpeg",
                           filename=f"snapshot_{time.strftime('%Y%m%d_%H%M%S', time.localtime(ev.get('ts') or time.time()))}.jpg")
    return msg


class Mailer:
    def __init__(self, smtp_factory=None):
        self._smtp_factory = smtp_factory  # 测试注入

    def send(self, cfg: SmtpConfig, msg: EmailMessage) -> str:
        bad = cfg.problems()
        if bad:
            raise ValueError("；".join(bad))
        ctx = ssl.create_default_context()
        if not cfg.verify_tls:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        if self._smtp_factory:
            s = self._smtp_factory(cfg)
        elif cfg.security == "ssl":
            s = smtplib.SMTP_SSL(cfg.host, cfg.port, timeout=cfg.timeout, context=ctx)
        else:
            s = smtplib.SMTP(cfg.host, cfg.port, timeout=cfg.timeout)
        try:
            s.ehlo()
            if cfg.security == "starttls" and not self._smtp_factory:
                s.starttls(context=ctx)
                s.ehlo()
            if cfg.user and cfg.password:
                if not self._smtp_factory and not s.has_extn("auth"):
                    raise RuntimeError("服务器未提供登录（AUTH），请检查端口与加密方式（QQ/163 等通常为 465 SSL 或 587 STARTTLS）")
                s.login(cfg.user, cfg.password)
            s.send_message(msg, from_addr=cfg.sender, to_addrs=cfg.recipients)
        finally:
            try:
                s.quit()
            except Exception:  # noqa: BLE001
                pass
        return f"已发送至 {', '.join(cfg.recipients)}"
