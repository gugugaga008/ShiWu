import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Activity, Database, Pause, Play, ScanFace, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useSettingsDialog } from '@/hooks/use-settings-dialog'
import { api, type BossEvent, errMsg, ROLE_LABEL } from '@/lib/api'
import { EventLogCard } from './eventlog'
import { Page } from './page'

type Status = {
  server: string
  pipeline: { running: boolean; source: { kind: string; uri: string } | null; stats: Record<string, number> | null }
  people: { total: number; with_face: number; by_role: Record<string, number> }
  gallery: { templates: number; persons: number }
  recent_events: BossEvent[]
}

export function Overview() {
  const qc = useQueryClient()
  const { data, isError } = useQuery({
    queryKey: ['status'],
    queryFn: async () => (await api.get<Status>('/status')).data,
    refetchInterval: 3000,
  })
  const { data: mon } = useQuery({
    queryKey: ['monitor'],
    queryFn: async () => (await api.get<{ paused: boolean; fired: number }>('/monitor')).data,
    refetchInterval: 3000,
  })
  const toggle = useMutation({
    mutationFn: async () => (await api.post(`/monitor/${mon?.paused ? 'resume' : 'pause'}`)).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['monitor'] })
      qc.invalidateQueries({ queryKey: ['status'] })
      qc.invalidateQueries({ queryKey: ['pipeline'] })
    },
  })
  const start = useMutation({
    mutationFn: async () => (await api.post<{ start_errors?: { name?: string; error: string }[] }>('/pipeline/start-defaults')).data,
    onSuccess: (result) => {
      if (result.start_errors?.length) {
        toast.error(`画面源启动失败：${result.start_errors.map((item) => `${item.name ?? ''} ${item.error}`).join('；')}`)
      } else {
        toast.success('监控已开始')
      }
      qc.invalidateQueries({ queryKey: ['monitor'] })
      qc.invalidateQueries({ queryKey: ['status'] })
      qc.invalidateQueries({ queryKey: ['pipeline'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => (await api.get<{ default_sources?: { name: string }[]; saved_sources?: { name: string }[] }>('/settings')).data,
  })
  const p = data?.pipeline
  const paused = !!mon?.paused
  const running = !!p?.running
  const hasDefault = (settings?.default_sources?.length ?? 0) > 0
  const hasSaved = (settings?.saved_sources?.length ?? 0) > 0
  const statusLabel = paused ? '已暂停' : running ? '监控中' : '未开始'
  return (
    <Page title='总览' desc='服务状态、已注册人员与事件日志'>
      <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardTitle className='text-sm font-medium'>识别服务</CardTitle>
            <Activity className='size-4 text-muted-foreground' />
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>
              {isError ? <span className='text-destructive'>离线</span> : data ? '运行中' : '…'}
            </div>
            <p className='text-xs text-muted-foreground'>识务 · 本地 {location.host}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardTitle className='text-sm font-medium'>监控状态</CardTitle>
            <ScanFace className='size-4 text-muted-foreground' />
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>{statusLabel}</div>
            <p className='text-xs text-muted-foreground'>
              {paused ? '画面采集已停止' : running ? `已触发 ${mon?.fired ?? 0} 次` : hasDefault ? '已配置默认画面源，点「开始监控」' : hasSaved ? '画面源已保存，可到画面源页启动' : '还没有画面源'}
            </p>
            {(running || paused) ? (
              <div className='mt-2 flex flex-wrap gap-2'>
                <Button size='sm' variant={paused ? 'default' : 'outline'} onClick={() => toggle.mutate()}>
                  {paused ? <Play /> : <Pause />} {paused ? '恢复监控' : '暂停监控'}
                </Button>
                <Button size='sm' variant='ghost' asChild><Link to='/sources'>画面源状态</Link></Button>
              </div>
            ) : (
              <div className='mt-2 flex flex-wrap gap-2'>
                {hasDefault && (
                  <Button size='sm' disabled={start.isPending} onClick={() => start.mutate()}>
                    <Play /> {start.isPending ? '正在启动…' : '开始监控'}
                  </Button>
                )}
                {hasSaved && !hasDefault && (
                  <Button size='sm' asChild><Link to='/sources'>选择画面源</Link></Button>
                )}
                <Button size='sm' variant={hasSaved ? 'outline' : 'default'} onClick={() => useSettingsDialog.getState().openSection('sources')}>
                  {hasSaved ? '管理画面源' : '添加画面源'}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardTitle className='text-sm font-medium'>已注册人数</CardTitle>
            <Users className='size-4 text-muted-foreground' />
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>{data?.people.total ?? '—'}</div>
            <div className='mt-1 flex flex-wrap gap-1'>
              {Object.entries(data?.people.by_role ?? {}).map(([k, v]) => (
                <Badge key={k} variant='outline'>
                  {ROLE_LABEL[k]} {v}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className='flex flex-row items-center justify-between pb-2'>
            <CardTitle className='text-sm font-medium'>人脸模板</CardTitle>
            <Database className='size-4 text-muted-foreground' />
          </CardHeader>
          <CardContent>
            <div className='text-2xl font-bold'>{data?.gallery.templates ?? '—'}</div>
            <p className='text-xs text-muted-foreground'>多照片库覆盖 {data?.gallery.persons ?? 0} 人</p>
          </CardContent>
        </Card>
      </div>
      <div className='mt-4'>
        <EventLogCard />
      </div>
    </Page>
  )
}
