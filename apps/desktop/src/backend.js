const { env } = require('./env')
// 托管 Python 服务进程：每次启动随机会话 token、健康检查、退出时结束进程树
'use strict'
const { spawn, execSync } = require('child_process')
const { randomBytes } = require('crypto')
const fs = require('fs')
const net = require('net')
const path = require('path')

// src/ → apps/desktop/ → apps/ → 仓库根（.venv 与 python -m shiwu 的 cwd 都按这里定位）
const REPO = path.resolve(__dirname, '..', '..', '..')

function findPython() {
  const venv = path.join(REPO, '.venv')
  const cands = [
    env('SHIWU_PYTHON'),
    path.join(venv, 'bin', 'python'),
    path.join(venv, 'Scripts', 'python.exe'),
  ].filter(Boolean)
  return cands.find((p) => fs.existsSync(p)) || (process.platform === 'win32' ? 'python.exe' : 'python3')
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '127.0.0.1')
  })
}

class Backend {
  constructor({ port = 7400, dataDir, log = console.log, onExit = null } = {}) {
    this.port = port
    this.dataDir = dataDir
    this.log = log
    this.onExit = onExit
    this.proc = null
    this.external = false
    this.token = null
    this.stopping = false
    this.restarting = false
    this.exitCode = null
    this.exited = false
  }

  get url() {
    return `http://127.0.0.1:${this.port}`
  }

  async start({ reuse = false } = {}) {
    // 开发/测试：连接已在运行的服务（SHIWU_BACKEND_URL + SHIWU_TOKEN）
    if (env('SHIWU_BACKEND_URL')) {
      const u = new URL(env('SHIWU_BACKEND_URL'))
      this.port = Number(u.port)
      this.token = env('SHIWU_TOKEN') || ''
      this.external = true
      await this.waitHealthy(30000)
      return
    }
    if (!reuse) {
      for (let p = this.port; p < this.port + 20; p++) {
        if (await portFree(p)) {
          this.port = p
          break
        }
      }
      this.token = randomBytes(32).toString('hex')
    } else if (!this.token) {
      this.token = randomBytes(32).toString('hex')
    }
    const childEnv = { ...process.env, SHIWU_API_TOKEN: this.token, SERVER_PORT: String(this.port), PYTHONUNBUFFERED: '1' }
    if (this.dataDir) {
      // 和 paths.py 的两个可写目录一一对应
      childEnv.SHIWU_DATA_DIR = path.join(this.dataDir, 'data')
      childEnv.SHIWU_GALLERY_DIR = path.join(this.dataDir, 'gallery')
    }
    // 打包后：resources/server/shiwu（PyInstaller 独立可执行文件，内含模型与前端）
    const exe = path.join(process.resourcesPath || '', 'server', process.platform === 'win32' ? 'shiwu.exe' : 'shiwu')
    const packaged = !!process.resourcesPath && fs.existsSync(exe)
    const [cmd, args] = packaged
      ? [exe, ['--port', String(this.port)]]
      : [findPython(), ['-m', 'shiwu', '--port', String(this.port)]]
    this.log(`[backend] ${cmd} ${args.join(' ')}`)
    this.stopping = false
    this.exitCode = null
    this.exited = false
    this.proc = spawn(cmd, args, {
      env: childEnv, cwd: packaged ? path.dirname(exe) : REPO, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    })
    const out = (b) => String(b).split('\n').filter(Boolean).forEach((l) => this.log(`[py] ${l}`))
    const proc = this.proc
    proc.stdout.on('data', out)
    proc.stderr.on('data', out)
    proc.on('error', (e) => this.log(`[backend] 进程错误：${e.message}`))
    proc.on('exit', (c) => {
      this.log(`[backend] 进程退出 code=${c}`)
      if (this.proc === proc) {
        this.exitCode = c
        this.exited = true
        this.proc = null
      }
      if (!this.stopping && !this.restarting && !this.external) this.onExit?.({ code: c })
    })
    await this.waitHealthy(120000)
  }

  async restart({ attempts = 3 } = {}) {
    if (this.external || this.restarting) return false
    this.restarting = true
    try {
      for (let i = 0; i < attempts; i++) {
        try {
          const old = this.proc
          if (old && old.exitCode === null) {
            try { old.kill('SIGTERM') } catch {}
            await new Promise((resolve) => setTimeout(resolve, 800))
          }
          await this.start({ reuse: true })
          return true
        } catch (e) {
          this.log(`[backend] 重启失败 ${i + 1}/${attempts}：${e.message}`)
          await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)))
        }
      }
      return false
    } finally {
      this.restarting = false
    }
  }

  async waitHealthy(timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (this.exited) throw new Error(`Python 服务启动失败（进程已退出 code=${this.exitCode}）`)
      try {
        const r = await this.fetch('/boss/monitor')
        if (r.ok) return
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('等待 Python 服务超时')
  }

  fetch(p, opts = {}) {
    return fetch(this.url + p, { ...opts, headers: { 'X-Shiwu-Token': this.token, 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  }

  async json(p, opts) {
    const r = await this.fetch(p, opts)
    return r.json()
  }

  stop() {
    this.stopping = true
    if (!this.proc || this.external || this.proc.exitCode !== null) return
    const pid = this.proc.pid
    try {
      if (process.platform === 'win32') execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' })
      else process.kill(-pid, 'SIGTERM') // 结束整个进程组
    } catch {
      try { this.proc.kill('SIGKILL') } catch {}
    }
  }
}

module.exports = { Backend, findPython }
