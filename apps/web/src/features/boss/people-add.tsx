import { useEffect, useRef, useState } from 'react'
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
import { CaptureWorkspace } from './capture'
import { Page } from './page'

type AddMode = 'photo' | 'file' | 'live'
const MODES = [
  { value: 'photo', label: '照片添加', icon: ImagePlus },
  { value: 'file', label: '视频文件添加', icon: Video },
  { value: 'live', label: '现场采集添加', icon: Camera },
] as const

export function PeopleAdd({ initialMode = 'photo' }: { initialMode?: AddMode }) {
  const [selection, setSelection] = useState({ initialMode, mode: initialMode })
  // 搜索参数导航仅切换可见工作区，不重建正在采集的组件。
  if (selection.initialMode !== initialMode) setSelection({ initialMode, mode: initialMode })
  const mode = selection.initialMode === initialMode ? selection.mode : initialMode
  return (
    <Page title='添加人员' desc='选择照片、视频文件或现场采集；姓名区分个人，分组用于分类。'>
      <div role='group' aria-label='添加方式' className='mb-4 flex flex-wrap gap-2'>
        {MODES.map(({ value, label, icon: Icon }) => (
          <Button key={value} variant={mode === value ? 'default' : 'outline'} aria-pressed={mode === value} onClick={() => setSelection({ initialMode, mode: value })}>
            <Icon aria-hidden />{label}
          </Button>
        ))}
      </div>
      {/* 保持工作区挂载，切换时保留上传结果、采集轮询和候选人物草稿。 */}
      <section hidden={mode !== 'photo'} aria-label='照片添加工作区'><PhotoAdd /></section>
      <section hidden={mode !== 'file'} aria-label='视频文件添加工作区'><CaptureWorkspace mode='file' /></section>
      <section hidden={mode !== 'live'} aria-label='现场采集添加工作区'><CaptureWorkspace mode='live' /></section>
    </Page>
  )
}

function PhotoAdd() {
  const qc = useQueryClient()
  const { name, role, files, person, report, error, pending, creationUncertain, uploadUncertain, update, submit, reset, resumePerson, clearUncertainUpload } = usePhotoAdd()
  const fileRef = useRef<HTMLInputElement>(null)
  const [verified, setVerified] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const { data: people = [] } = useQuery({ queryKey: ['people'], queryFn: async () => (await api.get<Person[]>('/people')).data, enabled: creationUncertain })
  const selected = people.find((item) => item.person_id === selectedId)
  useEffect(() => {
    if (!files.length && fileRef.current) fileRef.current.value = ''
  }, [files])
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
          <Input ref={fileRef} id='photo-person-files' type='file' accept='image/*' multiple disabled={pending || creationUncertain || uploadUncertain} onChange={(event) => update({ files: Array.from(event.target.files ?? []) })} />
          {files.length ? <p className='text-sm text-muted-foreground'>已选择 {files.length} 张：{files.slice(0, 5).map((file) => file.name).join('、')}{files.length > 5 ? '…' : ''}</p> : <p className='flex items-center gap-2 text-sm text-muted-foreground'><ImagePlus className='size-4' aria-hidden />尚未选择照片，请选择同一人的正脸及不同角度照片。</p>}
        </div>
        {person && <p className='text-sm'>当前人员：{person.name}。再次上传仅补录照片，不修改姓名或分组，不会重复创建人员。</p>}
        {report && <p role='status' className='text-sm'>本次通过 {report.accepted} 张，拒绝 {report.rejected?.length ?? 0} 张。{report.accepted > 0 && '可继续选择照片补录，或添加下一位。'}</p>}
        {!!report?.rejected?.length && <p className='text-sm text-muted-foreground'>未通过：{report.rejected.slice(0, 5).map((item) => `${item.source ?? '照片'}（${item.reasons?.join('、') || '质量不合格'}）`).join('；')}{report.rejected.length > 5 ? '…' : ''}</p>}
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
            <Upload aria-hidden />{pending ? '正在上传…' : person ? '重试 / 补录照片' : '上传并添加人员'}
          </Button>
          {person && <Button variant='outline' disabled={pending || uploadUncertain} onClick={() => { reset(); setVerified(false); setSelectedId('') }}>添加下一位</Button>}
        </div>
      </CardContent>
    </Card>
  )
}
