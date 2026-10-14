// 窗口记录与恢复：最小化时记下被收起的窗口，触发人离开后按记录恢复（三端分别实现）
'use strict'
const { ps, osa } = require('./sys')

// Windows：user32 EnumWindows，只动可见、未最小化、有标题、非本应用的顶层窗口
const WIN_TYPE = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices; using System.Collections.Generic;
public class BossWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  public static List<long> Visible(uint[] own) {
    var r = new List<long>(); var shell = GetShellWindow();
    EnumWindows((h, l) => { uint pid; GetWindowThreadProcessId(h, out pid);
      if (h != shell && IsWindowVisible(h) && !IsIconic(h) && GetWindowTextLength(h) > 0 && Array.IndexOf(own, pid) < 0) r.Add(h.ToInt64());
      return true; }, IntPtr.Zero);
    return r;
  }
}
"@`

function winMinimizeScript(own) {
  return `${WIN_TYPE}
$ids = [BossWin]::Visible(@(${own.map(Number).filter(Boolean).join(',') || '0'}))
foreach ($h in $ids) { [void][BossWin]::ShowWindow([IntPtr]$h, 6) }
($ids -join ',')`
}
function winRestoreScript(ids) {
  // 逆序恢复（先恢复的在下面），尽量保持原来的叠放顺序
  return `${WIN_TYPE}
foreach ($h in @(${[...ids].reverse().map(Number).join(',')})) { [void][BossWin]::ShowWindow([IntPtr]$h, 9) }
'ok'`
}

const MAC_EXCLUDE = 'name is not "识务" and name is not "Electron" and name is not "识务 Helper" and name is not "Electron Helper"'
const MAC_LIST = `tell application "System Events" to get name of (every process whose visible is true and background only is false and ${MAC_EXCLUDE})`
const MAC_HIDE = `tell application "System Events" to set visible of (every process whose visible is true and background only is false and ${MAC_EXCLUDE}) to false`

async function minimizeWindows(sys, ownPids = []) {
  if (sys.platform === 'win32') {
    const r = await ps(winMinimizeScript(ownPids), sys)
    const ids = r.stdout.trim().split(',').filter((x) => /^\d+$/.test(x))
    return { ok: r.ok, ids, method: 'user32', message: r.ok ? `已最小化 ${ids.length} 个窗口` : r.stderr.trim().slice(0, 200) }
  }
  if (sys.platform === 'darwin') {
    const l = await osa(MAC_LIST, sys)
    const names = l.ok ? l.stdout.trim().split(/,\s*/).filter(Boolean) : []
    const r = await osa(MAC_HIDE, sys)
    return {
      ok: r.ok, ids: names, method: 'osascript',
      message: r.ok ? `已隐藏 ${names.length} 个程序` : '需要在「系统设置 → 隐私与安全 → 辅助功能」中授权识务',
    }
  }
  // Linux X11
  if (sys.which('xdotool')) {
    const list = await sys.run('xdotool', ['search', '--onlyvisible', '--name', '.'])
    const own = new Set(ownPids.map(String))
    const ids = []
    for (const id of list.stdout.split(/\s+/).filter(Boolean)) {
      const pid = (await sys.run('xdotool', ['getwindowpid', id])).stdout.trim()
      if (pid && own.has(pid)) continue
      const name = (await sys.run('xdotool', ['getwindowname', id])).stdout.trim()
      if (!name) continue // 无标题的通常是桌面/面板
      if ((await sys.run('xdotool', ['windowminimize', id])).ok) ids.push(id)
    }
    return { ok: true, ids, method: 'xdotool', message: `已最小化 ${ids.length} 个窗口（xdotool）` }
  }
  if (sys.which('wmctrl')) {
    const r = await sys.run('wmctrl', ['-k', 'on'])
    return { ok: r.ok, ids: [], showDesktop: true, method: 'wmctrl', message: '显示桌面（wmctrl）' }
  }
  return { ok: false, ids: [], message: '未找到 xdotool / wmctrl' }
}

async function restoreWindows(sys, rec) {
  if (!rec) return { ok: true, restored: 0, message: '没有需要恢复的窗口' }
  const ids = rec.ids || []
  if (sys.platform === 'win32') {
    if (!ids.length) return { ok: true, restored: 0, message: '没有需要恢复的窗口' }
    const r = await ps(winRestoreScript(ids), sys)
    return { ok: r.ok, restored: r.ok ? ids.length : 0, message: r.ok ? `已恢复 ${ids.length} 个窗口` : r.stderr.trim().slice(0, 200) }
  }
  if (sys.platform === 'darwin') {
    let n = 0
    for (const name of ids) {
      if (/["\\]/.test(name)) continue
      if ((await osa(`tell application "System Events" to set visible of process "${name}" to true`, sys)).ok) n++
    }
    return { ok: true, restored: n, message: `已恢复 ${n} 个程序` }
  }
  if (rec.showDesktop && sys.which('wmctrl')) {
    const r = await sys.run('wmctrl', ['-k', 'off'])
    return { ok: r.ok, restored: 0, message: '已退出显示桌面' }
  }
  let n = 0
  const useWmctrl = sys.which('wmctrl')
  for (const id of [...ids].reverse()) {
    const r = useWmctrl ? await sys.run('wmctrl', ['-i', '-a', '0x' + Number(id).toString(16)])
      : await sys.run('xdotool', ['windowactivate', id])
    if (r.ok) n++
  }
  return { ok: n === ids.length, restored: n, message: `已恢复 ${n}/${ids.length} 个窗口（${useWmctrl ? 'wmctrl' : 'xdotool'}）` }
}

/** 按触发事件 id 记住被最小化的窗口；同一次“离开”只恢复一次 */
class WindowMemo {
  constructor() { this.map = new Map() }
  save(actionId, rec) { if (actionId && rec) this.map.set(actionId, rec); while (this.map.size > 20) this.map.delete(this.map.keys().next().value) }
  take(actionId) { const r = this.map.get(actionId); this.map.delete(actionId); return r }
}

module.exports = { minimizeWindows, restoreWindows, WindowMemo, winMinimizeScript, winRestoreScript }
