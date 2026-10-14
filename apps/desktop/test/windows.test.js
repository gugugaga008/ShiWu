'use strict'
// v1.1：最小化时记录窗口，离开后按记录恢复（三端）
const test = require('node:test')
const assert = require('node:assert')
const { ActionExecutor } = require('../src/actions')
const { restoreWindows, WindowMemo, winMinimizeScript, winRestoreScript } = require('../src/actions/windows')

function sys(platform, tools, handler) {
  const calls = []
  return { platform, env: { DISPLAY: ':0' }, calls, which: (c) => (tools.includes(c) ? '/usr/bin/' + c : null),
    run: async (f, a) => { calls.push([f, ...a]); return handler(f, a) || { ok: true, stdout: '', stderr: '' } } }
}
const ui = (memo) => ({ ownPids: () => [42], minimizeOwn() {}, rememberWindows: (id, r) => memo.save(id, r) })

test('Linux：记录被最小化的窗口并用 wmctrl 恢复', async () => {
  const s = sys('linux', ['xdotool', 'wmctrl'], (f, a) => {
    if (a[0] === 'search') return { ok: true, stdout: '11\n22\n33\n' }
    if (a[0] === 'getwindowpid') return { ok: true, stdout: a[1] === '11' ? '42' : '7' }
    if (a[0] === 'getwindowname') return { ok: true, stdout: a[1] === '33' ? '' : 'Editor' }
  })
  const memo = new WindowMemo()
  const r = await new ActionExecutor({ ui: ui(memo), sys: s, logger: {} }).runOne({ type: 'minimize_all' }, { id: 'ev1' })
  assert.ok(r.ok, r.message)
  const rec = memo.take('ev1')
  assert.deepStrictEqual(rec.ids, ['22'])            // 跳过本应用(11)与无标题(33)
  assert.strictEqual(memo.take('ev1'), undefined)    // 只恢复一次
  const back = await restoreWindows(s, rec)
  assert.ok(back.ok && back.restored === 1)
  assert.deepStrictEqual(s.calls.at(-1), ['wmctrl', '-i', '-a', '0x16'])
})

test('Linux：只有 xdotool 时用 windowactivate；显示桌面模式用 wmctrl -k off', async () => {
  const s = sys('linux', ['xdotool'], () => null)
  await restoreWindows(s, { ids: ['5', '6'] })
  assert.deepStrictEqual(s.calls, [['xdotool', 'windowactivate', '6'], ['xdotool', 'windowactivate', '5']])
  const s2 = sys('linux', ['wmctrl'], () => null)
  const r = await restoreWindows(s2, { ids: [], showDesktop: true })
  assert.ok(r.ok) && assert.deepStrictEqual(s2.calls, [['wmctrl', '-k', 'off']])
})

test('Windows：user32 枚举/最小化返回句柄，恢复用 SW_RESTORE 逆序', async () => {
  const s = sys('win32', [], () => ({ ok: true, stdout: '1001,2002\r\n' }))
  const memo = new WindowMemo()
  const r = await new ActionExecutor({ ui: ui(memo), sys: s, logger: {} }).runOne({ type: 'minimize_all' }, { id: 'w' })
  assert.ok(r.ok) && assert.match(r.message, /2 个窗口/)
  assert.match(s.calls[0].at(-1), /EnumWindows/) && assert.match(s.calls[0].at(-1), /@\(42\)/)
  const rec = memo.take('w')
  assert.deepStrictEqual(rec.ids, ['1001', '2002'])
  await restoreWindows(s, rec)
  assert.match(s.calls.at(-1).at(-1), /@\(2002,1001\)/)
  assert.match(winRestoreScript(['1']), /ShowWindow\(\[IntPtr\]\$h, 9\)/)
  assert.match(winMinimizeScript([]), /@\(0\)/)
})

test('macOS：记录可见程序名，恢复时逐个 set visible true', async () => {
  const s = sys('darwin', [], (f, a) => (a[1].includes('get name') ? { ok: true, stdout: 'Safari, Microsoft Excel\n' } : null))
  const memo = new WindowMemo()
  await new ActionExecutor({ ui: ui(memo), sys: s, logger: {} }).runOne({ type: 'minimize_all' }, { id: 'm' })
  const rec = memo.take('m')
  assert.deepStrictEqual(rec.ids, ['Safari', 'Microsoft Excel'])
  assert.match(s.calls[0][2], /name is not "Electron"/)
  assert.match(s.calls[0][2], /识务 Helper/)
  assert.match(s.calls[1][2], /name is not "Electron"/)
  assert.match(s.calls[1][2], /background only is false/)
  const back = await restoreWindows(s, rec)
  assert.strictEqual(back.restored, 2)
  assert.match(s.calls.at(-1)[2], /process "Microsoft Excel" to true/)
})

test('macOS：隐藏失败时提示辅助功能权限，排除 Electron', async () => {
  const s = sys('darwin', [], (f, a) => {
    if (a[1].includes('get name')) return { ok: true, stdout: 'Safari\n' }
    return { ok: false, stdout: '', stderr: 'osascript is not allowed' }
  })
  const r = await new ActionExecutor({ ui: ui(new WindowMemo()), sys: s, logger: {} }).runOne({ type: 'minimize_all' }, { id: 'm2' })
  assert.ok(!r.ok)
  assert.match(r.message, /辅助功能/)
  assert.match(s.calls[0][2], /name is not "Electron"/)
  assert.match(s.calls[1][2], /name is not "Electron"/)
})

test('邮件动作由服务端执行，桌面端只记录', async () => {
  const r = await new ActionExecutor({ ui: {}, sys: sys('linux', [], () => null), logger: {} }).runOne({ type: 'email' }, {})
  assert.ok(r.ok) && assert.match(r.message, /识别服务/)
})
