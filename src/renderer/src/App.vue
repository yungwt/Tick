<script setup>
import { ref, computed, onMounted } from 'vue'

const api = window.tick

const tasks = ref([])
const draft = ref('')
const filter = ref('all')
const search = ref('')
const sortMode = ref('priority') // priority = 优先级-时间 | manual = 手动拖拽
const editingId = ref(null) // 任务 id 或 '__new__'
// 透明度初值夹紧到 30~100（防止 localStorage 里存过越界值）
const opacity = ref(Math.min(100, Math.max(30, Number(localStorage.getItem('tick.floatOpacity')) || 100)))

// ---- 设置面板 ----
const showSettings = ref(false)
const settingsTab = ref('general')
const SET_TABS = [
  { key: 'general', label: '通用' },
  { key: 'look', label: '外观' },
  { key: 'help', label: '帮助' }
]

// 外观：主题色 / 字体大小 / 任务框密度
const ACCENTS = ['#22d3ee', '#a78bfa', '#4ade80', '#f472b6', '#fb923c']
const ZOOMS = [
  { v: 0.9, label: '小' },
  { v: 1, label: '标准' },
  { v: 1.15, label: '大' }
]
const DENSITIES = [
  { v: 'compact', label: '紧凑' },
  { v: 'standard', label: '标准' },
  { v: 'roomy', label: '宽松' }
]
const accent = ref(localStorage.getItem('tick.accent') || '#22d3ee')
const zoom = ref(Number(localStorage.getItem('tick.zoom')) || 1)
const density = ref(localStorage.getItem('tick.density') || 'standard')

function applyAppearance() {
  document.documentElement.style.setProperty('--accent', accent.value)
  document.documentElement.style.setProperty('--float-alpha', String(opacity.value / 100))
  document.body.dataset.density = density.value
  api.setZoom(zoom.value)
}

function setAccent(c) {
  accent.value = c
  localStorage.setItem('tick.accent', c)
  applyAppearance()
}

function setZoom(v) {
  zoom.value = v
  localStorage.setItem('tick.zoom', String(v))
  applyAppearance()
}

function setDensity(v) {
  density.value = v
  localStorage.setItem('tick.density', v)
  applyAppearance()
}

// 全局快捷键（存主进程 settings.json，可自定义）
const shortcut = ref('Alt+T')
const recording = ref(false)

function startRecord() {
  recording.value = true
}

async function saveShortcut(acc) {
  const r = await api.setShortcut(acc)
  recording.value = false
  if (r.ok) {
    shortcut.value = r.shortcut
    showToast('快捷键已改为 ' + r.shortcut)
  } else {
    showToast('注册失败，该组合键可能被其他程序占用')
  }
}

// ---- 统一 toast ----
const toastMsg = ref('')
let toastTimer = null

function showToast(msg, ms = 3000) {
  toastMsg.value = msg
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toastMsg.value = ''), ms)
}

// ---- 删除撤销 ----
const undoTask = ref(null) // { task, idx }
let undoTimer = null

// 编辑弹窗表单（新建与编辑共用）
const editor = ref(null)

const filters = [
  { key: 'all', label: '全部' },
  { key: 'active', label: '进行中' },
  { key: 'done', label: '已完成' }
]

// 时期第二行：与状态筛选叠加，再点一次取消
const period = ref('all') // all | today | soon | long
const periods = [
  { key: 'today', label: '今日', tip: '已逾期 + 今天之内到期的任务' },
  { key: 'soon', label: '短期', tip: '截止时间在 2~30 天内的任务' },
  { key: 'long', label: '长期', tip: '没有截止时间，或截止在 30 天以外的任务' }
]

function togglePeriod(key) {
  period.value = period.value === key ? 'all' : key
}

const PRIO = {
  high: { label: '高', color: '#f87171' },
  mid: { label: '中', color: '#fbbf24' },
  low: { label: '低', color: '#60a5fa' },
  none: { label: '', color: 'transparent' }
}
const PRIO_RANK = { high: 0, mid: 1, low: 2, none: 3 }

function pad(n) {
  return String(n).padStart(2, '0')
}

function tsToLocal(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function localToTs(s) {
  if (!s) return null
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : null
}

function fmtDue(ts) {
  const d = new Date(ts)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  return `${sameYear ? '' : d.getFullYear() + '/'}${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ---- 智能分区：今日（逾期+今天到期）/ 短期（2~30 天）/ 长期（无截止或更远）----
const SECTION_DEFS = [
  { key: 'today', label: '今日' },
  { key: 'soon', label: '短期' },
  { key: 'long', label: '长期' }
]

function endOfToday() {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function sectionKeyOf(t) {
  if (t.dueAt == null) return 'long'
  const eod = endOfToday()
  if (t.dueAt <= eod) return 'today'
  return t.dueAt <= eod + 29 * 86400000 ? 'soon' : 'long'
}

const collapsed = ref(JSON.parse(localStorage.getItem('tick.sectionsCollapsed') || '{}'))

function toggleSection(key) {
  collapsed.value = { ...collapsed.value, [key]: !collapsed.value[key] }
  localStorage.setItem('tick.sectionsCollapsed', JSON.stringify(collapsed.value))
}

const filtered = computed(() => {
  let list = tasks.value
  // 时期维度（第二行）：限定某个分区
  if (period.value !== 'all') list = list.filter((t) => sectionKeyOf(t) === period.value)
  // 状态维度（第一行）
  if (filter.value === 'active') list = list.filter((t) => !t.done)
  if (filter.value === 'done') list = list.filter((t) => t.done)
  const kw = search.value.trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (t) => t.title.toLowerCase().includes(kw) || t.note.toLowerCase().includes(kw)
    )
  }
  return list
})

const sections = computed(() => {
  const buckets = { today: [], soon: [], long: [] }
  for (const t of filtered.value) buckets[sectionKeyOf(t)].push(t)
  const cmp =
    sortMode.value === 'priority'
      ? (a, b) => {
          const p = PRIO_RANK[a.priority] - PRIO_RANK[b.priority]
          if (p) return p
          const da = a.dueAt ?? Infinity
          const db = b.dueAt ?? Infinity
          if (da !== db) return da - db
          return a.createdAt - b.createdAt
        }
      : null
  return SECTION_DEFS.map((d) => ({
    ...d,
    tasks: cmp ? [...buckets[d.key]].sort(cmp) : buckets[d.key]
  })).filter((s) => s.tasks.length)
})

// 任务 id → 分区 key，用于限制拖拽/移动只在同一分区内
const sectionOfId = computed(() => {
  const m = {}
  for (const s of sections.value) for (const t of s.tasks) m[t.id] = s.key
  return m
})

const activeCount = computed(() => tasks.value.filter((t) => !t.done).length)

// 今日完成进度
const doneToday = computed(() => {
  const today = new Date().toDateString()
  return tasks.value.filter(
    (t) => t.done && t.completedAt && new Date(t.completedAt).toDateString() === today
  ).length
})

const progress = computed(() => {
  const total = doneToday.value + activeCount.value
  return total ? doneToday.value / total : 0
})

async function refresh() {
  tasks.value = await api.listTasks()
}

// ---- 创建即编辑：输入框回车或点「新建」直接打开编辑器 ----
function openCreate() {
  editingId.value = '__new__'
  editor.value = {
    id: null,
    title: draft.value.trim(),
    note: '',
    priority: 'none',
    dueLocal: '',
    origDue: null
  }
  draft.value = ''
}

function openEditor(t) {
  editingId.value = t.id
  editor.value = {
    id: t.id,
    title: t.title,
    note: t.note,
    priority: t.priority,
    dueLocal: tsToLocal(t.dueAt),
    origDue: t.dueAt
  }
}

function closeEditor() {
  editingId.value = null
  editor.value = null
}

async function saveEditor() {
  const e = editor.value
  if (!e) return
  const dueAt = localToTs(e.dueLocal)
  const base = {
    title: e.title.trim(),
    note: e.note,
    priority: e.priority,
    dueAt
  }
  if (!base.title) {
    closeEditor()
    return
  }
  if (e.id) {
    const patch = { ...base }
    if (dueAt !== e.origDue) patch.notified = false
    await api.updateTask(e.id, patch)
  } else {
    await api.createTask(base)
  }
  closeEditor()
  await refresh()
}

const flashId = ref(null)
let flashTimer = null

async function toggle(t) {
  const marking = !t.done
  await api.updateTask(t.id, { done: !t.done })
  if (marking) {
    // 完成正反馈：卡片绿光一闪
    flashId.value = t.id
    clearTimeout(flashTimer)
    flashTimer = setTimeout(() => (flashId.value = null), 900)
  }
  await refresh()
}

async function remove(t) {
  const idx = tasks.value.findIndex((x) => x.id === t.id)
  await api.deleteTask(t.id)
  if (editor.value && editor.value.id === t.id) closeEditor()
  await refresh()
  // 5 秒内可撤销，不做打断式确认框
  // 注意：必须存纯对象快照——tasks.value 里的对象是 Vue 响应式 Proxy，
  // 直接传给 IPC 会因结构化克隆不支持 Proxy 而抛 "An object could not be cloned"
  undoTask.value = { task: JSON.parse(JSON.stringify(t)), idx: Math.max(0, idx) }
  clearTimeout(undoTimer)
  undoTimer = setTimeout(() => (undoTask.value = null), 5000)
}

async function undoDelete() {
  if (!undoTask.value) return
  const { task, idx } = undoTask.value
  undoTask.value = null
  clearTimeout(undoTimer)
  // 存进响应式 ref 里的对象取出来会重新被 Vue 包成 Proxy，必须在发送时再转一次纯对象
  await api.restoreTask(JSON.parse(JSON.stringify(task)), idx)
  await refresh()
}

async function clearDone() {
  const n = tasks.value.filter((t) => t.done).length
  await api.clearDone()
  await refresh()
  showToast(n ? `已清除 ${n} 个已完成任务` : '当前没有已完成的任务', 3000)
}

function toggleSort() {
  sortMode.value = sortMode.value === 'priority' ? 'manual' : 'priority'
}

async function exportTasks() {
  const p = await api.exportTasks()
  if (p) showToast('已导出到 ' + p, 4000)
}

function hideFloat() {
  api.hideFloat()
}

function onKey(e) {
  // 录制全局快捷键：拦截所有按键
  if (recording.value) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      recording.value = false
      return
    }
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return // 只按了修饰键
    const mods = []
    if (e.ctrlKey) mods.push('Ctrl')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    if (e.metaKey) mods.push('Super')
    if (!mods.length) return // 必须带修饰键，避免抢占普通按键
    let k = e.key === ' ' ? 'Space' : e.key
    saveShortcut([...mods, k.length === 1 ? k.toUpperCase() : k].join('+'))
    return
  }
  if (e.key === 'Escape') {
    if (editor.value) closeEditor()
    else if (showSettings.value) showSettings.value = false
    else hideFloat()
  }
}

// ---- 拖拽排序（两种模式都可拖；在优先级模式下拖动 = 切回手动）----
const dragId = ref(null)
const dropId = ref(null)
const canDrag = computed(() => !editingId.value)

function onDragStart(t, e) {
  dragId.value = t.id
  dropId.value = null
  // 用 1px 透明画布替代系统拖拽鬼影（鬼影在 DPI 缩放下会变形），改为原地半透明显示
  const ghost = document.createElement('canvas')
  ghost.width = ghost.height = 1
  e.dataTransfer.setDragImage(ghost, 0, 0)
  e.dataTransfer.effectAllowed = 'move'
}

async function onDrop(target, e) {
  e.preventDefault()
  // 只允许同一分区内拖拽排序（跨分区靠改截止时间自动归类）
  if (
    dragId.value &&
    dragId.value !== target.id &&
    sectionOfId.value[dragId.value] === sectionOfId.value[target.id]
  ) {
    if (sortMode.value !== 'manual') sortMode.value = 'manual'
    await api.moveBefore(dragId.value, target.id)
    await refresh()
  }
  dragId.value = null
  dropId.value = null
}

function onDragEnter(t) {
  if (dragId.value && sectionOfId.value[dragId.value] === sectionOfId.value[t.id]) {
    dropId.value = t.id
  }
}

async function move(t, delta) {
  // 优先级模式下点 ↑↓ = 切到手动模式再移动（与拖拽行为一致，否则底层移动被重新排序掩盖）
  if (sortMode.value !== 'manual') sortMode.value = 'manual'
  const sec = sections.value.find((s) => s.key === sectionOfId.value[t.id])
  if (!sec) return
  const i = sec.tasks.findIndex((x) => x.id === t.id)
  if (i < 0) return
  if (delta < 0 && i > 0) await api.moveBefore(t.id, sec.tasks[i - 1].id)
  else if (delta > 0 && i < sec.tasks.length - 1) await api.moveAfter(t.id, sec.tasks[i + 1].id)
  else return
  await refresh()
}

// 透明度：从滑杆事件直接取值（range 的 v-model 在松手前不更新，会读到旧值）
function applyOpacity(e) {
  const v = Math.min(100, Math.max(30, Math.round(Number(e.target.value)) || 100))
  opacity.value = v
  localStorage.setItem('tick.floatOpacity', String(v))
  document.documentElement.style.setProperty('--float-alpha', String(v / 100))
}

// ---- 边缘拖拽缩放：主进程轮询光标计算新尺寸，渲染层只负责开始/结束 ----
function startResize(e, dir) {
  e.preventDefault()
  try {
    e.target.setPointerCapture(e.pointerId)
  } catch {}
  api.resizeStart(dir)
}

function endResize() {
  api.resizeEnd()
  localStorage.setItem(
    'tick.floatSize',
    JSON.stringify({ width: window.innerWidth, height: window.innerHeight })
  )
}

const vFocus = { mounted: (el) => el.focus() }

onMounted(() => {
  window.addEventListener('keydown', onKey)
  // 保险：指针在任何位置松开都结束缩放
  window.addEventListener('pointerup', endResize)
  window.addEventListener('pointercancel', endResize)
  // 任何未捕获的异步错误直接弹 toast，避免按钮"静默没反应"
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e.reason?.message || String(e.reason || '未知错误')
    showToast('操作失败: ' + msg, 6000)
  })
  document.body.classList.add('is-float')
  applyAppearance()
  const saved = JSON.parse(localStorage.getItem('tick.floatSize') || 'null')
  if (saved && (saved.width || saved.height)) api.resizeWin(saved)
  api.settingsGet().then((s) => {
    if (s && s.shortcut) shortcut.value = s.shortcut
  })
  refresh()
})
</script>

<template>
  <div class="app float">
    <!-- 顶栏（无边框窗口的拖拽区） -->
    <div class="float-bar">
      <span class="logo-dot"></span>
      <span class="float-title">Tick</span>
      <span class="count mono">{{ activeCount }}</span>
      <span class="spacer"></span>
      <button class="tool-btn" title="设置与帮助" @click="showSettings = true">⚙</button>
      <button class="tool-btn" title="收起 (Esc / 快捷键)" @click="hideFloat">收起</button>
    </div>
    <!-- 今日完成进度 -->
    <div class="today-progress" :title="`今日完成 ${doneToday}/${doneToday + activeCount}`">
      <div class="fill" :style="{ width: progress * 100 + '%' }"></div>
    </div>
    <div class="float-settings">
      <span class="fs-label">背景</span>
      <input
        :value="opacity"
        class="opacity-slider"
        type="range"
        min="30"
        max="100"
        @input="applyOpacity"
      />
      <span class="fs-val mono">{{ opacity }}%</span>
    </div>

    <div class="add-row">
      <input
        v-model="draft"
        v-focus
        class="add-input"
        placeholder="输入标题，回车新建…"
        @keyup.enter="openCreate"
      />
      <button class="new-btn" title="新建任务：打开编辑窗口，可同时填写备注、优先级、截止时间" @click="openCreate">+ 新建</button>
    </div>

    <div class="search-row">
      <input v-model="search" class="add-input" placeholder="搜索标题或备注…" />
    </div>
    <transition name="fade">
      <div v-if="toastMsg" class="toast">{{ toastMsg }}</div>
    </transition>
    <transition name="fade">
      <div v-if="undoTask" class="toast undo-toast">
        <span class="undo-text">已删除「{{ undoTask.task.title.slice(0, 12) }}{{ undoTask.task.title.length > 12 ? '…' : '' }}」</span>
        <button class="undo-btn" @click="undoDelete">撤销</button>
      </div>
    </transition>

    <div class="toolbar">
      <div class="filters">
        <button
          v-for="f in filters"
          :key="f.key"
          :class="{ on: filter === f.key }"
          @click="filter = f.key"
        >
          {{ f.label }}
        </button>
      </div>
      <div class="right">
        <button
          class="tool-btn sort-toggle"
          :class="{ manual: sortMode === 'manual' }"
          title="当前排序方式。优先级 = 按优先级+截止时间自动排序；手动 = 自己拖拽或用任务上的 ↑↓ 按钮调顺序。点击切换"
          @click="toggleSort"
        >
          排序：{{ sortMode === 'priority' ? '优先级' : '手动' }}
        </button>
        <button class="tool-btn" title="一键删除所有已完成的任务" @click="clearDone">清完</button>
        <button class="tool-btn" title="把全部任务备份为 JSON 文件保存到任意位置" @click="exportTasks">导出</button>
      </div>
    </div>

    <!-- 时期第二行：与状态筛选叠加 -->
    <div class="periods">
      <button
        v-for="p in periods"
        :key="p.key"
        :class="{ on: period === p.key }"
        :title="p.tip"
        @click="togglePeriod(p.key)"
      >
        {{ p.label }}
      </button>
    </div>

    <div class="list" :class="{ 'drag-active': !!dragId, manual: sortMode === 'manual' }">
      <template v-for="s in sections" :key="s.key">
        <div class="sec-head" :title="'点击折叠/展开'" @click="toggleSection(s.key)">
          <span class="chev" :class="{ fold: !!collapsed[s.key] }">▾</span>
          <span class="sec-label">{{ s.label }}</span>
          <span class="sec-count mono">{{ s.tasks.length }}</span>
        </div>
        <ul v-show="!collapsed[s.key]">
          <li
            v-for="t in s.tasks"
            :key="t.id"
            :class="{ done: t.done, dragging: dragId === t.id, 'drop-before': dropId === t.id && dragId !== t.id, 'flash-done': flashId === t.id }"
            :style="t.priority !== 'none' ? { borderLeftColor: PRIO[t.priority].color } : {}"
            :draggable="canDrag"
            @dragstart="onDragStart(t, $event)"
            @dragover.prevent
            @dragenter="onDragEnter(t)"
            @dragend="dragId = null; dropId = null"
            @drop="onDrop(t, $event)"
          >
            <input type="checkbox" :checked="t.done" @change="toggle(t)" />
            <div class="content" @dblclick="openEditor(t)">
              <span class="title" :title="t.title">{{ t.title }}</span>
              <div v-if="t.priority !== 'none' || t.dueAt || t.note" class="meta">
                <span
                  v-if="t.priority !== 'none'"
                  class="badge"
                  :style="{ color: PRIO[t.priority].color, background: PRIO[t.priority].color + '1f' }"
                >
                  {{ PRIO[t.priority].label }}
                </span>
                <span
                  v-if="t.dueAt"
                  class="due mono"
                  :class="{ overdue: !t.done && t.dueAt < Date.now() }"
                >
                  截止 {{ fmtDue(t.dueAt) }}
                </span>
                <span v-if="t.note" class="note-prev" :title="t.note">{{ t.note }}</span>
              </div>
            </div>
            <div class="ops">
              <button class="mv" title="上移" @click="move(t, -1)">↑</button>
              <button class="mv" title="下移" @click="move(t, 1)">↓</button>
              <button class="del" title="删除" @click="remove(t)">×</button>
            </div>
          </li>
        </ul>
      </template>
      <div v-if="!sections.length" class="empty">
        <template v-if="search">没有匹配的任务</template>
        <template v-else>
          <p class="empty-t">没有任务，添加一个吧</p>
          <p class="empty-h">
            双击任务可编辑 · 拖动任务可排序 · 贴边缘/角落可缩放窗口<br />
            {{ shortcut }} 随时唤起或收起 · 收起后程序在托盘里，不会退出
          </p>
        </template>
      </div>
    </div>

    <!-- 缩放手柄：四边 + 四角 -->
    <div class="rz rz-r" @pointerdown="startResize($event, 'e')" @pointerup="endResize" @pointercancel="endResize"></div>
    <div class="rz rz-l" @pointerdown="startResize($event, 'w')" @pointerup="endResize" @pointercancel="endResize"></div>
    <div class="rz rz-b" @pointerdown="startResize($event, 's')" @pointerup="endResize" @pointercancel="endResize"></div>
    <div class="rz rz-t" @pointerdown="startResize($event, 'n')" @pointerup="endResize" @pointercancel="endResize"></div>
    <div class="rz rz-br" @pointerdown="startResize($event, 'se')" @pointerup="endResize" @pointercancel="endResize"></div>
    <div class="rz rz-bl" @pointerdown="startResize($event, 'sw')" @pointerup="endResize" @pointercancel="endResize"></div>
    <div class="rz rz-tr" @pointerdown="startResize($event, 'ne')" @pointerup="endResize" @pointercancel="endResize"></div>
    <div class="rz rz-tl" @pointerdown="startResize($event, 'nw')" @pointerup="endResize" @pointercancel="endResize"></div>

    <!-- 新建 / 编辑弹窗 -->
    <div v-if="editor" class="modal" @mousedown.self="closeEditor">
      <div class="modal-box">
        <h2>{{ editor.id ? '编辑任务' : '新建任务' }}</h2>
        <label class="field">
          <span>标题</span>
          <input v-model="editor.title" v-focus @keyup.enter="saveEditor" />
        </label>
        <label class="field">
          <span>备注</span>
          <textarea v-model="editor.note" rows="3" placeholder="补充说明（可选）"></textarea>
        </label>
        <div class="row2">
          <label class="field">
            <span>优先级</span>
            <select v-model="editor.priority">
              <option value="none">无</option>
              <option value="low">低</option>
              <option value="mid">中</option>
              <option value="high">高</option>
            </select>
          </label>
          <label class="field">
            <span>截止时间</span>
            <input type="datetime-local" v-model="editor.dueLocal" />
          </label>
        </div>
        <div class="modal-actions">
          <button v-if="editor.id" class="danger" @click="remove(tasks.find((t) => t.id === editor.id))">
            删除
          </button>
          <span class="spacer"></span>
          <button class="tool-btn" @click="closeEditor">取消</button>
          <button class="primary" @click="saveEditor">保存</button>
        </div>
      </div>
    </div>

    <!-- 设置弹窗：通用 / 外观 / 帮助 -->
    <div v-if="showSettings" class="modal" @mousedown.self="showSettings = false">
      <div class="modal-box settings-box">
        <div class="tabs">
          <button
            v-for="tb in SET_TABS"
            :key="tb.key"
            :class="{ on: settingsTab === tb.key }"
            @click="settingsTab = tb.key"
          >
            {{ tb.label }}
          </button>
        </div>

        <!-- 通用 -->
        <div v-if="settingsTab === 'general'" class="set-sec">
          <div class="set-row">
            <div class="set-info">
              <b>全局快捷键</b>
              <span>在任何应用里唤起 / 收起悬浮窗</span>
            </div>
            <button v-if="!recording" class="tool-btn" title="点击后按下新的组合键（需包含 Ctrl/Alt/Shift）即可更换全局快捷键" @click="startRecord">
              {{ shortcut }} · 修改
            </button>
            <button v-else class="tool-btn recording" title="直接按新组合键完成录制；点击此处取消" @click="recording = false">
              录制中… 取消
            </button>
          </div>
          <p v-if="recording" class="set-hint">按下新组合键（需包含 Ctrl / Alt / Shift），Esc 取消</p>
        </div>

        <!-- 外观 -->
        <div v-if="settingsTab === 'look'" class="set-sec">
          <div class="set-row">
            <div class="set-info">
              <b>主题色</b>
              <span>界面强调色</span>
            </div>
            <div class="swatches">
              <button
                v-for="c in ACCENTS"
                :key="c"
                class="swatch"
                :class="{ on: accent === c }"
                :style="{ background: c }"
                @click="setAccent(c)"
              ></button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info">
              <b>字体大小</b>
              <span>整体界面缩放</span>
            </div>
            <div class="seg">
              <button
                v-for="z in ZOOMS"
                :key="z.v"
                :class="{ on: zoom === z.v }"
                @click="setZoom(z.v)"
              >
                {{ z.label }}
              </button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-info">
              <b>任务框大小</b>
              <span>列表行距与内边距</span>
            </div>
            <div class="seg">
              <button
                v-for="d in DENSITIES"
                :key="d.v"
                :class="{ on: density === d.v }"
                @click="setDensity(d.v)"
              >
                {{ d.label }}
              </button>
            </div>
          </div>
        </div>

        <!-- 帮助（说明书） -->
        <div v-if="settingsTab === 'help'" class="set-sec help">
          <h3>快速上手</h3>
          <p>输入框打字回车，或点「+ 新建」——直接打开编辑窗口，一次填完标题、备注、优先级、截止时间。</p>
          <h3>任务操作</h3>
          <p>
            勾选框：完成 / 撤销完成 ·
            双击任务：编辑 ·
            悬浮任务：出现 ↑↓（调序）和 ×（删除，5 秒内可撤销） ·
            按住拖动：排序（在同一分区内）
          </p>
          <h3>智能分区</h3>
          <p>
            任务按截止时间自动分到「今日 / 短期 / 长期」，不用手动归类；
            改了截止时间会自动搬家。第二行「今日 / 短期 / 长期」筛选可与「进行中 / 已完成」叠加。
          </p>
          <h3>提醒</h3>
          <p>到截止时间弹系统通知；应用重启后错过的提醒会合并补发；改截止时间可重新触发提醒。</p>
          <h3>窗口</h3>
          <p>
            {{ shortcut }}：唤起 / 收起（可在「通用」里改）·
            拖顶栏移动位置 ·
            鼠标贴四边 / 四角拖动缩放 ·
            「背景」滑杆只调背景透明度，文字始终清晰 ·
            收起后程序在系统托盘，双击托盘图标也能打开
          </p>
          <h3>数据</h3>
          <p>
            任务保存在本机 AppData\Roaming\Tick\tasks.json，离线可用；「导出」生成备份 JSON；
            恢复备份：退出应用后把备份文件改名 tasks.json 放回该目录再打开。
          </p>
        </div>

        <div class="modal-actions">
          <span class="spacer"></span>
          <button class="tool-btn" @click="showSettings = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
