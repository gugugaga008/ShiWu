import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, CirclePlay, FileVideo, MonitorPlay, Plus, Repeat2, Tag } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, errMsg } from '@/lib/api'
import { SourcePicker, type SourceValue } from './source-picker'

type PipelineStatus = { pipelines: { name: string; running: boolean }[]; max_sources: number }

export function SourceAdd() {
  const qc = useQueryClient()
  const [name, setName] = useState('门口')
  const [src, setSrc] = useState<SourceValue>({ kind: 'file', uri: '' })
  const [loop, setLoop] = useState(true)
  const [res, setRes] = useState('1280x720')
  const { data: status } = useQuery({
    queryKey: ['pipeline'],
    queryFn: async () => (await api.get<PipelineStatus>('/pipeline/status')).data,
    refetchInterval: 1500,
  })
  const cleanName = name.trim()
  const exists = status?.pipelines.some((p) => p.name === cleanName) ?? false
  const start = useMutation({
    mutationFn: async () => {
      const [width, height] = res.split('x').map(Number)
      return (await api.post('/pipeline/start', { ...src, loop, width, height, name: cleanName })).data
    },
    onSuccess: () => {
      toast.success(`画面源「${cleanName}」已启动`)
      qc.invalidateQueries({ queryKey: ['pipeline'] })
      qc.invalidateQueries({ queryKey: ['source-names'] })
      qc.invalidateQueries({ queryKey: ['status'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'><MonitorPlay className='size-5' aria-hidden />添加画面源</CardTitle>
        <CardDescription>添加并启动立即生效，不需要保存设置。同名会替换原画面源并使原手机预览失效；开机自动使用的源请在「默认画面源」配置。</CardDescription>
      </CardHeader>
      <CardContent className='grid gap-4'>
        <div className='grid gap-1.5'>
          <Label htmlFor='src-name'><Tag className='size-4' aria-hidden />名称</Label>
          <Input id='src-name' value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder='如：门口、桌面' />
          <div className='flex gap-1'>
            {['门口', '桌面', '走廊'].map((n) => (
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
  )
}
