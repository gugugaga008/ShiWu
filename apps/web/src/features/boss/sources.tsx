import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, MonitorPlay, RotateCw, Settings2, Square } from 'lucide-react'
import { useSettingsDialog } from '@/hooks/use-settings-dialog'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, errMsg, ROLE_LABEL, ROLE_VARIANT } from '@/lib/api'
import { cn } from '@/lib/utils'
import { EventsTable } from './events-table'
import { type LiveFace, useLive } from './live'
import { MobilePreview } from './mobile-preview'
import { Page } from './page'

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
  const { events, connected } = useLive()
  const { data: st } = useQuery({
    queryKey: ['pipeline'],
    queryFn: async () => (await api.get<PStatus>('/pipeline/status')).data,
    refetchInterval: 1500,
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['pipeline'] })
  const stop = useMutation({
    mutationFn: async (n?: string) => (await api.post('/pipeline/stop', null, { params: n ? { name: n } : {} })).data,
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  })
  const restart = useMutation({
    mutationFn: async (n: string) => (await api.post('/pipeline/restart', null, { params: { name: n } })).data,
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  })
  const items = st?.pipelines ?? []
  const shownEvents = events.filter((e) => e.type !== 'frame_result').slice(0, 12)
  return (
    <Page title='画面源' desc='查看各路状态、识别结果与手机预览；添加画面源请前往设置'>
      <div className='mb-4 flex justify-end'>
        <Button variant='outline' onClick={() => useSettingsDialog.getState().openSection('sources')}><Settings2 aria-hidden />管理画面源</Button>
      </div>
      <div className='grid gap-4'>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between'>
            <div>
              <CardTitle className='flex items-center gap-2'><MonitorPlay className='size-5' aria-hidden />画面源状态 · 手机扫码预览</CardTitle>
              <CardDescription>
                {items.length ? `运行中 ${items.filter((p) => p.running).length}/${items.length} 路 · 上限 ${st?.max_sources ?? 4} 路 · 共享一个识别引擎` : '没有运行中的画面源'}
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
              <div className='grid min-h-60 justify-items-center content-center gap-3 rounded-md bg-muted/40 text-sm text-muted-foreground'>
                <MonitorPlay className='size-10' aria-hidden />
                <p>暂无画面源，先到设置添加并启动</p>
                <Button variant='outline' onClick={() => useSettingsDialog.getState().openSection('sources')}><Settings2 aria-hidden />前往设置添加</Button>
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
      </div>
      <Card className='mt-4'>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'><Activity className='size-5' aria-hidden />实时事件</CardTitle>
        </CardHeader>
        <CardContent>
          <EventsTable events={shownEvents} />
        </CardContent>
      </Card>
    </Page>
  )
}
