import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, RotateCw, Square } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, errMsg, ROLE_LABEL, ROLE_VARIANT } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EventsTable } from './events-table'
import { type LiveFace, useLive } from './live'
import { MobilePreview } from './mobile-preview'
import { Page } from './page'
import { SourcePicker, type SourceValue } from './source-picker'

type PItem = {
  name: string
  running: boolean
  error?: string | null
  source: { name: string; kind: string; uri: string; adaptive?: boolean }
  stats: Record<string, number> | null
  faces: LiveFace[]
}
type PStatus = { running: boolean; pipelines: PItem[]; max_sources: number }

const KIND_LABEL: Record<string, string> = { file: '文件', url: '网络流', camera: '摄像头' }
const srcLabel = (s: PItem['source']) =>
  s.uri.startsWith('push://') ? '桌面端摄像头' : `${KIND_LABEL[s.kind] ?? s.kind} · ${s.uri.split('/').pop()}`

function FaceBadges({ faces }: { faces: LiveFace[] }) {
  return (
    <div className='flex min-h-6 flex-wrap gap-1.5'>
      {faces.map((f) => (
        <Badge key={f.track_id} variant={f.role ? ROLE_VARIANT[f.role] : 'outline'}>
          #{f.track_id} {f.name ?? '陌生人'}
          {f.role ? ` · ${ROLE_LABEL[f.role] ?? f.role}` : ''}
          {f.person_id ? ` · ${f.similarity.toFixed(2)}` : ''}
        </Badge>
      ))}
    </div>
  )
}

export function Sources() {
  const qc = useQueryClient()
  const [name, setName] = useState('门口')
  const [src, setSrc] = useState<SourceValue>({ kind: 'file', uri: '' })
  const [loop, setLoop] = useState(true)
  const [res, setRes] = useState('1280x720')
  const { events, connected } = useLive()
  const { data: st } = useQuery({
    queryKey: ['pipeline'],
    queryFn: async () => (await api.get<PStatus>('/pipeline/status')).data,
    refetchInterval: 1500,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['pipeline'] })
  const start = useMutation({
    mutationFn: async () => {
      const [width, height] = res.split('x').map(Number)
      return (await api.post('/pipeline/start', { ...src, loop, width, height, name: name.trim() || '主画面' })).data
    },
    onSuccess: () => {
      toast.success(`「${name}」已启动`)
      refresh()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const stop = useMutation({
    mutationFn: async (n?: string) => (await api.post('/pipeline/stop', null, { params: n ? { name: n } : {} })).data,
    onSuccess: refresh,
  })
  const restart = useMutation({
    mutationFn: async (n: string) => (await api.post('/pipeline/restart', null, { params: { name: n } })).data,
    onSuccess: refresh,
  })
  const items = st?.pipelines ?? []
  const exists = items.some((p) => p.name === name.trim())
  const shownEvents = events.filter((e) => e.type !== 'frame_result').slice(0, 12)
  return (
    <Page title='视频源' desc='可同时监控多路视频源（摄像头 / 网络摄像头 / 文件），各自命名，规则可按源限定'>
      <div className='grid gap-4 xl:grid-cols-[1fr_360px]'>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between'>
            <div>
              <CardTitle>视频源状态 · 手机扫码预览</CardTitle>
              <CardDescription>
                {items.length ? `运行中 ${items.filter((p) => p.running).length}/${items.length} 路 · 上限 ${st?.max_sources ?? 4} 路 · 共享一个识别引擎` : '没有运行中的视频源'}
              </CardDescription>
            </div>
            <div className='flex items-center gap-2'>
              <Badge variant={connected ? 'secondary' : 'outline'}>{connected ? '推送已连接' : '推送未连接'}</Badge>
              {items.length > 1 && (
                <Button size='sm' variant='outline' onClick={() => stop.mutate(undefined)}>
                  <Square /> 全部停止
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {items.length === 0 ? (
              <div className='flex aspect-video items-center justify-center rounded-md bg-muted text-sm text-muted-foreground'>
                在右侧添加视频源后，通过手机扫码查看画面
              </div>
            ) : (
              <div className={cn('grid gap-3', items.length > 1 && 'md:grid-cols-2')}>
                {items.map((p) => {
                  return (
                    <div key={p.name} className='overflow-hidden rounded-lg border'>
                      <div className='flex items-center justify-between gap-2 border-b bg-muted/40 px-3 py-1.5'>
                        <div className='min-w-0'>
                          <span className='font-medium'>{p.name}</span>
                          <span className='ms-2 truncate text-xs text-muted-foreground'>{srcLabel(p.source)}</span>
                        </div>
                        <div className='flex shrink-0 items-center gap-1'>
                          <Badge variant={p.running ? 'secondary' : 'outline'} className='text-xs'>
                            {p.running ? (p.stats?.target_fps ? `${p.stats.target_fps} fps` : '运行中') : '已结束'}
                          </Badge>
                          <Button size='icon' variant='ghost' className='size-7' title='重启' onClick={() => restart.mutate(p.name)}>
                            <RotateCw />
                          </Button>
                          <Button size='icon' variant='ghost' className='size-7' title='停止' onClick={() => stop.mutate(p.name)}>
                            <Square />
                          </Button>
                        </div>
                      </div>
                      <div className='grid justify-items-center gap-3 bg-muted/20 px-3 py-8'>
                        <p className='text-sm text-muted-foreground'>{p.error ?? '实时画面仅在手机上查看'}</p>
                        <MobilePreview source={p.name} disabled={!p.running} />
                      </div>
                      <div className='space-y-1 p-2'>
                        <FaceBadges faces={p.faces} />
                        {p.stats && (
                          <p className='text-xs text-muted-foreground'>
                            已处理 {p.stats.frames_processed} 帧 · {p.stats.avg_proc_ms}ms/帧
                            {p.error ? ` · ${p.error}` : ''}
                          </p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
        <Card className='content-start'>
          <CardHeader>
            <CardTitle>添加视频源</CardTitle>
            <CardDescription>同名则替换；摄像头可用服务端直连设备或桌面端推流</CardDescription>
          </CardHeader>
          <CardContent className='grid gap-4'>
            <div className='grid gap-1.5'>
              <Label htmlFor='src-name'>名称</Label>
              <Input id='src-name' value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder='如：门口、桌面' />
              <div className='flex gap-1'>
                {['门口', '桌面', '走廊'].map((n) => (
                  <Button key={n} type='button' size='sm' variant='ghost' className='h-6 px-2 text-xs' onClick={() => setName(n)}>
                    {n}
                  </Button>
                ))}
              </div>
            </div>
            <SourcePicker value={src} onChange={setSrc} />
            {src.kind === 'camera' && !src.uri.startsWith('push://') && (
              <div className='grid gap-1.5'>
                <Label>分辨率</Label>
                <Select value={res} onValueChange={setRes}>
                  <SelectTrigger className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='640x480'>640×480</SelectItem>
                    <SelectItem value='1280x720'>1280×720（推荐）</SelectItem>
                    <SelectItem value='1920x1080'>1920×1080</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className='flex items-center gap-2'>
              <Switch id='loop' checked={loop} onCheckedChange={setLoop} />
              <Label htmlFor='loop'>文件循环播放</Label>
            </div>
            <Button disabled={!src.uri || start.isPending} onClick={() => start.mutate()}>
              <Plus /> {exists ? `替换「${name}」` : `添加「${name || '主画面'}」并启动`}
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card className='mt-4'>
        <CardHeader>
          <CardTitle>实时事件</CardTitle>
        </CardHeader>
        <CardContent>
          <EventsTable events={shownEvents} />
        </CardContent>
      </Card>
    </Page>
  )
}
