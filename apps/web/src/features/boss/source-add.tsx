import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, CirclePlay, FileVideo, MonitorPlay, Plus, Repeat2, RotateCw, Square, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, errMsg } from '@/lib/api'
import { MobilePreview } from './mobile-preview'
import { SourcePicker, type SourceValue } from './source-picker'

type PipelineStatus = { pipelines: { name: string; running: boolean }[]; max_sources: number }

const NAME_PRESETS = ['门口', '桌面', '走廊', '笔记本摄像头']

export function SourceAdd() {
  const qc = useQueryClient()
  const [name, setName] = useState('门口')
  const [src, setSrc] = useState<SourceValue>({ kind: 'file', uri: '' })
  const [loop, setLoop] = useState(true)
  const [res, setRes] = useState('1280x720')
  const [autoPreview, setAutoPreview] = useState<string | null>(null)
  const { data: status } = useQuery({
    queryKey: ['pipeline'],
    queryFn: async () => (await api.get<PipelineStatus>('/pipeline/status')).data ?? { pipelines: [], max_sources: 4 },
    refetchInterval: 1500,
  })
  const cleanName = name.trim()
  const items = status?.pipelines ?? []
  const exists = items.some((p) => p.name === cleanName)
  const start = useMutation({
    mutationFn: async () => {
      const [width, height] = res.split('x').map(Number)
      return (await api.post('/pipeline/start', { ...src, loop, width, height, name: cleanName })).data
    },
    onSuccess: () => {
      toast.success(`画面源「${cleanName}」已启动`)
      setAutoPreview(cleanName)
      qc.setQueryData(['pipeline'], (old: PipelineStatus | undefined) => {
        const cur = old ?? { pipelines: [], max_sources: 4 }
        const pipelines = cur.pipelines.some((p) => p.name === cleanName)
          ? cur.pipelines.map((p) => (p.name === cleanName ? { ...p, running: true } : p))
          : [...cur.pipelines, { name: cleanName, running: true }]
        return { ...cur, pipelines }
      })
      qc.invalidateQueries({ queryKey: ['pipeline'] })
      qc.invalidateQueries({ queryKey: ['source-names'] })
      qc.invalidateQueries({ queryKey: ['status'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const refresh = () => qc.invalidateQueries({ queryKey: ['pipeline'] })
  const stop = useMutation({
    mutationFn: async (n: string) => (await api.post('/pipeline/stop', null, { params: { name: n } })).data,
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  })
  const restart = useMutation({
    mutationFn: async (n: string) => (await api.post('/pipeline/restart', null, { params: { name: n } })).data,
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <div className='grid gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'><MonitorPlay className='size-5' aria-hidden />添加画面源</CardTitle>
          <CardDescription>添加并启动立即生效，不需要保存设置。同名会替换原画面源并使原手机预览失效；开机自动使用的源请在「默认画面源」配置。</CardDescription>
        </CardHeader>
        <CardContent className='grid gap-4'>
          <div className='grid gap-1.5'>
            <Label htmlFor='src-name'><Tag className='size-4' aria-hidden />名称</Label>
            <Input id='src-name' value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder='如：门口、桌面' />
            <div className='flex flex-wrap gap-1'>
              {NAME_PRESETS.map((n) => (
                <Button key={n} type='button' size='sm' variant='ghost' className='h-6 px-2 text-xs' onClick={() => setName(n)}>{n}</Button>
              ))}
            </div>
          </div>
          <SourcePicker value={src} onChange={setSrc} />
          {src.kind === 'camera' && !src.uri.startsWith('push://') && (
            <div className='grid gap-1.5'>
              <Label htmlFor='source-resolution'><Camera className='size-4' aria-hidden />分辨率</Label>
              <Select value={res} onValueChange={setRes}>
                <SelectTrigger id='source-resolution' className='w-full'><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value='640x480'>640×480</SelectItem>
                  <SelectItem value='1280x720'>1280×720（推荐）</SelectItem>
                  <SelectItem value='1920x1080'>1920×1080</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {src.kind === 'file' && <div className='flex items-center gap-2'>
            <Switch id='source-loop' checked={loop} onCheckedChange={setLoop} />
            <Label htmlFor='source-loop'><Repeat2 className='size-4' aria-hidden />文件循环播放</Label>
          </div>}
          <div className='flex flex-wrap items-center gap-3'>
            <Button disabled={!cleanName || !src.uri.trim() || start.isPending} onClick={() => start.mutate()}>
              {exists ? <CirclePlay aria-hidden /> : <Plus aria-hidden />}
              {start.isPending ? '正在启动…' : exists ? `替换「${cleanName}」并启动` : '添加并启动'}
            </Button>
            <span className='flex items-center gap-1.5 text-xs text-muted-foreground'><FileVideo className='size-3.5' aria-hidden />支持摄像头、网络流与视频文件</span>
          </div>
        </CardContent>
      </Card>
      {items.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>已启动的画面源</CardTitle>
            <CardDescription>停止、重启或手机扫码预览。电脑不显示实时画面。</CardDescription>
          </CardHeader>
          <CardContent className='grid gap-2'>
            {items.map((p) => (
              <div key={p.name} className='flex flex-wrap items-center justify-between gap-2 rounded-md border p-3'>
                <div>
                  <div className='font-medium'>{p.name}</div>
                  <p className='text-xs text-muted-foreground'>{p.running ? '运行中' : '已停止'}</p>
                </div>
                <div className='flex items-center gap-1'>
                  <Button size='icon' variant='ghost' className='size-7' title='重启' onClick={() => restart.mutate(p.name)}>
                    <RotateCw />
                  </Button>
                  <Button size='icon' variant='ghost' className='size-7' title='停止' onClick={() => stop.mutate(p.name)}>
                    <Square />
                  </Button>
                  <MobilePreview source={p.name} disabled={!p.running} autoOpen={autoPreview === p.name} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
