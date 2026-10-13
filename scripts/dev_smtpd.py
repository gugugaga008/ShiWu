"""本地开发用 SMTP 测试服务器（只监听 127.0.0.1，不转发任何邮件）：接受任意账号登录，邮件存为 .eml 文件。
用法：python scripts/dev_smtpd.py [端口=2525] [目录=/tmp/boss-mail]，然后在「设置 → 邮件通知」填 127.0.0.1 / 端口 / 不加密。"""
import sys
import time

from aiosmtpd.controller import Controller
import os
from aiosmtpd.smtp import AuthResult

port = int(sys.argv[1]) if len(sys.argv) > 1 else 2525
box = sys.argv[2] if len(sys.argv) > 2 else "/tmp/boss-mail"


class Handler:
    n = 0

    async def handle_DATA(self, server, session, envelope):
        os.makedirs(box, exist_ok=True)
        Handler.n += 1
        f = os.path.join(box, f"{time.strftime('%Y%m%d_%H%M%S')}_{Handler.n}.eml")
        with open(f, "wb") as fp:
            fp.write(envelope.content)
        print(f"[smtpd] {time.strftime('%H:%M:%S')} {envelope.mail_from} → {envelope.rcpt_tos} {len(envelope.content)} B → {f}", flush=True)
        return "250 OK"


ctl = Controller(Handler(), hostname="127.0.0.1", port=port, auth_require_tls=False,
                 authenticator=lambda *a: AuthResult(success=True))
ctl.start()
print(f"[smtpd] 127.0.0.1:{port} → {box}", flush=True)
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    ctl.stop()
