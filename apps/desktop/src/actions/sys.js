// 系统命令工具：跨平台 which / run，所有系统级动作都经由这里（便于测试时注入假实现）
'use strict'
const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

function which(cmd, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext)
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch {}
    }
  }
  return null
}

function run(file, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: opts.timeout ?? 15000, windowsHide: true, env: opts.env, shell: opts.shell },
      (err, stdout, stderr) => {
        resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') })
      })
  })
}

const ps = (script, sys) => sys.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
const osa = (script, sys) => sys.run('osascript', ['-e', script])

/** Linux 会话类型：Wayland 下 xdotool/wmctrl 无法操作其它程序窗口 */
function linuxSession(env = process.env) {
  if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland') return 'wayland'
  return env.DISPLAY ? 'x11' : 'none'
}

module.exports = { which, run, ps, osa, linuxSession, PLATFORM_LABEL, defaultSys: { which, run, platform: process.platform, env: process.env } }
