// 识务 · Electron 主进程：托管 Python 服务、加载管理界面、托盘、全局快捷键、执行规则动作
'use strict'
const { env } = require('./env')
const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, nativeImage, screen, shell, dialog, powerMonitor, session } = require('electron')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { Backend } = require('./backend')
const { Live } = require('./live')
const { ActionExecutor } = require('./actions')
const { WindowMemo, restoreWindows } = require('./actions/windows')
const { defaultSys } = require('./actions/sys')
const windowMemo = new WindowMemo()

const ASSETS = path.join(__dirname, '..', 'assets')
const UNLOCK = env('SHIWU_UNLOCK_ACCELERATOR', 'SHIWU_UNLOCK_ACCELERATOR') || 'CommandOrControl+Alt+B'
const PAUSE_KEY = 'CommandOrControl+Alt+P'

app.setName('识务')
app.setAppUserModelId?.('com.shiwu.app')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (env('SHIWU_FAKE_WEBCAM', 'SHIWU_FAKE_WEBCAM')) {
  // 测试：用视频文件（.y4m/.mjpeg）当 getUserMedia 摄像头
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-video-capture', env('SHIWU_FAKE_WEBCAM', 'SHIWU_FAKE_WEBCAM'))
}

let mainWin = null
let coverWin = null
let tray = null
let backend = null
let live = null
let executor = null
let paused = false
let pipelineRunning = false
let quitting = false
let logStream = null
let cameraWin = null
let settings = {}

function log(...a) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${a.join(' ')}`
  console.log(line)
  logStream?.write(line + '\n')
}

// ---------------- 窗口 ----------------
const secureWeb = { contextIsolation: true, nodeIntegration: false, sandbox: true }

function lockDown(win) {
  // 只允许加载本机服务与本地文件；外链交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(backend.url) && !url.startsWith('file:')) {
      e.preventDefault()
      shell.openExternal(url)
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function openMain() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show()
    mainWin.focus()
    return
  }
  mainWin = new BrowserWindow({
    width: 1360, height: 900, title: '识务', icon: path.join(ASSETS, 'icons', 'icon.png'),
    autoHideMenuBar: true, webPreferences: secureWeb,
  })
  lockDown(mainWin)
  mainWin.loadURL(`${backend.url}/ui${env('SHIWU_START_PATH', 'SHIWU_START_PATH') || '/'}`)
  mainWin.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWin.hide() // 关闭窗口 = 收到托盘，监控继续
    }
  })
}

function showCover(style) {
  if (coverWin && !coverWin.isDestroyed()) {
    coverWin.show()
    coverWin.setAlwaysOnTop(true, 'screen-saver')
    coverWin.focus()
    return
  }
  const { bounds } = screen.getPrimaryDisplay()
  coverWin = new BrowserWindow({
    ...bounds, frame: false, fullscreen: true, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    movable: false, minimizable: false, closable: false, focusable: true, title: '2026年Q4预算.xlsx - 表格',
    backgroundColor: '#ffffff', webPreferences: secureWeb,
  })
  coverWin.setAlwaysOnTop(true, 'screen-saver')
  coverWin.setVisibleOnAllWorkspaces?.(true)
  coverWin.loadFile(path.join(__dirname, 'windows', 'cover.html'), { query: { style } })
  coverWin.on('closed', () => (coverWin = null))
  updateTray()
}

function hideCover() {
  if (coverWin && !coverWin.isDestroyed()) {
    coverWin.setClosable(true)
    coverWin.close()
    coverWin = null
    log('[cover] 已解除遮挡')
  }
  updateTray()
}

function toast(title, body) {
  const { workArea } = screen.getPrimaryDisplay()
  const w = 400, h = 150
  const time = new Date().toLocaleString('zh-CN', { hour12: false })
  const win = new BrowserWindow({
    x: workArea.x + workArea.width - w - 16, y: workArea.y + 16, width: w, height: h, frame: false,
    transparent: true, alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, show: false,
    webPreferences: secureWeb,
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'windows', 'toast.html'), { query: { title, body, time } })
  win.once('ready-to-show', () => win.showInactive())
  setTimeout(() => !win.isDestroyed() && win.close(), Number(env('SHIWU_TOAST_MS', 'SHIWU_TOAST_MS') || 8000))
}

let notifyGranted = null
function prepareNotify() {
  if (!Notification.isSupported()) {
    notifyGranted = false
    return Promise.resolve(false)
  }
  const req = Notification.requestPermission
  if (typeof req !== 'function') {
    notifyGranted = true
    return Promise.resolve(true)
  }
  return Promise.resolve(req.call(Notification)).then((p) => {
    notifyGranted = p === 'granted' || p === undefined || p === 'default'
    return notifyGranted
  }).catch(() => {
    notifyGranted = false
    return false
  })
}

function notify(title, body) {
  if (!Notification.isSupported() || notifyGranted === false) return false
  try {
    const n = new Notification({
      title, body, icon: path.join(ASSETS, 'icons', 'icon.png'),
      silent: false, closeButtonText: '关闭',
    })
    n.on?.('failed', (e) => log(`[notify] 系统通知失败：${e}`))
    n.show()
    return true
  } catch (e) {
    log(`[notify] 无法显示系统通知：${e.message || e}`)
    return false
  }
}

function playSound(file, volume) {
  const p = path.join(ASSETS, 'sounds', path.basename(file))
  if (!fs.existsSync(p)) {
    shell.beep()
    return Promise.resolve()
  }
  let src = p
  if (p.includes('.asar')) {
    const tmp = path.join(app.getPath('temp'), 'shiwu-' + path.basename(p))
    try { fs.copyFileSync(p, tmp); src = tmp } catch {}
  }
  const win = new BrowserWindow({ show: false, webPreferences: { ...secureWeb, backgroundThrottling: false } })
  let played = false
  win.webContents.on('page-title-updated', (_e, title) => { if (title === 'ok') played = true })
  win.loadFile(path.join(__dirname, 'windows', 'sound.html'), { query: { src: 'file://' + src, v: String(volume) } })
  setTimeout(() => { if (!played) shell.beep() }, 1500)
  setTimeout(() => !win.isDestroyed() && win.destroy(), 10000)
  return Promise.resolve()
}

let daemonCache = null
function hasNotifyDaemon() {
  // Linux：会话总线上是否有 org.freedesktop.Notifications（没有则系统通知会静默丢失）
  if (process.platform !== 'linux') return Promise.resolve(true)
  if (daemonCache !== null) return Promise.resolve(daemonCache)
  return new Promise((resolve) => {
    if (!process.env.DBUS_SESSION_BUS_ADDRESS) return resolve((daemonCache = false))
    require('child_process').execFile('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
      'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.Notifications'], { timeout: 3000 },
    (err, out) => resolve((daemonCache = !err && /boolean true/.test(String(out)))))
  })
}

function minimizeOwn() {
  if (mainWin && !mainWin.isDestroyed() && mainWin.isVisible()) mainWin.minimize()
}

function ownPids() {
  const pids = new Set([process.pid])
  for (const m of app.getAppMetrics()) pids.add(m.pid)
  return [...pids]
}

// ---------------- 摄像头（getUserMedia 推流） ----------------
// 采集窗口必须真正显示（ordered in）才会被合成。
// 采集窗口的显示方式，SHIWU_CAMERA_MODE 选。
//
// 实测（macOS 26 / M1 Max，每种模式各跑多次，看服务端 frames_read）：
//   visible    76 帧   visible   79 帧   小浮窗，人眼可见
//   invisible  74 帧   invisible 79 帧   完全透明
//   offscreen  73 帧                      挪到屏幕外
//   hidden     73/79/79 帧  + 原始代码 160 帧   从不显示
// 四种都能采到帧。所以「窗口可见性」不是能否采到帧的决定因素。
//
// 之所以默认 invisible 而不是 hidden：invisible 的窗口在 Chromium 眼里确实是
// 已显示状态（isVisible=true），合成器必然分配，是构造上就成立的路径；
// hidden 虽然实测也通过，但依赖「隐藏窗口仍能解码视频」这一未完全查清的行为。
//
//   invisible  默认。完全看不见，但窗口处于已显示状态。
//   visible    360x240 小浮窗，出现但不抢焦点。
//   offscreen  挪到屏幕外，保持已显示状态。
//   hidden     show:false 且从不显示，连窗口都不占。
const CAMERA_MODE = env('SHIWU_CAMERA_MODE') || 'invisible'

function openCameraWindow() {
  if (cameraWin && !cameraWin.isDestroyed()) return
  const mode = CAMERA_MODE
  const transparent = mode === 'invisible'
  cameraWin = new BrowserWindow({
    width: 360, height: 240, show: false, title: '识务 · 摄像头',
    transparent,
    skipTaskbar: true,
    hasShadow: !transparent,
    webPreferences: { ...secureWeb, backgroundThrottling: false },
  })
  cameraWin.webContents.on('console-message', (_e, _l, msg) => msg.startsWith('[camera]') && log(msg))
  cameraWin.loadFile(path.join(__dirname, 'windows', 'camera.html'), {
    query: { port: String(backend.port), token: backend.token, name: 'electron',
      w: String(settings.camera_width || 1280), h: String(settings.camera_height || 720) },
  })
  if (mode !== 'hidden') {
    cameraWin.once('ready-to-show', () => {
      if (!cameraWin || cameraWin.isDestroyed()) return
      if (transparent) {
        // 顺序很重要：先 shown 再调 alpha，否则 Electron 在 macOS 上忽略透明度
        cameraWin.showInactive()
        cameraWin.setOpacity(0)
        cameraWin.setIgnoreMouseEvents(true) // 透明窗口照样会吃掉鼠标点击
        cameraWin.setWindowButtonVisibility(false)
      } else if (mode === 'offscreen') {
        cameraWin.showInactive()
        cameraWin.setPosition(-10000, -10000)
        cameraWin.setIgnoreMouseEvents(true)
      } else {
        cameraWin.showInactive()
      }
      if (typeof cameraWin.setHiddenInMissionControl === 'function') cameraWin.setHiddenInMissionControl(true)
      log(`[camera] 采集窗口模式：${mode}`)
    })
  } else {
    log(`[camera] 采集窗口模式：${mode}（保持 show:false，不调 showInactive）`)
  }
  // 所有模式都报一次窗口真实状态：排查时最需要知道的就是「它到底算不算可见」
  setTimeout(() => {
    if (!cameraWin || cameraWin.isDestroyed()) return
    log(`[camera] 窗口状态 mode=${mode} isVisible=${cameraWin.isVisible()} opacity=${cameraWin.getOpacity()} bounds=${JSON.stringify(cameraWin.getBounds())}`)
  }, 5000)
  cameraWin.on('closed', () => (cameraWin = null))
}

function closeCameraWindow() {
  if (cameraWin && !cameraWin.isDestroyed()) {
    try {
      const wc = cameraWin.webContents
      if (wc && !wc.isDestroyed()) wc.executeJavaScript('typeof stopCam==="function"&&stopCam()', true).catch(() => {})
    } catch {}
    cameraWin.destroy()
  }
  cameraWin = null
}

const isPush = (s) => s && s.kind === 'camera' && String(s.uri).startsWith('push://')
let lastPush = false

async function startMonitoring(src, { allowCamera = true } = {}) {
  if (!src && (settings.default_sources || []).length) {
    const path = allowCamera ? '/boss/pipeline/start-defaults' : '/boss/pipeline/start-defaults?cameras=0'
    const st = await backend.json(path, { method: 'POST' }).catch((e) => ({ start_errors: [{ error: e.message }] }))
    for (const e of st.start_errors || []) toast('画面源启动失败', `${e.name || ''} ${e.error}`)
    if (st.cameras_skipped) log('[monitor] 进入软件不自动打开摄像头')
    log(`[monitor] 已启动默认源 ${(st.pipelines || []).map((p) => p.name).join('、') || '（无）'}`)
    pipelineRunning = (st.pipelines || []).length > 0
    updateTray()
    lastPush = allowCamera && (st.pipelines || []).some((p) => isPush(p.source))
    if (lastPush && !paused) openCameraWindow()
    else closeCameraWindow()
    return
  }
  src = src || settings.default_source
  if (!src) {
    log('[monitor] 未设置默认画面源，等待在设置中选择')
    toast('还没有默认画面源', '请到设置 → 画面源添加并启动，或在「默认画面源」勾选后保存。')
    return
  }
  if (!allowCamera && (src.kind === 'camera' || isPush(src))) {
    return log('[monitor] 进入软件不自动打开摄像头，请手动开始监控')
  }
  const body = { ...src, loop: true }
  if (src.kind === 'camera' && !String(src.uri).startsWith('push://')) {
    body.width = settings.camera_width
    body.height = settings.camera_height
  }
  const r = await backend.fetch('/boss/pipeline/start', { method: 'POST', body: JSON.stringify(body) })
  if (!r.ok) {
    const msg = (await r.json().catch(() => ({}))).detail || r.status
    log(`[monitor] 启动失败：${msg}`)
    toast('画面源启动失败', String(msg))
    return
  }
  log(`[monitor] 已启动 ${src.kind}:${src.uri}`)
  pipelineRunning = true
  updateTray()
  lastPush = isPush(src)
  if (lastPush && !paused) openCameraWindow()
  else closeCameraWindow()
}

// ---------------- 开机自启 ----------------
function applyAutostart(on) {
  if (process.platform === 'linux') {
    // Electron 在 Linux 不支持 setLoginItemSettings：写 XDG autostart
    const dir = path.join(os.homedir(), '.config', 'autostart')
    const f = path.join(dir, 'shiwu.desktop')
    if (on) {
      const exec = process.env.APPIMAGE || process.execPath
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(f, `[Desktop Entry]\nType=Application\nName=识务\nExec="${exec}" --autostart\nX-GNOME-Autostart-enabled=true\n`)
    } else if (fs.existsSync(f)) fs.unlinkSync(f)
  } else {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      openAsHidden: !!on, // macOS：登录项以隐藏方式启动；args 主要对 Windows 有效
      args: ['--autostart'],
    })
  }
  log(`[autostart] ${on ? '已开启' : '已关闭'}`)
}

function onSettings(s) {
  const prev = settings
  settings = s || {}
  if (prev.autostart !== settings.autostart && prev.autostart !== undefined) applyAutostart(settings.autostart)
}

// ---------------- 监控开关 / 托盘 ----------------
async function setPaused(p) {
  try {
    const st = await backend.json(`/boss/monitor/${p ? 'pause' : 'resume'}?source=tray`, { method: 'POST' })
    paused = !!st.paused
    pipelineRunning = !!st.pipeline_running
  } catch (e) {
    log('[monitor] 切换失败', e.message)
  }
  updateTray()
}

function updateTray() {
  if (!tray) return
  const state = paused ? '监控已暂停' : pipelineRunning ? '监控中' : '尚未开始监控'
  tray.setToolTip(`识务 · ${state}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    paused || pipelineRunning
      ? { label: paused ? '▶ 恢复监控' : '⏸ 暂停监控', accelerator: PAUSE_KEY, click: () => setPaused(!paused) }
      : { label: '尚未开始监控', enabled: false },
    { label: '打开管理界面', click: openMain },
    { label: '用默认源开始监控', click: () => startMonitoring() },
    { label: '解除遮挡', accelerator: UNLOCK, enabled: !!coverWin, click: hideCover },
    { type: 'separator' },
    { label: '测试老板动作', click: () => backend.json('/boss/monitor/test', { method: 'POST', body: JSON.stringify({ role: 'boss', name: '测试' }) }).catch(() => {}) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
}

// ---------------- 动作 ----------------
function isTestEvent(ev) {
  return ev.source === 'test' || ev.name === '测试'
}

async function onAction(ev) {
  log(`[action] 收到 ${ev.name || '?'}（${ev.role}）→ ${ev.actions.map((a) => a.type).join(', ')}`)
  const test = isTestEvent(ev)
  if (paused && !test) return log('[action] 监控已暂停，忽略')
  const results = await executor.execute({ ...ev, role_label: ROLE_LABEL[ev.role] || (ev.stranger ? '陌生人' : '') })
  backend.fetch('/boss/actions/result', { method: 'POST', body: JSON.stringify({ action_id: ev.id, results }) }).catch(() => {})
  const failed = results.filter((r) => r.ok === false)
  if (failed.length) toast('动作失败', failed.map((r) => `${r.type}：${r.message}`).join('；'))
  else if (test) toast('测试动作', results.map((r) => `${r.type}：${r.message}`).join('；') || '已执行')
}

// 触发人离开画面超过 N 秒（规则开启「离开后自动恢复」）：解除遮挡 + 恢复之前被最小化的窗口
async function onLeave(lv) {
  log(`[leave] ${lv.name || '?'} 离开 ${lv.away_s}s → 自动恢复`)
  const results = []
  if (coverWin) {
    hideCover()
    results.push({ type: 'uncover', ok: true, message: '已自动解除遮挡' })
  }
  const rec = windowMemo.take(lv.action_id)
  if (rec) {
    const r = await restoreWindows(defaultSys, rec)
    results.push({ type: 'restore_windows', ...r })
    log(`[leave] ${r.message}`)
  }
  if (!results.length) results.push({ type: 'restore', ok: true, message: '无需恢复' })
  backend.fetch('/boss/actions/result', { method: 'POST', body: JSON.stringify({ action_id: lv.id, results }) }).catch(() => {})
}
const ROLE_LABEL = { boss: '老板', leader: '领导', staff: '同事', whitelist: '白名单' }

// ---------------- 启动 ----------------
async function boot() {
  const logDir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  logStream = fs.createWriteStream(path.join(logDir, 'desktop.log'), { flags: 'a' })
  // 开发模式默认用仓库 data/（与命令行启动的服务共用）；打包后用 userData
  const dataDir = env('SHIWU_USERDATA_DIR', 'SHIWU_USERDATA_DIR') || (app.isPackaged ? app.getPath('userData') : null)
  backend = new Backend({ port: Number(env('SHIWU_PORT', 'SHIWU_PORT') || 7400), dataDir, log })

  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'icons', process.platform === 'darwin' ? 'icon22.png' : 'icon32.png')))
  tray.on('click', openMain)
  updateTray()

  try {
    await backend.start()
  } catch (e) {
    dialog.showErrorBox('识务', `识别服务启动失败：${e.message}`)
    quitting = true
    return app.quit()
  }
  log(`[backend] 就绪 ${backend.url}`)

  executor = new ActionExecutor({
    ui: { notify, toast, playSound, showCover, ownPids, hasNotifyDaemon, minimizeOwn, unlockAccelerator: UNLOCK,
      rememberWindows: (id, rec) => windowMemo.save(id, rec) },
    settings: { allowCustomCommand: env('SHIWU_ALLOW_COMMAND', 'SHIWU_ALLOW_COMMAND') !== '0' },
    logger: { info: log },
  })
  const onEvent = (e) => {
    const d = e.data || {}
    if ((e.type === 'person_recognized' || e.type === 'track_identity') && d.role) log(`[live] 识别 ${d.name}（${d.role}）sim=${d.similarity}`)
  }
  settings = await backend.json('/boss/settings')
  if (app.isPackaged) applyAutostart(!!settings.autostart)
  live = new Live(backend, { onAction, onLeave, onEvent, onSettings, onPipeline: (src, sources) => {
    // 管理界面里加了「桌面端摄像头」源时由这里开采集窗口（多路时任一路是推流即可）
    const list = sources || [src]
    pipelineRunning = list.filter(Boolean).length > 0
    lastPush = list.some(isPush)
    updateTray()
    if (lastPush && !paused) openCameraWindow()
    else closeCameraWindow()
  }, onMonitor: (m) => {
    paused = !!m.paused
    if (typeof m.pipeline_running === 'boolean') pipelineRunning = m.pipeline_running
    updateTray()
    if (paused) closeCameraWindow()
    else if (lastPush) openCameraWindow()
  } }, log)
  live.connect()
  // WS 偶尔会漏掉进程内线程自行退出的情况，定时兜底同步托盘状态。
  setInterval(async () => {
    if (quitting) return
    try {
      const st = await backend.json('/boss/monitor')
      paused = !!st.paused
      if (typeof st.pipeline_running === 'boolean') pipelineRunning = st.pipeline_running
      updateTray()
    } catch {}
  }, 15000)

  if (!globalShortcut.register(UNLOCK, hideCover)) log(`[shortcut] ${UNLOCK} 注册失败（可能被占用）`)
  globalShortcut.register(PAUSE_KEY, () => setPaused(!paused))

  // 媒体权限只给本地摄像头采集窗口与本机管理界面
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const url = details.requestingUrl || wc.getURL()
    cb(perm === 'media' && (url.startsWith('file:') || url.startsWith(backend.url)))
  })

  // 休眠 / 唤醒：唤醒后摄像头句柄多半失效，重开管道与采集窗口
  powerMonitor.on('suspend', () => { log('[power] 系统休眠'); closeCameraWindow() })
  powerMonitor.on('resume', () => setTimeout(async () => {
    log('[power] 系统唤醒，恢复监控')
    const st = await backend.json('/boss/pipeline/restart', { method: 'POST' }).catch(() => null)
    if (st?.source?.kind === 'camera' && String(st.source.uri).startsWith('push://')) openCameraWindow()
  }, 3000))

  const login = app.getLoginItemSettings?.() || {}
  const autostarted = process.argv.includes('--autostart') || !!login.wasOpenedAsHidden || !!login.wasOpenedAtLogin
  if (env('SHIWU_START_HIDDEN', 'SHIWU_START_HIDDEN') !== '1' && !autostarted) openMain()
  await prepareNotify()
  if (settings.auto_monitor && !env('SHIWU_AUTOSTART_VIDEO', 'SHIWU_AUTOSTART_VIDEO')) {
    await startMonitoring(undefined, { allowCamera: false })
  }
  // E2E：启动后自动开一路画面源
  if (env('SHIWU_AUTOSTART_VIDEO', 'SHIWU_AUTOSTART_VIDEO')) {
    await backend.json('/boss/pipeline/start', { method: 'POST', body: JSON.stringify({ kind: 'file', uri: env('SHIWU_AUTOSTART_VIDEO', 'SHIWU_AUTOSTART_VIDEO'), loop: false }) })
    log(`[e2e] 已启动画面源 ${env('SHIWU_AUTOSTART_VIDEO', 'SHIWU_AUTOSTART_VIDEO')}`)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', openMain)
  app.whenReady().then(boot)
  app.on('window-all-closed', (e) => e.preventDefault?.()) // 常驻托盘
  app.on('before-quit', () => { quitting = true })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    live?.close()
  closeCameraWindow()
    backend?.stop()
  })
}
