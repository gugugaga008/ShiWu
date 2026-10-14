'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { ActionExecutor } = require('../src/actions')

function fakeSys(platform, tools = [], env = { DISPLAY: ':0' }, results = {}) {
  const calls = []
  return {
    platform, env, calls,
    which: (c) => (tools.includes(c) ? '/usr/bin/' + c : null),
    run: async (file, args) => {
      calls.push([file, ...args])
      const key = [file, args[0]].join(' ')
      return results[key] || { ok: true, code: 0, stdout: '', stderr: '' }
    },
  }
}
function fakeUi() {
  const log = []
  return {
    log,
    notify: (t, b) => { log.push(['notify', t, b]); return true },
    toast: (t, b) => log.push(['toast', t, b]),
    playSound: async (f) => log.push(['sound', f]),
    showCover: (s) => log.push(['cover', s]),
    ownPids: () => [42],
    hasNotifyDaemon: async () => false,
    minimizeOwn: () => log.push(['minimizeOwn']),
  }
}
const ev = (types) => ({ name: '王总', role: 'boss', role_label: '老板', actions: types.map((type) => ({ type, params: {} })) })

test('执行顺序：最小化先于遮挡，提醒在后', async () => {
  const ui = fakeUi()
  const sys = fakeSys('linux', ['xdotool'], { DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'x' })
  const r = await new ActionExecutor({ ui, sys, logger: {} }).execute(ev(['notify', 'cover', 'minimize_all']))
  assert.deepStrictEqual(r.map((x) => x.type), ['minimize_all', 'cover', 'notify'])
  assert.ok(r.every((x) => x.ok))
  assert.deepStrictEqual(ui.log.map((x) => x[0]), ['minimizeOwn', 'cover', 'notify', 'toast'])
  assert.match(ui.log[2][2], /王总（老板）/)
})

test('Linux 最小化跳过本应用窗口', async () => {
  const sys = fakeSys('linux', ['xdotool'], { DISPLAY: ':0' }, {
    'xdotool search': { ok: true, stdout: '11\n22\n' },
  })
  sys.run = (orig => async (f, a) => {
    if (a[0] === 'getwindowpid') return { ok: true, stdout: a[1] === '11' ? '42' : '99' }
    if (a[0] === 'getwindowname') return { ok: true, stdout: 'win' }
    return orig(f, a)
  })(sys.run)
  const r = await new ActionExecutor({ ui: fakeUi(), sys, logger: {} }).runOne({ type: 'minimize_all' }, {})
  assert.ok(r.ok, r.message)
  assert.match(r.message, /1 个窗口/)
  assert.deepStrictEqual(sys.calls.filter((c) => c[1] === 'windowminimize'), [['xdotool', 'windowminimize', '22']])
})

test('各平台系统命令', async () => {
  const cases = [
    ['win32', 'minimize_all', [], 'powershell.exe'],
    ['darwin', 'minimize_all', [], 'osascript'],
    ['win32', 'lock_screen', [], 'rundll32.exe'],
    ['linux', 'lock_screen', ['loginctl'], 'loginctl'],
    ['linux', 'mute', ['pactl'], 'pactl'],
    ['win32', 'mute', ['nircmd'], 'nircmd'],
    ['darwin', 'mute', [], 'osascript'],
    ['darwin', 'lock_screen', [], 'osascript'],
  ]
  for (const [platform, type, tools, bin] of cases) {
    const sys = fakeSys(platform, tools)
    const r = await new ActionExecutor({ ui: fakeUi(), sys, logger: {} }).runOne({ type }, {})
    assert.ok(r.ok, `${platform} ${type}: ${r.message}`)
    assert.strictEqual(sys.calls[0][0], bin)
  }
})

test('不支持/缺工具/Wayland 给出明确提示', async () => {
  let r = await new ActionExecutor({ ui: fakeUi(), sys: fakeSys('freebsd'), logger: {} }).runOne({ type: 'mute' }, {})
  assert.ok(!r.ok && /暂不支持「静音」/.test(r.message))
  r = await new ActionExecutor({ ui: fakeUi(), sys: fakeSys('linux', []), logger: {} }).runOne({ type: 'minimize_all' }, {})
  assert.ok(!r.ok && /未找到 xdotool/.test(r.message))
  r = await new ActionExecutor({ ui: fakeUi(), sys: fakeSys('linux', ['xdotool'], { WAYLAND_DISPLAY: 'w' }), logger: {} }).runOne({ type: 'minimize_all' }, {})
  assert.ok(!r.ok && /Wayland/.test(r.message))
  r = await new ActionExecutor({ ui: fakeUi(), sys: fakeSys('linux'), logger: {} }).runOne({ type: 'nope' }, {})
  assert.ok(!r.ok && /未知动作/.test(r.message))
})

test('切换程序与自定义命令参数校验', async () => {
  const ex = new ActionExecutor({ ui: fakeUi(), sys: fakeSys('linux', ['wmctrl']), logger: {} })
  assert.ok(!(await ex.runOne({ type: 'focus_app', params: {} }, {})).ok)
  assert.ok(!(await ex.runOne({ type: 'focus_app', params: { app: 'a"; rm -rf /' } }, {})).ok)
  const ok = await ex.runOne({ type: 'focus_app', params: { app: 'Code' } }, {})
  assert.ok(ok.ok)
  assert.deepStrictEqual(ex.sys.calls.at(-1), ['wmctrl', '-a', 'Code'])
  assert.ok(!(await ex.runOne({ type: 'command', params: {} }, {})).ok)
  const blocked = new ActionExecutor({ ui: fakeUi(), sys: fakeSys('linux'), settings: { allowCustomCommand: false }, logger: {} })
  assert.match((await blocked.runOne({ type: 'command', params: { cmd: 'echo hi' } }, {})).message, /禁用/)
})

test('macOS 锁屏：osascript 失败则回退 pmset / ScreenSaverEngine', async () => {
  const sys1 = fakeSys('darwin', [], {}, { 'osascript -e': { ok: false, code: 1, stdout: '', stderr: 'not allowed' } })
  const r1 = await new ActionExecutor({ ui: fakeUi(), sys: sys1, logger: {} }).runOne({ type: 'lock_screen' }, {})
  assert.ok(r1.ok, r1.message)
  assert.strictEqual(sys1.calls[0][0], 'osascript')
  assert.deepStrictEqual(sys1.calls[1], ['/usr/bin/pmset', 'displaysleepnow'])
  assert.strictEqual(sys1.calls.length, 2)

  const sys2 = fakeSys('darwin', [], {}, {
    'osascript -e': { ok: false, code: 1, stdout: '', stderr: 'x' },
    '/usr/bin/pmset displaysleepnow': { ok: false, code: 1, stdout: '', stderr: 'x' },
  })
  const r2 = await new ActionExecutor({ ui: fakeUi(), sys: sys2, logger: {} }).runOne({ type: 'lock_screen' }, {})
  assert.ok(r2.ok, r2.message)
  assert.deepStrictEqual(sys2.calls[2], ['/usr/bin/open', '-a', 'ScreenSaverEngine'])

  const sys3 = fakeSys('darwin', [], {}, {
    'osascript -e': { ok: false, code: 1, stdout: '', stderr: 'x' },
    '/usr/bin/pmset displaysleepnow': { ok: false, code: 1, stdout: '', stderr: 'x' },
    '/usr/bin/open -a': { ok: false, code: 1, stdout: '', stderr: 'x' },
  })
  const r3 = await new ActionExecutor({ ui: fakeUi(), sys: sys3, logger: {} }).runOne({ type: 'lock_screen' }, {})
  assert.ok(!r3.ok)
  assert.match(r3.message, /辅助功能/)
})

test('Linux 无通知守护进程时通知用应用浮窗兜底；插件可扩展', async () => {
  const ui = fakeUi()
  const ex = new ActionExecutor({ ui, sys: fakeSys('linux', [], { DISPLAY: ':0' }), logger: {} })
  const r = await ex.runOne({ type: 'notify' }, { name: '王总', role_label: '老板' })
  assert.ok(r.ok)
  assert.deepStrictEqual(ui.log.map((x) => x[0]), ['notify', 'toast'])
  ex.register({ type: 'webhook', label: 'Webhook', platforms: ['linux'], run: async () => ({ ok: true, message: 'sent' }) })
  assert.strictEqual((await ex.runOne({ type: 'webhook' }, {})).message, 'sent')
  assert.ok(ex.list().some((p) => p.type === 'lock_screen' && p.supported))
})
