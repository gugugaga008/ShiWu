import axios from 'axios'

declare global {
  interface Window {
    __SHIWU_TOKEN__?: string
    __SHIWU_BASE__?: string
  }
}

export const TOKEN: string =
  window.__SHIWU_TOKEN__ || import.meta.env.VITE_SHIWU_TOKEN || ''

export const api = axios.create({
  baseURL: '/boss',
  headers: { 'X-Shiwu-Token': TOKEN },
})

export const withToken = (path: string) =>
  `/boss${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`

export const wsUrl = () => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/boss/ws?token=${encodeURIComponent(TOKEN)}`
}

export const errMsg = (e: unknown): string => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = (e as any)?.response?.data?.detail
  if (!d) return String((e as Error)?.message ?? e)
  if (typeof d === 'string') return d
  if (d.message) return d.message + (d.reasons ? ' ' + JSON.stringify(d.reasons) : '')
  return JSON.stringify(d)
}

export const ROLE_LABEL: Record<string, string> = {
  boss: '老板',
  leader: '领导',
  staff: '同事',
  whitelist: '白名单',
  ignore: '忽略',
}
export const ROLE_VARIANT: Record<string, 'destructive' | 'default' | 'secondary' | 'outline'> = {
  boss: 'destructive',
  leader: 'default',
  staff: 'secondary',
  whitelist: 'outline',
  ignore: 'outline',
}
export const EVENT_LABEL: Record<string, string> = {
  person_recognized: '识别到人员',
  action: '触发动作',
  track_identity: '轨迹确认身份',
  face_unknown: '陌生人脸',
  track_lost: '轨迹消失',
  source_started: '画面源启动',
  source_ended: '画面源结束',
  source_error: '画面源错误',
  left: '离开（自动恢复）',
}

export type Video = { name: string; path: string; duration_s: number; width: number; height: number }
export type Person = {
  person_id: string
  name: string
  role: string | null
  role_label: string
  has_face_data: boolean
  templates: number
  has_photo?: boolean
  joined_at?: string
}
export type BossEvent = {
  type: string
  source_id?: string
  pts: number
  wall_time: number
  role?: string | null
  data: Record<string, unknown> & { name?: string; person_id?: string; similarity?: number; role?: string }
}
export type Thumb = { sample_id: number; track_id: number; pts: number; quality_ok: boolean; width: number }
export type Cluster = {
  id: number
  size: number
  status: string
  person_id: string | null
  name: string | null
  role: string | null
  tracks: number[]
  quality_ok: number
  time_range: [number, number]
  known_person_id: string | null
  known_similarity: number
  known_name?: string
  cover_sample_id: number
  thumbs: Thumb[]
}
export type Capture = {
  id: string
  status: string
  error: string | null
  progress: number
  source: { kind: string; uri: string }
  stats: Record<string, number>
  created_at: number
  clusters: Cluster[]
  noise_count: number
}
