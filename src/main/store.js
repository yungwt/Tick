import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

let cache = null

function file() {
  return path.join(app.getPath('userData'), 'tasks.json')
}

function normalize(t) {
  return {
    id: t.id || crypto.randomUUID(),
    title: String(t.title ?? ''),
    note: String(t.note ?? ''),
    done: !!t.done,
    priority: ['high', 'mid', 'low', 'none'].includes(t.priority) ? t.priority : 'none',
    dueAt: Number.isFinite(t.dueAt) ? t.dueAt : null,
    completedAt: Number.isFinite(t.completedAt) ? t.completedAt : null,
    notified: !!t.notified,
    createdAt: t.createdAt || Date.now(),
    updatedAt: t.updatedAt || Date.now()
  }
}

function load() {
  if (cache) return cache
  const f = file()
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
    cache = Array.isArray(data) ? data.map(normalize) : []
  } catch {
    // 文件存在但读不出/解析失败（写一半断电、损坏）：先把坏文件改名留底，
    // 绝不直接覆盖——否则下一步 save() 会把损坏文件覆盖成空数组，数据彻底丢失
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 0) {
        fs.renameSync(f, `${f}.corrupt-${Date.now()}`)
      }
    } catch {}
    cache = []
  }
  return cache
}

function save() {
  const f = file()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  // 原子写：先写临时文件再 rename，写一半崩溃不会损坏正式文件
  const tmp = `${f}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8')
  fs.renameSync(tmp, f)
}

export function listTasks() {
  return load()
}

export function addTask(title) {
  const tasks = load()
  if (!title) return null
  const task = normalize({ title })
  tasks.unshift(task)
  save()
  return task
}

// 创建即编辑：一次性带全字段建任务
export function createTask(data) {
  const tasks = load()
  const task = normalize({ ...data, title: String(data?.title ?? '').trim() })
  if (!task.title) return null
  tasks.unshift(task)
  save()
  return task
}

export function updateTask(id, patch) {
  const tasks = load()
  const t = tasks.find((x) => x.id === id)
  if (!t) return null
  if (patch.title !== undefined && !String(patch.title).trim()) return t

  const next = normalize({ ...t, ...patch })
  // 截止时间被改动时，重置提醒标记，允许再次触发
  if (patch.dueAt !== undefined && patch.dueAt !== t.dueAt) next.notified = false
  // 完成状态流转：记录/清除完成时间（今日进度用）
  if (patch.done === true && !t.done) next.completedAt = Date.now()
  if (patch.done === false) next.completedAt = null
  next.updatedAt = Date.now()
  Object.assign(t, next)
  save()
  return t
}

export function deleteTask(id) {
  const tasks = load()
  const i = tasks.findIndex((x) => x.id === id)
  if (i >= 0) {
    tasks.splice(i, 1)
    save()
  }
  return true
}

// 撤销删除：把任务放回原位置
export function restoreTask(data, idx) {
  const tasks = load()
  const t = normalize(data || {})
  const i = Math.max(0, Math.min(tasks.length, Math.round(Number(idx) || 0)))
  tasks.splice(i, 0, t)
  save()
  return t
}

export function clearDone() {
  const tasks = load()
  cache = tasks.filter((t) => !t.done)
  save()
  return true
}

// 拖拽排序：把 dragId 移动到 targetId 之前
export function moveBefore(dragId, targetId) {
  const tasks = load()
  if (dragId === targetId) return tasks
  const from = tasks.findIndex((t) => t.id === dragId)
  if (from < 0) return tasks
  const [moved] = tasks.splice(from, 1)
  const to = tasks.findIndex((t) => t.id === targetId)
  if (to < 0) tasks.push(moved)
  else tasks.splice(to, 0, moved)
  save()
  return tasks
}

// 排序：把 dragId 移动到 targetId 之后（分组内下移用）
export function moveAfter(dragId, targetId) {
  const tasks = load()
  if (dragId === targetId) return tasks
  const from = tasks.findIndex((t) => t.id === dragId)
  if (from < 0) return tasks
  const [moved] = tasks.splice(from, 1)
  const to = tasks.findIndex((t) => t.id === targetId)
  if (to < 0) tasks.unshift(moved)
  else tasks.splice(to + 1, 0, moved)
  save()
  return tasks
}

// 供提醒定时器批量改动（标记已提醒）并落盘——只在内容真的变化时才写盘
export function withTasks(fn) {
  const tasks = load()
  const before = JSON.stringify(tasks)
  fn(tasks)
  if (JSON.stringify(tasks) !== before) save()
  return tasks
}
