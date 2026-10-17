import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ImagePlus, Upload, UserPlus, UserRound, Users, Video } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePhotoAdd } from '@/hooks/use-photo-add'
import { api, ROLE_LABEL, type Person } from '@/lib/api'
import { cn } from '@/lib/utils'
import { CaptureWorkspace } from './capture'
import { Page } from './page'
import { SnapshotDialog } from './snapshot-dialog'

type AddMode = 'photo' | 'file' | 'live'
const REASON_LABEL: Record<string, string> = {
  no_face: '没有检测到人脸',
  face_too_small: '人脸太小，请靠近一些或换更清晰的照片',
  too_close_to_edge: '人脸太靠边，请让人脸完整出现在画面里',
  low_detection_conf: '人脸不够清晰，请换一张',
  missing_landmarks: '五官不完整，请换正脸照片',
  not_frontal: '请使用正脸照片',
  head_tilted: '头部倾斜，请换一张正脸照片',
  landmarks_outside_box: '人脸不完整，请换一张',
  inconsistent_with_anchor: '与已登记照片差异较大，请确认是同一人',
}
const reasonText = (reason: string) => REASON_LABEL[reason.split('(')[0]] ?? '未通过人脸质量检查'

const MODES = [
  { value: 'photo', label: '照片添加', icon: ImagePlus },
  { value: 'file', label: '视频文件添加', icon: Video },
  { value: 'live', label: '现场采集添加', icon: Camera },
] as const

export function PeopleAdd({ initialMode = 'photo', personId }: { initialMode?: AddMode; personId?: string }) {
  const [selection, setSelection] = useState({ initialMode, mode: initialMode })
  const [visited, setVisited] = useState<Record<AddMode, boolean>>(() => ({
    photo: true, file: initialMode === 'file', live: initialMode === 'live',
  }))
  const { data: people = [] } = useQuery({
    queryKey: ['people'],
    queryFn: async () => (await api.get<Person[]>('/people')).data,
    enabled: !!personId,
  })
  const target = people.find((item) => item.person_id === personId)
  useEffect(() => {
    if (personId && target) usePhotoAdd.getState().beginSupplement(target)
    else if (!personId) {
      const draft = usePhotoAdd.getState()
      if (draft.supplementing && !draft.pending) draft.reset()
    }
    // 只按人员 ID 进入补录，避免人员列表刷新清空已选照片。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅跟随 personId
  }, [personId, target?.person_id])
  // 搜索参数导航仅切换可见工作区，不重建正在采集的组件。
  if (selection.initialMode !== initialMode) {
    setSelection({ initialMode, mode: initialMode })
    if (!visited[initialMode]) setVisited((current) => ({ ...current, [initialMode]: true }))
  }
  const mode = selection.initialMode === initialMode ? selection.mode : initialMode
  const select = (value: AddMode) => {
    setVisited((current) => (current[value] ? current : { ...current, [value]: true }))
    setSelection({ initialMode, mode: value })
  }
  return (
    <Page title={target ? `补录「${target.name}」` : '添加人员'} desc={target ? '可用照片或视频补录人脸，不会修改姓名或分组，也不会新建人员。' : '选择照片、视频文件或现场采集；姓名区分个人，分组用于分类。'}>
      {target && <p className='mb-4 text-sm'>正在为「{target.name}」补录，可切换照片或视频。</p>}
      <div role='group' aria-label='添加方式' className='mb-4 flex flex-wrap gap-2'>
        {MODES.map(({ value, label, icon: Icon }) => (
          <Button key={value} variant={mode === value ? 'default' : 'outline'} aria-pressed={mode === value} onClick={() => select(value)}>
            <Icon aria-hidden />{label}
          </Button>
        ))}
      </div>
      {/* 未进入过的采集工作区不挂载，避免照片添加页就去枚举/打开摄像头。 */}
      <section hidden={mode !== 'photo'} aria-label='照片添加工作区'><PhotoAdd /></section>
      {visited.file && <section hidden={mode !== 'file'} aria-label='视频文件添加工作区'><CaptureWorkspace mode='file' targetPerson={target} /></section>}
      {visited.live && <section hidden={mode !== 'live'} aria-label='现场采集添加工作区'><CaptureWorkspace mode='live' targetPerson={target} /></section>}
    </Page>
  )
}

function PhotoAdd() {
  const qc = useQueryClient()
  const { name, role, files, person, report, error, pending, creationUncertain, uploadUncertain, supplementing, update, submit, reset, resumePerson, clearUncertainUpload } = usePhotoAdd()
  const fileRef = useRef<HTMLInputElement>(null)
  const [verified, setVerified] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<{ url: string; name: string } | null>(null)
  const previews = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files])
  const fileLocked = pending || creationUncertain || uploadUncertain
  const { data: people = [] } = useQuery({ queryKey: ['people'], queryFn: async () => (await api.get<Person[]>('/people')).data, enabled: creationUncertain })
  const selected = people.find((item) => item.person_id === selectedId)
  useEffect(() => {
    if (!files.length && fileRef.current) fileRef.current.value = ''
  }, [files])
  useEffect(() => () => previews.forEach((url) => URL.revokeObjectURL(url)), [previews])
  const upload = async () => {
    await submit()
    qc.invalidateQueries({ queryKey: ['people'] })
    qc.invalidateQueries({ queryKey: ['status'] })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2'><UserPlus className='size-5' aria-hidden />照片添加人员</CardTitle>
        <CardDescription>填写姓名与分组，选择同一人的多张清晰照片。质量不合格的照片不会入库。</CardDescription>
      </CardHeader>
      <CardContent className='grid max-w-2xl gap-4'>
        <div className='grid gap-4 sm:grid-cols-[1fr_160px]'>
          <div className='grid gap-1.5'>
            <Label htmlFor='photo-person-name'><UserRound className='size-4' aria-hidden />姓名</Label>
            <Input id='photo-person-name' placeholder='请输入姓名，如 张三' maxLength={100} value={name} disabled={!!person || pending || creationUncertain} onChange={(event) => update({ name: event.target.value })} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='photo-person-group'><Users className='size-4' aria-hidden />分组</Label>
            <Select value={role} onValueChange={(value) => update({ role: value })} disabled={!!person || pending || creationUncertain}>
              <SelectTrigger id='photo-person-group'><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value='boss'>老板</SelectItem>
                <SelectItem value='leader'>领导</SelectItem>
                <SelectItem value='staff'>同事</SelectItem>
                <SelectItem value='whitelist'>白名单</SelectItem>
                <SelectItem value='ignore'>忽略</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='photo-person-files'><ImagePlus className='size-4' aria-hidden />人员照片（可多选）</Label>
          <div
            className={cn(
              'cursor-pointer rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground',
              dragging && 'border-primary bg-primary/5 text-foreground',
              files.length > 0 && 'border-primary bg-primary/10 text-foreground',
              fileLocked && 'pointer-events-none opacity-50',
            )}
            onClick={() => fileRef.current?.click()}
            onDragOver={(event) => { event.preventDefault(); if (!fileLocked) setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              if (fileLocked) return
              const images = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'))
              if (images.length) update({ files: images })
            }}
          >
            <Input ref={fileRef} id='photo-person-files' type='file' accept='image/*' multiple className='sr-only' disabled={fileLocked} onClick={(event) => event.stopPropagation()} onChange={(event) => update({ files: Array.from(event.target.files ?? []) })} />
            {previews.length ? (
              <div className='flex flex-wrap justify-center gap-2'>
                {previews.slice(0, 6).map((url, index) => (
                  <button key={url} type='button' title='查看大图' className='rounded-md focus-visible:ring-2 focus-visible:ring-ring'
                    onClick={(event) => {
                      event.stopPropagation()
                      setPreview({ url, name: files[index]?.name || `已选照片 ${index + 1}` })
                    }}>
                    <img src={url} alt={files[index]?.name || `已选照片 ${index + 1}`} className='size-28 rounded-md object-cover' />
                  </button>
                ))}
              </div>
            ) : <p>点击选择或拖放图片到此处</p>}
          </div>
          {files.length ? <p className='text-sm text-muted-foreground'>已选择 {files.length} 张：{files.slice(0, 5).map((file) => file.name).join('、')}{files.length > 5 ? '…' : ''}</p> : <p className='flex items-center gap-2 text-sm text-muted-foreground'><ImagePlus className='size-4' aria-hidden />尚未选择照片，请选择同一人的正脸及不同角度照片。</p>}
        </div>
        {person && !supplementing && <p className='text-sm'>当前人员：{person.name}。照片未通过时人员已保留，可更换照片重试，不会重复创建。</p>}
        {report && <p role='status' className='text-sm'>本次通过 {report.accepted} 张，拒绝 {report.rejected?.length ?? 0} 张。{supplementing && report.accepted > 0 && '可继续选择照片补录。'}</p>}
        {!!report?.rejected?.length && <p className='text-sm text-muted-foreground'>未通过：{report.rejected.slice(0, 5).map((item) => `${item.source ?? '照片'}（${item.reasons?.map(reasonText).join('、') || '质量不合格'}）`).join('；')}{report.rejected.length > 5 ? '…' : ''}</p>}
        {error && <p role='alert' className='text-sm text-destructive'>{error}</p>}
        {(creationUncertain || uploadUncertain) && <div className='grid gap-3 rounded-md border p-3'>
          <Button variant='outline' asChild><Link to='/people'>前往人员列表核对</Link></Button>
          <Label htmlFor='photo-result-verified'><Checkbox id='photo-result-verified' checked={verified} onCheckedChange={(value) => setVerified(value === true)} />我已核对人员及模板数量</Label>
          {creationUncertain ? <>
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger aria-label='核对后选择已有人员'><SelectValue placeholder='选择已创建的人员以继续补录' /></SelectTrigger>
              <SelectContent>{people.map((item) => <SelectItem key={item.person_id} value={item.person_id}>{item.name} · {ROLE_LABEL[item.role ?? ''] ?? item.role ?? '未分组'}</SelectItem>)}</SelectContent>
            </Select>
            <Button disabled={!verified || !selected} onClick={() => { if (selected) resumePerson(selected); setVerified(false); setSelectedId('') }}>使用所选人员继续补录</Button>
            <Button variant='outline' disabled={!verified} onClick={() => { reset(); setVerified(false); setSelectedId('') }}>已核对，重新填写</Button>
          </> : <Button disabled={!verified} onClick={() => { clearUncertainUpload(); setVerified(false) }}>已核对，选择新照片</Button>}
        </div>}
        <div className='flex flex-wrap gap-2'>
          <Button disabled={!name.trim() || !files.length || pending || creationUncertain || uploadUncertain} onClick={upload}>
            <Upload aria-hidden />{pending ? '正在上传…' : person ? (supplementing ? '补录照片' : '重试 / 补录照片') : '上传并添加人员'}
          </Button>
          {person && !supplementing && <Button variant='outline' disabled={pending || uploadUncertain} onClick={() => { reset(); setVerified(false); setSelectedId('') }}>添加下一位</Button>}
        </div>
      </CardContent>
      <SnapshotDialog
        open={!!preview}
        onOpenChange={(open) => { if (!open) setPreview(null) }}
        title={preview?.name ?? '已选照片'}
        description='上传前预览'
        imageSrc={preview?.url ?? null}
        imageAlt={preview?.name ?? '已选照片'}
      />
    </Card>
  )
}
