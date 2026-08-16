/**
 * dsh-msg-index client: a floating frosted-glass ball in the chat window.
 * Click to expand an index of the current session's user messages; click an
 * entry to smooth-scroll to that message.
 *
 * Session data comes from the `sessions` service (the same pattern used by
 * dsh-message-rail): the ball is hosted in the `shell.overlay` slot and
 * bridges a session-scoped child slot (`dsh-msg-index.rail`) via
 * SessionProvider, so the rail component receives the current sessionId and
 * the `useSession` subscription helper. Full history is pulled with
 * `session.loadOlder()` until `hasMore` is false; DOM rows are located
 * via the runtime-provided `data-chat-anchor-key` attribute (= node key).
 */
import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** The subset of the slots service this plugin touches. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: unknown): unknown
}

/** The sessions service surface this plugin needs (structural typing). */
interface ChatNode {
  kind: string
  data?: { time?: number; content?: unknown }
}
interface ChatSnapshot {
  chat: { order: string[]; nodes: Map<string, ChatNode> }
  hasMore: boolean
  loadingOlder: boolean
}
interface SessionLike {
  getSnapshot(): ChatSnapshot | undefined
  loadOlder(): Promise<unknown>
}
interface SessionsService {
  binding(sessionId: string): { session?: SessionLike } | undefined
}

/** The client cordis context shape this plugin relies on (structural typing). */
interface MsgIndexContext {
  slots: SlotsService
  sessions: SessionsService
}

/** Props injected into the session-scoped rail slot by the slot system. */
interface RailProps {
  sessionId: string
  useSession: <T>(selector: (s: ChatSnapshot | undefined) => T) => T
  sessions: SessionsService
}

/** Props passed to the shell.overlay component (standardProps). */
interface OverlayProps {
  SessionProvider: (props: { empty: () => null }, children: () => ReactNode) => ReactNode
  renderSlot: (slot: string, extra?: Record<string, unknown>) => ReactNode
}

export const name = 'dsh-msg-index'
export const inject = ['slots', 'sessions']

const BALL_SIZE = 48
const PANEL_WIDTH = 260
const PANEL_MAX_HEIGHT = 340

/** 悬浮球可移动范围：顶部避开对话标题栏，四周保持在视口内。 */
const MIN_TOP = 80
const MARGIN = 4
const clampBall = (left: number, top: number) => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const topMin = Math.min(MIN_TOP, Math.max(0, vh - BALL_SIZE - MARGIN))
  return {
    left: Math.max(MARGIN, Math.min(vw - BALL_SIZE - MARGIN, left)),
    top: Math.max(topMin, Math.min(vh - BALL_SIZE - MARGIN, top)),
  }
}

// 自定义面板滚动条：thumb 四周留透明边距（border + background-clip），
// 视觉上缩短滚动条边界，避免在圆角处超出面板。
if (typeof document !== 'undefined') {
  const styleId = 'dsh-msg-index-scrollbar'
  if (!document.getElementById(styleId)) {
    const st = document.createElement('style')
    st.id = styleId
    st.textContent = [
      '[data-msg-index-scroll] { scrollbar-width: thin; scrollbar-color: rgba(0,0,0,0.25) transparent; }',
      '[data-msg-index-scroll]::-webkit-scrollbar { width: 8px; }',
      '[data-msg-index-scroll]::-webkit-scrollbar-track { background: transparent; }',
      '[data-msg-index-scroll]::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.22); border-radius: 4px; border: 2px solid transparent; background-clip: padding-box; }',
    ].join('\n')
    document.head.appendChild(st)
  }
}

/** 超过该字数的消息文本直接隐藏后续部分，以省略号收尾。 */
const MAX_MSG_LEN = 120
const truncate = (text: string): string =>
  text.length > MAX_MSG_LEN ? text.slice(0, MAX_MSG_LEN) + '…' : text

/** 归一化文本（用于匹配判断）。 */
const norm = (t: string): string => t.replace(/\s+/g, ' ').trim()

/** 从消息节点的 content 数组里提取纯文本（与 dsh-message-rail 一致）。 */
function userTextOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') out += b.text
    }
  }
  return out.trim()
}

/** 搜索命中文字的高亮样式。 */
const highlightStyle: React.CSSProperties = {
  background: 'rgba(255, 213, 79, 0.55)',
  color: 'inherit',
  borderRadius: 2,
  padding: '0 1px',
}

/** 把文本中匹配 query（不区分大小写）的片段拆出来，包成 <mark> 高亮。 */
function highlightParts(text: string, query: string): ReactNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return [text]
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  let i = 0
  for (;;) {
    const idx = lower.indexOf(q, i)
    if (idx === -1) { parts.push(text.slice(i)); break }
    if (idx > i) parts.push(text.slice(i, idx))
    parts.push(h('mark', { style: highlightStyle }, text.slice(idx, idx + q.length)))
    i = idx + q.length
  }
  return parts
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 运行时会给会话行打 data-chat-anchor-key 属性，值即节点 key。 */
function findRow(key: string): HTMLElement | null {
  const sel = '[data-chat-anchor-key="' + key.replace(/"/g, '\\"') + '"]'
  try { return document.querySelector<HTMLElement>(sel) } catch { return null }
}

/** 当前 DOM 中所有已渲染行的 key 集合（用于区分"可直接定位"与"需加载"）。 */
function collectDomKeys(): Set<string> {
  const s = new Set<string>()
  if (typeof document === 'undefined') return s
  document.querySelectorAll('[data-chat-anchor-key]').forEach((el) => {
    const k = (el as HTMLElement).getAttribute('data-chat-anchor-key')
    if (k) s.add(k)
  })
  return s
}

/** 循环 loadOlder 直到目标节点出现在快照中（或没有更早历史）。 */
async function ensureNodeLoaded(sessions: SessionsService, sessionId: string, key: string): Promise<boolean> {
  const binding = sessions.binding(sessionId)
  const session = binding === undefined ? undefined : binding.session
  if (session === undefined) return false
  let stalls = 0
  for (let guard = 0; guard < 500; guard += 1) {
    const snap = session.getSnapshot()
    if (snap && snap.chat && snap.chat.nodes && snap.chat.nodes.get(key) !== undefined) return true
    if (snap === undefined || snap.hasMore !== true) return false
    if (snap.loadingOlder === true) { await delay(120); continue }
    const before = snap.chat ? snap.chat.order.length : 0
    try { await session.loadOlder() } catch { await delay(300) }
    const after = session.getSnapshot()
    const afterCount = after && after.chat ? after.chat.order.length : before
    if (afterCount === before) {
      stalls += 1
      if (stalls >= 5) return false
      await delay(300)
    } else {
      stalls = 0
    }
  }
  return false
}

interface MsgMark {
  key: string
  text: string
}

/** 从快照提取按顺序排列的用户消息（旧 → 新）。 */
function collectMarks(order: string[] | undefined, nodes: Map<string, ChatNode> | undefined): MsgMark[] {
  const result: MsgMark[] = []
  if (!order || !nodes) return result
  for (const key of order) {
    const node = nodes.get(key)
    if (node === undefined || node.kind !== 'user') continue
    const data = node.data || {}
    result.push({ key, text: userTextOf(data.content) || '(空消息)' })
  }
  return result
}

/** The shell.overlay host: bridge the session-scoped rail via SessionProvider. */
function Overlay(props: OverlayProps) {
  return h(
    props.SessionProvider,
    { empty: () => null },
    () => props.renderSlot('dsh-msg-index.rail', {}),
  )
}

/** 主滚动容器（对话页的消息滚动区域）。 */
function findScrollBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[class$="_scrollBody"]')
    || (document.scrollingElement as HTMLElement | null)
}

/**
 * 定位到指定用户消息：先在快照层确保节点已加载，再找 DOM 行；
 * 若行尚未渲染（虚拟窗口外），按其在 order 中的位置比例粗滚滚动容器，
 * 然后轮询等待运行时渲染出该行，最后 smooth-scroll 到视野中央。
 */
async function jumpTo(
  sessions: SessionsService,
  sessionId: string,
  key: string,
): Promise<boolean> {
  if (!(await ensureNodeLoaded(sessions, sessionId, key))) return false
  let row = findRow(key)
  if (row === null) {
    const binding = sessions.binding(sessionId)
    const snap = binding && binding.session ? binding.session.getSnapshot() : undefined
    const order = snap && snap.chat ? snap.chat.order : []
    const idx = order.indexOf(key)
    const scrollBody = findScrollBody()
    if (scrollBody !== null && idx >= 0 && order.length > 0) {
      const ratio = idx / order.length
      scrollBody.scrollTop = ratio * (scrollBody.scrollHeight - scrollBody.clientHeight)
    }
    for (let attempt = 0; attempt < 40 && row === null; attempt += 1) {
      await delay(100)
      row = findRow(key)
    }
  }
  if (row !== null) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return true
  }
  return false
}

function Rail(props: RailProps) {
  const { sessionId, useSession, sessions } = props

  const order = useSession((s) => (s && s.chat ? s.chat.order : undefined))
  const nodes = useSession((s) => (s && s.chat ? s.chat.nodes : undefined))
  const hasMore = useSession((s) => (s ? s.hasMore : undefined))

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(() => ({
    left: (typeof window !== 'undefined' ? window.innerWidth : 1280) - BALL_SIZE - 24,
    top: (typeof window !== 'undefined' ? window.innerHeight : 800) - BALL_SIZE - 90,
  }))
  const [loadingMore, setLoadingMore] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [jumpFail, setJumpFail] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; origLeft: number; origTop: number } | null>(null)
  /** 拖动是否已超过阈值（用于区分"拖动"与"点击"）。 */
  const movedRef = useRef(false)
  /** 按下时刻：长按超过阈值（无论是否拖动）不触发展开/收起。 */
  const pressTimeRef = useRef(0)
  const LONG_PRESS_MS = 500

  /** 用户消息（快照层，已全量加载后覆盖整个会话）。 */
  const marks = useMemo(() => collectMarks(order, nodes), [order, nodes])

  // 窗口尺寸变化时重新钳制球的位置，避免缩小窗口后球被推出视口。
  useEffect(() => {
    const onResize = () => setPos((p) => clampBall(p.left, p.top))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Click anywhere outside the ball/panel closes the panel.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.closest('[data-msg-index-panel]') || t.closest('[data-msg-index-ball]'))) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // 实时搜索过滤：按消息编号（数字）或消息内容匹配，保留原始序号。
  const filtered = useMemo(() => {
    if (!query.trim()) return marks.map((m, idx) => ({ m, idx }))
    const q = query.trim().toLowerCase()
    const num = parseInt(q, 10)
    const isNum = !isNaN(num)
    return marks
      .map((m, idx) => ({ m, idx }))
      .filter(({ m, idx }) => (isNum && idx + 1 === num) || m.text.toLowerCase().includes(q))
  }, [marks, query])

  // 分组：当前已渲染（可即时定位）与范围外（点击自动加载定位）。
  const domKeys = collectDomKeys()
  const withDom = filtered.map(({ m, idx }) => ({ m, idx, inDom: domKeys.has(m.key) }))
  const inDomItems = withDom.filter((x) => x.inDom)
  const outDomItems = withDom.filter((x) => !x.inDom)
  const anyOutDom = outDomItems.length > 0

  const jump = useCallback((key: string) => {
    setJumpFail(false)
    jumpTo(sessions, sessionId, key).then((ok) => {
      if (ok) { setOpen(false); return }
      setJumpFail(true)
      window.setTimeout(() => setJumpFail(false), 1600)
    })
  }, [sessions, sessionId])

  /** 按需加载：点击按钮时拉取一页更早的历史（不自动全量加载）。 */
  const loadMore = useCallback(async () => {
    const binding = sessions.binding(sessionId)
    const session = binding === undefined ? undefined : binding.session
    if (session === undefined || loadingMore) return
    setLoadingMore(true)
    try {
      const snap = session.getSnapshot()
      if (snap && snap.loadingOlder === true) {
        await delay(300)
      }
      await session.loadOlder()
    } catch {
      // loadOlder 失败由运行时吞错，忽略即可
    }
    setLoadingMore(false)
  }, [sessions, sessionId, loadingMore])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    movedRef.current = false
    pressTimeRef.current = Date.now()
    dragRef.current = { startX: e.clientX, startY: e.clientY, origLeft: pos.left, origTop: pos.top }
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (!movedRef.current && (Math.abs(ev.clientX - d.startX) > 5 || Math.abs(ev.clientY - d.startY) > 5)) {
        movedRef.current = true
      }
      setPos(clampBall(
        d.origLeft + (ev.clientX - d.startX),
        d.origTop + (ev.clientY - d.startY),
      ))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [pos.left, pos.top])

  const ballStyle: React.CSSProperties = {
    position: 'fixed',
    left: pos.left,
    top: pos.top,
    width: BALL_SIZE,
    height: BALL_SIZE,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, rgba(255, 255, 255, 0.32), rgba(255, 255, 255, 0.07))',
    backdropFilter: 'blur(22px) saturate(190%)',
    WebkitBackdropFilter: 'blur(22px) saturate(190%)',
    border: '1px solid rgba(255, 255, 255, 0.45)',
    boxShadow: '0 4px 20px rgba(0, 0, 0, 0.16), inset 0 1px 2px rgba(255, 255, 255, 0.6), inset 0 -1px 2px rgba(255, 255, 255, 0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'grab',
    zIndex: 2147483000,
    fontSize: 20,
    color: '#3b3b3b',
    userSelect: 'none',
    touchAction: 'none',
    pointerEvents: 'auto',
  }

  const panelStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.max(8, Math.min(
      pos.left + BALL_SIZE + 8 + PANEL_WIDTH <= (typeof window !== 'undefined' ? window.innerWidth : 1280)
        ? pos.left + BALL_SIZE + 8
        : pos.left - PANEL_WIDTH - 8,
      (typeof window !== 'undefined' ? window.innerWidth : 1280) - PANEL_WIDTH - 8,
    )),
    top: Math.max(8, Math.min(
      pos.top < ((typeof window !== 'undefined' ? window.innerHeight : 800) / 2)
        ? pos.top + BALL_SIZE + 8
        : pos.top - PANEL_MAX_HEIGHT - 8,
      (typeof window !== 'undefined' ? window.innerHeight : 800) - PANEL_MAX_HEIGHT - 8,
    )),
    width: PANEL_WIDTH,
    maxHeight: PANEL_MAX_HEIGHT,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'rgba(255, 255, 255, 0.38)',
    backdropFilter: 'blur(28px) saturate(190%)',
    WebkitBackdropFilter: 'blur(28px) saturate(190%)',
    border: '1px solid rgba(255, 255, 255, 0.6)',
    borderRadius: 16,
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.25), inset 0 1px 1px rgba(255, 255, 255, 0.7)',
    zIndex: 2147483001,
    pointerEvents: 'auto',
  }

  return h(Fragment, null,
    h('div', {
      style: ballStyle,
      onPointerDown,
      onClick: () => {
        const longPress = Date.now() - pressTimeRef.current > LONG_PRESS_MS
        if (movedRef.current || longPress) { movedRef.current = false; return }
        setOpen((o) => !o)
      },
      title: '对话索引',
      'data-msg-index-ball': true,
    }, h('span', { style: { pointerEvents: 'none' } }, '☰')),
    open &&
      h('div', { style: panelStyle, 'data-msg-index-panel': true },
        h('div', {
          style: {
            flexShrink: 0,
            fontSize: 12,
            color: '#000',
            fontWeight: 600,
            padding: '10px 10px 8px',
            borderBottom: '1px solid rgba(0,0,0,0.16)',
            display: 'flex',
            justifyContent: 'space-between',
          },
        },
          h('span', null, '用户消息索引'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', null, marks.length + ' 条' + (hasMore ? '（更早未加载）' : '')),
            h('span', {
              style: { cursor: 'pointer', fontSize: 13, lineHeight: 1 },
              onClick: () => { setSearchOpen((o) => !o); if (searchOpen) setQuery('') },
              title: '搜索',
            }, '🔍'),
          ),
        ),
        searchOpen &&
          h('div', { style: { flexShrink: 0, padding: '6px 10px 8px', borderBottom: '1px solid rgba(0,0,0,0.08)' } },
            h('input', {
              style: {
                width: '100%',
                boxSizing: 'border-box',
                padding: '6px 10px',
                fontSize: 12,
                borderRadius: 8,
                border: '1px solid rgba(0,0,0,0.14)',
                background: 'rgba(255,255,255,0.7)',
                outline: 'none',
              },
              placeholder: '按编号或内容搜索…',
              value: query,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value),
              autoFocus: true,
            }),
          ),
        h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 8px' }, 'data-msg-index-scroll': true },
        withDom.length === 0
          ? h('div', { style: { fontSize: 12, color: '#aaa', padding: 12, textAlign: 'center' } }, query.trim() ? '没有匹配的消息' : '没有找到用户消息')
          : h(Fragment, null,
                hasMore && h('div', { style: { marginBottom: 6 } },
                  h('button', {
                    onClick: loadMore,
                    disabled: loadingMore,
                    style: {
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '7px 0',
                      fontSize: 12,
                      borderRadius: 8,
                      border: '1px solid rgba(0,0,0,0.14)',
                      background: 'rgba(255,255,255,0.55)',
                      cursor: loadingMore ? 'default' : 'pointer',
                      color: '#d46b08',
                    },
                  }, loadingMore ? '加载中…' : '加载更早消息…'),
                ),
                hasMore && h('div', { style: { fontSize: 11, color: '#d46b08', background: 'rgba(250,173,20,0.12)', borderRadius: 8, padding: '6px 8px', marginBottom: 6 } },
                  '更早的消息尚未加载，可点击上方按钮逐页加载，或直接点击索引条目按需加载定位',
                ),
                anyOutDom && h('div', { style: { fontSize: 11, color: '#d46b08', background: 'rgba(250,173,20,0.12)', borderRadius: 8, padding: '6px 8px', marginBottom: 6 } },
                  '部分消息不在当前渲染范围内，点击会自动加载并定位',
                ),
                jumpFail && h('div', { style: { fontSize: 11, color: '#d4380d', background: 'rgba(255,77,79,0.1)', borderRadius: 8, padding: '6px 8px', marginBottom: 6 } },
                  '定位失败：该消息可能已不存在或加载异常',
                ),
                outDomItems.map(({ m, idx }) =>
                  h('div', {
                    key: 'out-' + idx,
                    onClick: () => jump(m.key),
                    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'rgba(250,173,20,0.18)' },
                    onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.25)' },
                    style: {
                      background: 'rgba(255, 255, 255, 0.25)',
                      border: '1px dashed rgba(0,0,0,0.14)',
                      borderRadius: 10,
                      padding: '7px 9px',
                      marginBottom: 6,
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: '#777',
                      wordBreak: 'break-word',
                    },
                    title: '点击自动加载并定位（可能较慢）',
                  },
                    h('span', { style: { color: '#d48806', fontWeight: 600, marginRight: 6 } }, String(idx + 1)),
                    h('span', null, highlightParts(truncate(m.text), query)),
                  ),
                ),
                anyOutDom && h('div', { style: { borderTop: '1px dashed rgba(0,0,0,0.15)', margin: '6px 0' } }),
                inDomItems.map(({ m, idx }) =>
                  h('div', {
                    key: 'in-' + idx,
                    onClick: () => jump(m.key),
                    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'rgba(22,119,255,0.16)' },
                    onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => { e.currentTarget.style.background = 'rgba(255,255,255,0.42)' },
                    style: {
                      background: 'rgba(255, 255, 255, 0.42)',
                      backdropFilter: 'blur(12px) saturate(160%)',
                      WebkitBackdropFilter: 'blur(12px) saturate(160%)',
                      border: '1px solid rgba(255, 255, 255, 0.6)',
                      borderRadius: 10,
                      boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.5)',
                      padding: '7px 9px',
                      marginBottom: 6,
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: 1.5,
                      color: '#333',
                      wordBreak: 'break-word',
                    },
                  },
                    h('span', { style: { color: '#1677ff', fontWeight: 600, marginRight: 6 } }, String(idx + 1)),
                    h('span', null, highlightParts(truncate(m.text), query)),
                  ),
                ),
              ),
        ),
      ),
  )
}

export function apply(ctx: MsgIndexContext): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    {
      name: 'shell.overlay',
      id: 'dsh-msg-index',
      order: 100,
      children: { 'dsh-msg-index.rail': { kind: 'single', scope: 'session' } },
    },
    Overlay,
  ))
  ctx.slots.inject('dsh-msg-index.rail', () => ctx.slots.register(
    {
      name: 'dsh-msg-index.rail',
      inject: (sessionId: string) => ({ sessions: ctx.sessions }),
    },
    Rail,
  ))
}