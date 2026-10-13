import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type Video } from '@/lib/api'

export type SourceValue = { kind: 'file' | 'url' | 'camera'; uri: string }
type Cam = { id: string; name: string; path: string; busy?: string | null; fake?: boolean }
type Cams = { devices: Cam[]; push: { id: string; name: string }[] }

export function SourcePicker({ value, onChange }: { value: SourceValue; onChange: (v: SourceValue) => void }) {
  const { data: videos = [] } = useQuery({
    queryKey: ['videos'],
    queryFn: async () => (await api.get<Video[]>('/sources/videos')).data,
  })
  const cams = useQuery({
    queryKey: ['cameras'],
    enabled: value.kind === 'camera',
    queryFn: async () => (await api.get<Cams>('/sources/cameras')).data,
  })
  return (
    <div className='grid gap-3 sm:grid-cols-[150px_1fr]'>
      <div className='grid gap-1.5'>
        <Label>源类型</Label>
        <Select value={value.kind} onValueChange={(k) => onChange({ kind: k as SourceValue['kind'], uri: '' })}>
          <SelectTrigger className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='camera'>摄像头</SelectItem>
            <SelectItem value='file'>本地视频文件</SelectItem>
            <SelectItem value='url'>网络流 URL</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className='grid gap-1.5'>
        <Label>{value.kind === 'file' ? '视频文件' : value.kind === 'camera' ? '摄像头设备' : '流地址'}</Label>
        {value.kind === 'file' && (
          <Select value={value.uri} onValueChange={(uri) => onChange({ ...value, uri })}>
            <SelectTrigger className='w-full'>
              <SelectValue placeholder='选择视频' />
            </SelectTrigger>
            <SelectContent>
              {videos.map((v) => (
                <SelectItem key={v.path} value={v.path}>
                  {v.name} · {v.duration_s}s · {v.width}×{v.height}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {value.kind === 'url' && (
          <Input
            placeholder='rtsp://… / http://….m3u8 / http://….mp4'
            value={value.uri}
            onChange={(e) => onChange({ ...value, uri: e.target.value })}
          />
        )}
        {value.kind === 'camera' && (
          <div className='flex gap-2'>
            <Select value={value.uri} onValueChange={(uri) => onChange({ ...value, uri })}>
              <SelectTrigger className='w-full'>
                <SelectValue placeholder={cams.isLoading ? '正在枚举设备…' : '选择摄像头'} />
              </SelectTrigger>
              <SelectContent>
                {cams.data?.push.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
                {cams.data?.devices.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}（服务端 OpenCV · {c.path}）{c.busy ? ` · 正被「${c.busy}」使用` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant='outline' size='icon' title='重新枚举' onClick={() => cams.refetch()}>
              <RefreshCw />
            </Button>
          </div>
        )}
        {value.kind === 'camera' && cams.data && cams.data.devices.length === 0 && (
          <span className='text-xs text-muted-foreground'>服务端未发现本地摄像头设备；可用「桌面端摄像头」（需在识务桌面端中运行）。</span>
        )}
      </div>
    </div>
  )
}
