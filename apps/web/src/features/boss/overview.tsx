import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, Database, Pause, Play, ScanFace, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { api, type BossEvent, ROLE_LABEL } from '@/lib/api'
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
  const p = data?.pipeline
  const paused = !!mon?.paused
  const running = !!p?.running
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
            <p className='text-xs text-muted-foreground'>识务 · 本地 127.0.0.1:7400</p>
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
              {paused ? '画面采集已停止' : running ? `已触发 ${mon?.fired ?? 0} 次` : '到设置添加画面源后开始监控'}
            </p>
            {(running || paused) && (
              <Button size='sm' className='mt-2' variant={paused ? 'default' : 'outline'} onClick={() => toggle.mutate()}>
                {paused ? <Play /> : <Pause />} {paused ? '恢复监控' : '暂停监控'}
              </Button>
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
