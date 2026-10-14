import { useId, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Camera, FileVideo, Link2, RefreshCw, Shapes } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export type SourceValue = { kind: 'file' | 'url' | 'camera'; uri: string }
type Cam = { id: string; name: string; path: string; busy?: string | null; fake?: boolean }
type Cams = { devices: Cam[]; push: { id: string; name: string }[] }

const ALL_KINDS: SourceValue['kind'][] = ['camera', 'file', 'url']
const VIDEO_NAME = /\.(mp4|mov|mkv|avi|webm|m4v)$/i

function localPath(file: File) {
  const path = (file as File & { path?: string }).path
  return typeof path === 'string' && path ? path : ''
}

function pickVideo(files: FileList | File[]) {
  return [...files].find((file) => file.type.startsWith('video/') || VIDEO_NAME.test(file.name))
}

export function SourcePicker({ value, onChange, kinds = ALL_KINDS }: { value: SourceValue; onChange: (v: SourceValue) => void; kinds?: SourceValue['kind'][] }) {
  const id = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const electron = typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent)
  const cams = useQuery({
    queryKey: ['cameras'],
    enabled: kinds.includes('camera') && value.kind === 'camera',
    queryFn: async () => (await api.get<Cams>('/sources/cameras')).data,
  })
  const applyVideo = (file: File) => {
    const path = localPath(file)
    onChange({ ...value, uri: path || file.name })
  }
  return (
    <div className='grid gap-3 sm:grid-cols-[150px_1fr]'>
      <div className='grid gap-1.5'>
        <Label htmlFor={`${id}-kind`}><Shapes className='size-4' aria-hidden />源类型</Label>
        <Select value={value.kind} onValueChange={(k) => onChange({ kind: k as SourceValue['kind'], uri: '' })}>
          <SelectTrigger id={`${id}-kind`} className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kinds.includes('camera') && <SelectItem value='camera'><Camera className='size-4' aria-hidden />摄像头</SelectItem>}
            {kinds.includes('file') && <SelectItem value='file'><FileVideo className='size-4' aria-hidden />本地视频文件</SelectItem>}
            {kinds.includes('url') && <SelectItem value='url'><Link2 className='size-4' aria-hidden />网络流 URL</SelectItem>}
          </SelectContent>
        </Select>
      </div>
      <div className='grid gap-1.5'>
        <Label htmlFor={`${id}-uri`}>{value.kind === 'file' ? <FileVideo className='size-4' aria-hidden /> : value.kind === 'camera' ? <Camera className='size-4' aria-hidden /> : <Link2 className='size-4' aria-hidden />}{value.kind === 'file' ? '视频文件' : value.kind === 'camera' ? '摄像头设备' : '流地址'}</Label>
        {value.kind === 'file' && (
          <div className='grid gap-2'>
            <div
              className={cn(
                'cursor-pointer rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground',
                dragging && 'border-primary bg-primary/5 text-foreground',
                value.uri && 'border-primary bg-primary/10 text-foreground',
              )}
              onClick={() => fileRef.current?.click()}
              onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                const file = pickVideo(event.dataTransfer.files)
                if (file) applyVideo(file)
              }}
            >
              <Input
                ref={fileRef}
                id={`${id}-uri`}
                type='file'
                accept='video/*,.mp4,.mov,.mkv,.avi,.webm,.m4v'
                className='sr-only'
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => {
                  const file = pickVideo(event.target.files ?? [])
                  if (file) applyVideo(file)
                }}
              />
              <p>{value.uri ? `已选择 ${value.uri.split(/[\\/]/).pop()}` : '点击选择或拖放视频到此处'}</p>
            </div>
            <Input aria-label='视频文件完整路径' placeholder='或粘贴本机视频文件完整路径' value={value.uri} onChange={(e) => onChange({ ...value, uri: e.target.value })} />
          </div>
        )}
        {value.kind === 'url' && (
          <Input
            id={`${id}-uri`}
            placeholder='rtsp://… / http://….m3u8 / http://….mp4'
            value={value.uri}
            onChange={(e) => onChange({ ...value, uri: e.target.value })}
          />
        )}
        {value.kind === 'camera' && (
          <div className='flex gap-2'>
            <Select value={value.uri} onValueChange={(uri) => onChange({ ...value, uri })}>
              <SelectTrigger id={`${id}-uri`} className='w-full'>
                <SelectValue placeholder={cams.isLoading ? '正在枚举设备…' : '选择摄像头'} />
              </SelectTrigger>
              <SelectContent>
                {electron
                  ? cams.data?.push.map((p) => (
                    <SelectItem key={p.id} value={p.id}>本机摄像头</SelectItem>
                  ))
                  : cams.data?.devices.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{c.busy ? ` · 正被「${c.busy}」使用` : ''}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <Button variant='outline' size='icon' aria-label='重新枚举摄像头' title='重新枚举' onClick={() => cams.refetch()}>
              <RefreshCw />
            </Button>
          </div>
        )}
        {value.kind === 'camera' && cams.data && (electron ? cams.data.push : cams.data.devices).length === 0 && (
          <span className='text-xs text-muted-foreground'>{electron ? '未发现本机摄像头' : '未发现摄像头设备'}</span>
        )}
      </div>
    </div>
  )
}
