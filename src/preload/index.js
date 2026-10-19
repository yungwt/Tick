import { contextBridge, ipcRenderer, webFrame } from 'electron'

contextBridge.exposeInMainWorld('tick', {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  addTask: (title) => ipcRenderer.invoke('tasks:add', title),
  createTask: (data) => ipcRenderer.invoke('tasks:create', data),
  updateTask: (id, patch) => ipcRenderer.invoke('tasks:update', id, patch),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  restoreTask: (data, idx) => ipcRenderer.invoke('tasks:restore', data, idx),
  clearDone: () => ipcRenderer.invoke('tasks:clearDone'),
  moveBefore: (dragId, targetId) => ipcRenderer.invoke('tasks:moveBefore', dragId, targetId),
  moveAfter: (dragId, targetId) => ipcRenderer.invoke('tasks:moveAfter', dragId, targetId),
  exportTasks: () => ipcRenderer.invoke('tasks:export'),
  toggleFloat: () => ipcRenderer.invoke('float:toggle'),
  hideFloat: () => ipcRenderer.invoke('win:hide'),
  resizeStart: (dir) => ipcRenderer.send('win:resize-start', dir),
  resizeEnd: () => ipcRenderer.send('win:resize-end'),
  resizeWin: (size) => ipcRenderer.send('win:resize', size),
  getAutoLaunch: () => ipcRenderer.invoke('app:getAutoLaunch'),
  setAutoLaunch: (enable) => ipcRenderer.invoke('app:setAutoLaunch', enable),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  setShortcut: (acc) => ipcRenderer.invoke('settings:setShortcut', acc),
  setZoom: (f) => webFrame.setZoomFactor(Number(f) || 1)
})
