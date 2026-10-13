// ActionExecutor：插件注册 + 按固定顺序执行一次 action 事件中的全部动作
'use strict'
const { defaultSys, PLATFORM_LABEL } = require('./sys')

// 先处理会影响其它窗口的动作，再盖遮挡层，最后提醒；锁屏/命令放最后
const ORDER = ['mute', 'minimize_all', 'focus_app', 'cover', 'notify', 'sound', 'log', 'command', 'lock_screen']

class ActionExecutor {
  constructor({ ui, sys = defaultSys, settings = {}, logger = console } = {}) {
    this.ui = ui
    this.sys = sys
    this.settings = settings
    this.logger = logger
    this.plugins = new Map()
    for (const p of require('./builtin')) this.register(p)
  }

  register(plugin) {
    if (!plugin?.type || typeof plugin.run !== 'function') throw new Error('无效的动作插件')
    this.plugins.set(plugin.type, plugin)
  }

  list() {
    return [...this.plugins.values()].map((p) => ({ type: p.type, label: p.label, supported: p.platforms.includes(this.sys.platform) }))
  }

  async runOne(action, event) {
    const p = this.plugins.get(action.type)
    if (!p) return { type: action.type, ok: false, message: `未知动作 ${action.type}` }
    if (!p.platforms.includes(this.sys.platform))
      return { type: action.type, ok: false, message: `当前平台（${PLATFORM_LABEL[this.sys.platform] || this.sys.platform}）暂不支持「${p.label}」` }
    const t0 = Date.now()
    try {
      const r = await p.run(action.params || {}, { sys: this.sys, ui: this.ui, event, settings: this.settings })
      return { type: action.type, ...r, ms: Date.now() - t0 }
    } catch (e) {
      return { type: action.type, ok: false, message: `执行异常：${e.message}`, ms: Date.now() - t0 }
    }
  }

  async execute(event) {
    const actions = [...(event.actions || [])].sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
    const results = []
    for (const a of actions) {
      const r = await this.runOne(a, event)
      results.push(r)
      this.logger.info?.(`[action] ${r.type}: ${r.ok ? 'OK' : 'FAIL'} ${r.message}`)
    }
    return results
  }
}

module.exports = { ActionExecutor, ORDER }
