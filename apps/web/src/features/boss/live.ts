import { useEffect, useState } from 'react'
import { type BossEvent, wsUrl } from '@/lib/api'

export type LiveFace = {
  track_id: number
  person_id: string | null
  name: string | null
  role: string | null
  similarity: number
  identity_source?: string
  source?: string
}
export type LiveFrame = { jpeg: string; faces: LiveFace[]; at: number }

/** WebSocket：预览帧（按视频源分开）+ 实时事件 */
export function useLive(opts: { frames?: boolean } = {}) {
  const [frames, setFrames] = useState<Record<string, LiveFrame>>({})
  const [events, setEvents] = useState<BossEvent[]>([])
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    let timer: ReturnType<typeof setTimeout>
    const connect = () => {
      ws = new WebSocket(wsUrl())
      ws.onopen = () => setConnected(true)
      ws.onclose = () => {
        setConnected(false)
        if (!closed) timer = setTimeout(connect, 2000)
      }
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data)
        if (msg.type === 'frame' && opts.frames) {
          const name = msg.source || '主画面'
          setFrames((prev) => ({ ...prev, [name]: { jpeg: `data:image/jpeg;base64,${msg.jpeg}`, faces: msg.faces || [], at: Date.now() } }))
        } else if (msg.type === 'action') {
          const a = msg.action
          setEvents((prev) => [{ type: 'action', source_id: a.source, pts: 0, wall_time: a.ts, role: a.role, data: a }, ...prev].slice(0, 100))
        } else if (msg.type === 'leave') {
          const a = msg.leave
          setEvents((prev) => [{ type: 'left', source_id: a.source, pts: 0, wall_time: a.ts, role: a.role, data: a }, ...prev].slice(0, 100))
        } else if (msg.type === 'event') {
          setEvents((prev) => [msg.event, ...prev].slice(0, 100))
        } else if (msg.type === 'pipeline') {
          const names = new Set((msg.sources || []).map((s: { name: string }) => s.name))
          setFrames((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => names.has(k))))
        }
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      ws?.close()
    }
  }, [opts.frames])

  const latest = Object.values(frames).sort((a, b) => b.at - a.at)[0]
  return { frames, frame: latest?.jpeg ?? null, faces: Object.values(frames).flatMap((f) => f.faces), events, connected }
}

export const fmtTime = (t: number) => new Date(t * 1000).toLocaleTimeString('zh-CN', { hour12: false })
export const fmtDateTime = (t: number) =>
  new Date(t * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
