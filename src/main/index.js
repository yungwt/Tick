import { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, dialog, globalShortcut, screen } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { listTasks, addTask, createTask, updateTask, deleteTask, restoreTask, clearDone, moveBefore, moveAfter, withTasks } from './store'

let floatWin = null
let tray = null
let forceQuit = false

// Windows 通知需要 AppUserModelID，dev 下用可执行文件路径
app.setAppUserModelId(app.isPackaged ? 'com.yungw.tick' : process.execPath)

// 圆角卡片式悬浮窗，应用唯一界面
const FLOAT_SIZE = { width: 360, height: 540 }

function iconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(app.getAppPath(), 'resources', 'icon.png')
}

function icon() {
  return nativeImage.createFromPath(iconPath())
}

// 点通知唤起悬浮窗
function showFloat() {
  if (!floatWin || floatWin.isDestroyed()) {
    createFloatWindow()
    return
  }
  floatWin.show()
  floatWin.focus()
}

function notify(title, body) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: icon() })
  n.on('click', showFloat)
  n.show()
}

// ---- 提醒：30 秒轮询一次，刚到点的弹单条，错过的合并成一条摘要 ----
const FRESH_MS = 5 * 60 * 1000

function checkReminders() {
  const now = Date.now()
  const missed = []
  withTasks((tasks) => {
    for (const t of tasks) {
      if (t.done || !t.dueAt || t.notified) continue
      if (now >= t.dueAt) {
        t.notified = true
        if (now - t.dueAt <= FRESH_MS) {
          notify('Tick 任务提醒', t.title)
        } else {
          missed.push(t.title)
        }
      }
    }
  })
  if (missed.length) {
    notify(
      'Tick · 错过的提醒',
      `${missed.length} 个任务已到截止时间：\n` + missed.slice(0, 5).join('\n') + (missed.length > 5 ? '\n…' : '')
    )
  }
}

function loadPage(target) {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    target.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    target.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function placeFloatNearCursor() {
  const { x, y } = screen.getCursorScreenPoint()
  // 用当前实际宽度居中（窗口可能被用户拉宽过，固定 360 会偏）
  const w = floatWin && !floatWin.isDestroyed() ? floatWin.getBounds().width : FLOAT_SIZE.width
  floatWin.setPosition(Math.max(x - w / 2, 0), Math.max(y - 48, 0))
}

function createFloatWindow() {
  floatWin = new BrowserWindow({
    ...FLOAT_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  loadPage(floatWin)
  placeFloatNearCursor()

  // 始终置顶，不随失焦消失；收起走 Esc / 收起按钮 / Alt+T
  floatWin.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault()
      floatWin.hide()
    }
  })
}

function toggleFloat() {
  if (!floatWin || floatWin.isDestroyed()) {
    createFloatWindow()
    return
  }
  if (floatWin.isVisible()) {
    floatWin.hide()
  } else {
    placeFloatNearCursor()
    floatWin.show()
    floatWin.focus()
  }
}

// ---- 应用设置（settings.json，主进程持有：快捷键等需重启前持久化的项）----
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

let settings = null

function getSettings() {
  if (settings) return settings
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf-8'))
  } catch {
    settings = {}
  }
  if (typeof settings !== 'object' || !settings) settings = {}
  if (typeof settings.shortcut !== 'string' || !settings.shortcut) settings.shortcut = 'Alt+T'
  return settings
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf-8')
}

// ---- 导出备份（悬浮窗和托盘共用）----
async function exportBackup() {
  const { canceled, filePath } = await dialog.showSaveDialog(floatWin, {
    title: '导出任务备份',
    defaultPath: `tick-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (canceled || !filePath) return null
  fs.writeFileSync(filePath, JSON.stringify(listTasks(), null, 2), 'utf-8')
  return filePath
}

function createTray() {
  tray = new Tray(icon().resize({ width: 16, height: 16 }))
  tray.setToolTip('Tick - 待办清单')
  tray.setContextMenu(Menu.buildFromTemplate(trayMenu()))
  tray.on('double-click', toggleFloat)
}

// 模块级：快捷键改绑后托盘菜单要重建（标签里的快捷键是动态的）
function trayMenu() {
  return [
    { label: `显示 / 隐藏悬浮窗 (${getSettings().shortcut})`, click: toggleFloat },
    { label: '导出备份', click: () => exportBackup() },
    { type: 'separator' },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      enabled: app.isPackaged,
      click: (item) => {
        app.setLoginItemSettings({ openAsHidden: true, openAtLogin: item.checked })
        tray.setContextMenu(Menu.buildFromTemplate(trayMenu()))
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { forceQuit = true; app.quit() } }
  ]
}

// ---- IPC ----
ipcMain.handle('tasks:list', () => listTasks())
ipcMain.handle('tasks:add', (_e, title) => addTask(String(title || '').trim()))
ipcMain.handle('tasks:create', (_e, data) => createTask(data || {}))
ipcMain.handle('tasks:update', (_e, id, patch) => updateTask(id, patch))
ipcMain.handle('tasks:delete', (_e, id) => deleteTask(id))
ipcMain.handle('tasks:clearDone', () => clearDone())
ipcMain.handle('tasks:moveBefore', (_e, dragId, targetId) => moveBefore(dragId, targetId))
ipcMain.handle('tasks:moveAfter', (_e, dragId, targetId) => moveAfter(dragId, targetId))
ipcMain.handle('app:getAutoLaunch', () => app.getLoginItemSettings().openAtLogin)
ipcMain.handle('app:setAutoLaunch', (_e, enable) => {
  if (app.isPackaged) app.setLoginItemSettings({ openAsHidden: true, openAtLogin: !!enable })
  return app.getLoginItemSettings().openAtLogin
})

// 悬浮窗控制
ipcMain.handle('float:toggle', () => toggleFloat())
ipcMain.handle('win:hide', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  w.hide()
  // 第一次收起时提示「没退出，只是到托盘了」
  const s = getSettings()
  if (!s.hideHintShown) {
    s.hideHintShown = true
    saveSettings()
    notify('Tick 仍在后台运行', `点托盘图标或按 ${s.shortcut} 可再次打开悬浮窗`)
  }
})
// 撤销删除
ipcMain.handle('tasks:restore', (_e, data, idx) => restoreTask(data, idx))
// 设置
ipcMain.handle('settings:get', () => getSettings())
ipcMain.handle('settings:setShortcut', (_e, acc) => {
  const s = getSettings()
  const val = String(acc || '').trim()
  if (!val) return { ok: false, shortcut: s.shortcut }
  const old = s.shortcut
  globalShortcut.unregister(old)
  let ok = false
  try {
    ok = globalShortcut.register(val, toggleFloat)
  } catch {
    ok = false
  }
  if (ok) {
    s.shortcut = val
    saveSettings()
    // 托盘菜单里的快捷键标签是动态的，改绑后重建
    if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(trayMenu()))
  } else {
    // 注册失败：把旧快捷键注册回去，避免快捷键直接失效
    try {
      globalShortcut.register(old, toggleFloat)
    } catch {}
  }
  return { ok, shortcut: s.shortcut }
})
// 手动边缘/角落缩放（透明无边框窗口没有原生缩放边）：主进程轮询光标位置计算新边界
let rzTimer = null
const RZ_MIN = { width: 260, height: 340 }
const RZ_MAX = { width: 1400, height: 1800 }

ipcMain.on('win:resize-start', (e, dir) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w) return
  const d = String(dir || '')
  if (rzTimer) clearInterval(rzTimer)
  const b0 = w.getBounds()
  const { x, y } = screen.getCursorScreenPoint()
  rzTimer = setInterval(() => {
    if (w.isDestroyed()) {
      clearInterval(rzTimer)
      rzTimer = null
      return
    }
    const p = screen.getCursorScreenPoint()
    const b = { x: b0.x, y: b0.y, width: b0.width, height: b0.height }
    // 右/下方向直接改尺寸；左/上方向缩放要同时移动原点，保证对边保持不动
    if (d.includes('e')) b.width = b0.width + (p.x - x)
    if (d.includes('w')) {
      b.width = b0.width - (p.x - x)
      b.x = b0.x + (p.x - x)
    }
    if (d.includes('s')) b.height = b0.height + (p.y - y)
    if (d.includes('n')) {
      b.height = b0.height - (p.y - y)
      b.y = b0.y + (p.y - y)
    }
    // 尺寸限制：左/上方向触界时把原点拉回来
    if (b.width < RZ_MIN.width) {
      b.width = RZ_MIN.width
      if (d.includes('w')) b.x = b0.x + b0.width - RZ_MIN.width
    }
    if (b.width > RZ_MAX.width) {
      b.width = RZ_MAX.width
      if (d.includes('w')) b.x = b0.x + b0.width - RZ_MAX.width
    }
    if (b.height < RZ_MIN.height) {
      b.height = RZ_MIN.height
      if (d.includes('n')) b.y = b0.y + b0.height - RZ_MIN.height
    }
    if (b.height > RZ_MAX.height) {
      b.height = RZ_MAX.height
      if (d.includes('n')) b.y = b0.y + b0.height - RZ_MAX.height
    }
    const cur = w.getBounds()
    if (cur.x !== b.x || cur.y !== b.y || cur.width !== b.width || cur.height !== b.height) {
      w.setBounds(b)
    }
  }, 15)
})

ipcMain.on('win:resize-end', () => {
  if (rzTimer) {
    clearInterval(rzTimer)
    rzTimer = null
  }
})

app.on('browser-window-blur', () => {
  if (rzTimer) {
    clearInterval(rzTimer)
    rzTimer = null
  }
})

// 恢复上次尺寸（一次性 setBounds）
ipcMain.on('win:resize', (e, size) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || !size) return
  const width = Math.min(RZ_MAX.width, Math.max(RZ_MIN.width, Math.round(Number(size.width) || 360)))
  const height = Math.min(RZ_MAX.height, Math.max(RZ_MIN.height, Math.round(Number(size.height) || 540)))
  w.setSize(width, height)
})
ipcMain.handle('tasks:export', () => exportBackup())

// ---- 单实例锁：自启动 + 手动点开只保留一个进程 ----
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', toggleFloat)

  app.whenReady().then(() => {
    createFloatWindow()
    createTray()
    // 全局快捷键：默认 Alt+T，可在设置里改（存 settings.json）
    globalShortcut.register(getSettings().shortcut, toggleFloat)
    // 启动 3 秒后先补发一次错过的提醒，之后每 30 秒检查
    setTimeout(checkReminders, 3000)
    setInterval(checkReminders, 30 * 1000)
  })

  app.on('window-all-closed', () => {})
  app.on('before-quit', () => {
    forceQuit = true
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
  })
}
