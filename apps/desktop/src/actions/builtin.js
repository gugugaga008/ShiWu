// 内置动作插件。每个插件：{ type, label, platforms, async run(params, ctx) → {ok, message} }
// ctx: { sys:{which,run,platform,env}, ui:{notify,toast,playSound,showCover,ownPids}, event }
'use strict'
const { ps, osa, linuxSession, PLATFORM_LABEL } = require('./sys')
const { minimizeWindows } = require('./windows')

const ok = (message) => ({ ok: true, message })
const fail = (message) => ({ ok: false, message })
const unsupported = (label, platform) =>
  fail(`当前平台（${PLATFORM_LABEL[platform] || platform}）暂不支持「${label}」`)

function needX11(sys, label) {
  const s = linuxSession(sys.env)
  if (s === 'wayland') return fail(`Wayland 会话不允许程序操作其它窗口，「${label}」仅支持 X11`)
  if (s === 'none') return fail(`未检测到图形会话（DISPLAY 为空），无法执行「${label}」`)
  return null
}
const missing = (tools, label) => fail(`未找到 ${tools.join(' / ')}，无法执行「${label}」，请先安装（如 sudo apt install ${tools[0]}）`)
const res = (r, okMsg) => (r.ok ? ok(okMsg) : fail(`${okMsg}失败：${(r.stderr || r.stdout).trim().slice(0, 200)}`))

const who = (ev) => (ev?.name ? `${ev.name}${ev.role_label ? `（${ev.role_label}）` : ''}` : '有人')

const notify = {
  type: 'notify', label: '系统通知', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    const title = params.title || '老板来了！'
    const body = params.body || `${who(ctx.event)} 出现在镜头前`
    const sysShown = await Promise.resolve(ctx.ui.notify(title, body))
    // 系统通知可能静默失败（macOS 未授权、Linux 无通知服务）：应用浮窗兜底，保证用户能看见
    const daemon = ctx.ui.hasNotifyDaemon ? await ctx.ui.hasNotifyDaemon() : true
    const needToast = params.toast ?? (!sysShown || ctx.sys.platform === 'darwin' || (ctx.sys.platform === 'linux' && !daemon))
    if (needToast) ctx.ui.toast(title, body)
    return ok(sysShown ? (needToast ? '系统通知 + 应用浮窗' : '系统通知') : '系统通知不可用，已用应用浮窗')
  },
}

const sound = {
  type: 'sound', label: '声音提醒', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    const file = params.file || 'Classic_Beep.wav'
    await ctx.ui.playSound(file, params.volume ?? 1)
    return ok(`播放 ${file}`)
  },
}

const cover = {
  type: 'cover', label: '全屏遮挡（假装工作）', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    ctx.ui.showCover(params.style || 'spreadsheet')
    return ok(`已遮挡（${ctx.ui.unlockAccelerator || '快捷键'} 解除）`)
  },
}

const minimizeAll = {
  type: 'minimize_all', label: '最小化所有窗口', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    const { sys } = ctx
    if (sys.platform === 'linux') {
      const bad = needX11(sys, this.label)
      if (bad) return bad
      if (!sys.which('xdotool') && !sys.which('wmctrl')) return missing(['xdotool', 'wmctrl'], this.label)
    }
    ctx.ui.minimizeOwn?.() // 管理界面里有摄像头画面，也收起来
    // 记录被收起的窗口，触发人离开后可自动恢复
    const rec = await minimizeWindows(sys, ctx.ui.ownPids?.() || [])
    if (rec.ok) ctx.ui.rememberWindows?.(ctx.event?.id, { ...rec, platform: sys.platform })
    return rec.ok ? ok(rec.message) : fail(`${this.label}失败：${rec.message}`)
  },
}

const focusApp = {
  type: 'focus_app', label: '切换到指定程序', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    const { sys } = ctx
    const name = String(params.app || '').trim()
    if (!name) return fail('未配置目标程序（params.app，如 "Visual Studio Code" / "Excel"）')
    if (/["'`$\\]/.test(name)) return fail('程序名包含非法字符')
    if (sys.platform === 'win32')
      return res(await ps(`if(-not (New-Object -ComObject WScript.Shell).AppActivate('${name}')){exit 1}`, sys), `切换到 ${name}`)
    if (sys.platform === 'darwin') return res(await osa(`tell application "${name}" to activate`, sys), `切换到 ${name}`)
    if (sys.platform === 'linux') {
      const bad = needX11(sys, this.label)
      if (bad) return bad
      if (sys.which('wmctrl')) return res(await sys.run('wmctrl', ['-a', name]), `切换到 ${name}`)
      if (sys.which('xdotool')) {
        const r = await sys.run('xdotool', ['search', '--onlyvisible', '--name', name])
        const id = r.stdout.split(/\s+/).filter(Boolean)[0]
        if (!id) return fail(`没找到标题含「${name}」的窗口`)
        return res(await sys.run('xdotool', ['windowactivate', id]), `切换到 ${name}`)
      }
      return missing(['wmctrl', 'xdotool'], this.label)
    }
    return unsupported(this.label, sys.platform)
  },
}

const mute = {
  type: 'mute', label: '静音', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    const { sys } = ctx
    if (sys.platform === 'win32') {
      if (sys.which('nircmd')) return res(await sys.run('nircmd', ['mutesysvolume', '1']), '静音（nircmd）')
      // 无 nircmd：发送媒体键 VolumeMute（切换式，已静音时会取消静音）
      return res(await ps('(New-Object -ComObject WScript.Shell).SendKeys([char]173)', sys), '静音（媒体键，切换式）')
    }
    if (sys.platform === 'darwin') return res(await osa('set volume with output muted', sys), '静音')
    if (sys.platform === 'linux') {
      if (sys.which('pactl')) return res(await sys.run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '1']), '静音（pactl）')
      if (sys.which('amixer')) return res(await sys.run('amixer', ['-q', 'set', 'Master', 'mute']), '静音（amixer）')
      return missing(['pactl', 'amixer'], this.label)
    }
    return unsupported(this.label, sys.platform)
  },
}

const lockScreen = {
  type: 'lock_screen', label: '锁屏', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    const { sys } = ctx
    if (sys.platform === 'win32') return res(await sys.run('rundll32.exe', ['user32.dll,LockWorkStation']), '锁屏')
    if (sys.platform === 'darwin') {
      const r = await osa('tell application "System Events" to keystroke "q" using {control down, command down}', sys)
      if (r.ok) return ok('锁屏')
      const r2 = await sys.run('/usr/bin/pmset', ['displaysleepnow'])
      if (r2.ok) return ok('锁屏（显示器休眠）')
      const r3 = await sys.run('/usr/bin/open', ['-a', 'ScreenSaverEngine'])
      if (r3.ok) return ok('锁屏（屏保）')
      return fail('锁屏失败：需要在「系统设置 → 隐私与安全 → 辅助功能」中授权识务')
    }
    if (sys.platform === 'linux') {
      for (const [cmd, args] of [['loginctl', ['lock-session']], ['xdg-screensaver', ['lock']], ['dm-tool', ['lock']]]) {
        if (!sys.which(cmd)) continue
        const r = await sys.run(cmd, args)
        if (r.ok) return ok(`锁屏（${cmd}）`)
      }
      return fail('锁屏失败：loginctl / xdg-screensaver / dm-tool 均不可用（无登录会话或未安装）')
    }
    return unsupported(this.label, sys.platform)
  },
}

const command = {
  type: 'command', label: '运行自定义命令', platforms: ['win32', 'darwin', 'linux'],
  async run(params, ctx) {
    const cmd = String(params.cmd || '').trim()
    if (!cmd) return fail('未配置命令（params.cmd）')
    if (ctx.settings && ctx.settings.allowCustomCommand === false) return fail('已在桌面端设置中禁用自定义命令')
    const shell = ctx.sys.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const args = ctx.sys.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd]
    const r = await ctx.sys.run(shell, args, { timeout: (params.timeout_s ?? 30) * 1000 })
    return r.ok ? ok(`命令退出码 0${r.stdout ? `：${r.stdout.trim().slice(0, 120)}` : ''}`) : fail(`命令失败（${r.code}）：${r.stderr.trim().slice(0, 200)}`)
  },
}

// 邮件由服务端发送（需要快照与 SMTP 授权码，都只在服务端解密）；桌面端只记一笔
const email = { type: 'email', label: '发送邮件（带快照）', platforms: ['win32', 'darwin', 'linux'], async run() { return ok('由识别服务发送') } }

const log = { type: 'log', label: '仅记录', platforms: ['win32', 'darwin', 'linux'], async run() { return ok('已记录') } }

module.exports = [notify, sound, cover, minimizeAll, focusApp, mute, lockScreen, command, email, log]
