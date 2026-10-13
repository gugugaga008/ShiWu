// 订阅 /boss/ws：action / monitor 事件（自动重连）
'use strict'
class Live {
  constructor(backend, handlers, log = console.log) {
    this.backend = backend
    this.h = handlers
    this.log = log
    this.closed = false
  }

  connect() {
    clearInterval(this.ping)
    const url = `ws://127.0.0.1:${this.backend.port}/boss/ws?token=${encodeURIComponent(this.backend.token)}`
    const ws = (this.ws = new WebSocket(url))
    ws.onopen = () => this.log('[live] 已连接')
    ws.onmessage = (m) => {
      let msg
      try { msg = JSON.parse(m.data) } catch { return }
      if (msg.type === 'action') this.h.onAction?.(msg.action)
      else if (msg.type === 'leave') this.h.onLeave?.(msg.leave)
      else if (msg.type === 'event') this.h.onEvent?.(msg.event)
      else if (msg.type === 'monitor') this.h.onMonitor?.(msg)
      else if (msg.type === 'settings') this.h.onSettings?.(msg.settings)
      else if (msg.type === 'pipeline') this.h.onPipeline?.(msg.source, msg.sources)
      else if (msg.type === 'hello') this.h.onMonitor?.(msg.monitor || {})
    }
    ws.onclose = () => {
      if (!this.closed) setTimeout(() => this.connect(), 2000)
    }
    ws.onerror = () => {}
    this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 20000)
  }

  close() {
    this.closed = true
    clearInterval(this.ping)
    this.ws?.close()
  }
}
module.exports = { Live }
