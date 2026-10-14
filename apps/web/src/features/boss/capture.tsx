import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Folder, Merge, Radio, Split, UserRound, Users, Video } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type Capture, type Cluster, type Person, errMsg, ROLE_LABEL, ROLE_VARIANT, withToken } from '@/lib/api'
import { SourcePicker, type SourceValue } from './source-picker'

const STATUS: Record<string, string> = {
  created: '准备中',
  recording: '录制分析中',
  clustering: '聚类中',
  ready: '待标记',
  error: '出错',
  cancelled: '已取消',
}

type PipelineStatus = { pipelines: { running: boolean; source: { kind: string; uri: string } }[] }
const sourceName = (uri: string) => (uri.startsWith('push://') ? '本机摄像头' : uri.split('/').pop() || uri)

export function CaptureWorkspace({ mode, targetPerson }: { mode: 'file' | 'live'; targetPerson?: Person }) {
  const qc = useQueryClient()
  const kinds: SourceValue['kind'][] = mode === 'file' ? ['file'] : ['camera', 'url']
  const [src, setSrc] = useState<SourceValue>({ kind: mode === 'file' ? 'file' : 'camera', uri: '' })
  const [duration, setDuration] = useState(15)
  const [sid, setSid] = useState<string | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const filledCam = useRef(false)

  const { data: pipelines } = useQuery({
    queryKey: ['pipeline'],
    enabled: mode === 'live',
    queryFn: async () => (await api.get<PipelineStatus>('/pipeline/status')).data ?? { pipelines: [] },
  })
  useEffect(() => {
    if (mode !== 'live' || filledCam.current || src.kind !== 'camera' || src.uri) return
    const cam = pipelines?.pipelines?.find((p) => p.running && p.source.kind === 'camera')
    if (!cam?.source.uri) return
    filledCam.current = true
    setSrc({ kind: 'camera', uri: cam.source.uri })
  }, [mode, pipelines, src.kind, src.uri])

  const { data: list = [] } = useQuery({
    queryKey: ['captures'],
    queryFn: async () => (await api.get<Capture[]>('/captures')).data,
  })
  const sessions = list.filter((session) => kinds.includes(session.source.kind as SourceValue['kind']))
  const current = sid ?? sessions[0]?.id ?? null
  const { data: cap } = useQuery({
    queryKey: ['capture', current],
    enabled: !!current,
    queryFn: async () => (await api.get<Capture>(`/captures/${current}`)).data,
    refetchInterval: (q) => (['ready', 'error', 'cancelled'].includes(q.state.data?.status ?? '') ? false : 1000),
  })
  const { data: people = [] } = useQuery({
    queryKey: ['people'],
    enabled: cap?.status === 'ready',
    queryFn: async () => (await api.get<Person[]>('/people')).data,
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['capture', current] })
    qc.invalidateQueries({ queryKey: ['people'] })
    qc.invalidateQueries({ queryKey: ['status'] })
  }

  const start = useMutation({
    mutationFn: async () => {
      if (!kinds.includes(src.kind)) throw new Error('当前添加方式不支持此画面源')
      return (await api.post<Capture>('/captures', { ...src, duration_s: duration })).data
    },
    onSuccess: (c) => {
      qc.setQueryData(['capture', c.id], c)
      setSid(c.id)
      setSelected([])
      qc.invalidateQueries({ queryKey: ['captures'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const cancel = useMutation({
    mutationFn: async () => (await api.delete(`/captures/${current}`)).data,
    onSuccess: () => {
      setSid(null)
      qc.removeQueries({ queryKey: ['capture', current] })
      qc.invalidateQueries({ queryKey: ['captures'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const merge = useMutation({
    mutationFn: async () => (await api.post(`/captures/${current}/merge`, { cluster_ids: selected })).data,
    onSuccess: () => {
      setSelected([])
      toast.success('已合并')
      refresh()
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  const pending = cap?.clusters.filter((c) => c.status === 'pending').length ?? 0
  const inFlight = !!cap && ['created', 'recording', 'clustering'].includes(cap.status)
  const busy = start.isPending || inFlight
  const validDuration = Number.isFinite(duration) && duration >= 3 && duration <= 120
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2'>
            {mode === 'file' ? <Video className='size-5' /> : <Camera className='size-5' />}
            {mode === 'file' ? '1. 视频文件添加：选择文件并分析' : '1. 现场采集添加：选择摄像头或网络流'}
          </CardTitle>
          <CardDescription>{targetPerson ? `正在为「${targetPerson.name}」补录；分析后可把候选合并到此人，不会改姓名或分组。` : '候选人物分别填写姓名与分组；切换添加方式不会中断当前任务。'}</CardDescription>
        </CardHeader>
        <CardContent className='grid gap-4 lg:grid-cols-[1fr_160px_auto] lg:items-end'>
          <SourcePicker value={src} onChange={setSrc} kinds={kinds} />
          <div className='grid gap-1.5'>
            <Label htmlFor={`capture-duration-${mode}`}>{mode === 'file' ? '分析时长（秒）' : '录制时长（秒）'}</Label>
            <Input id={`capture-duration-${mode}`} type='number' min={3} max={120} value={duration} onChange={(e) => setDuration(+e.target.value)} />
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button disabled={!src.uri.trim() || !kinds.includes(src.kind) || !validDuration || busy} onClick={() => start.mutate()}>
              <Radio /> {mode === 'file' ? '开始分析' : '开始采集'}
            </Button>
            {inFlight && (
              <Button variant='outline' disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                取消采集
              </Button>
            )}
          </div>
        </CardContent>
        {sessions.length > 1 && (
          <CardContent className='grid gap-1.5'>
            <Label htmlFor={`capture-session-${mode}`}>恢复采集任务</Label>
            <Select value={current ?? ''} onValueChange={(id) => { setSid(id); setSelected([]) }}>
              <SelectTrigger id={`capture-session-${mode}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                {sessions.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {sourceName(session.source.uri)} · {STATUS[session.status] ?? session.status} · {session.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        )}
        {cap && (
          <CardFooter className='flex flex-wrap gap-3 text-sm text-muted-foreground'>
            <Badge variant={cap.status === 'error' ? 'destructive' : 'secondary'}>{STATUS[cap.status] ?? cap.status}</Badge>
            {cap.status === 'recording' && (
              <span className='flex items-center gap-2'>
                <span className='h-2 w-32 overflow-hidden rounded-full bg-muted' aria-hidden>
                  <span className='block h-full bg-primary' style={{ width: `${Math.round(cap.progress * 100)}%` }} />
                </span>
                <span>进度 {Math.round(cap.progress * 100)}%</span>
              </span>
            )}
            <span>{sourceName(cap.source.uri)}</span>
            {cap.stats.samples != null && (
              <span>
                人脸样本 {cap.stats.samples} · 候选人物 {cap.clusters.length} · 噪声 {cap.noise_count}
              </span>
            )}
            {cap.error && <span className='text-destructive'>{cap.error}</span>}
          </CardFooter>
        )}
      </Card>

      {!cap && <div className='mt-6 flex items-center gap-2 text-sm text-muted-foreground'><Folder className='size-5' />尚无{mode === 'file' ? '视频分析' : '现场采集'}任务，请先选择画面源。</div>}
      {cap?.status === 'ready' && cap.clusters.length === 0 && (
        <div className='mt-6 flex items-center gap-2 text-sm text-muted-foreground'><Users className='size-5' />未发现候选人物，请更换视频或调整采集时长后重试。</div>
      )}
      {cap?.status === 'ready' && (
        <>
          <div className='mt-6 mb-3 flex items-center justify-between'>
            <h2 className='text-lg font-semibold'>2. 标记候选人物（待处理 {pending}）</h2>
            <Button variant='outline' disabled={selected.length < 2} onClick={() => merge.mutate()}>
              <Merge /> 合并选中（{selected.length}）
            </Button>
          </div>
          <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
            {cap.clusters.map((c) => (
              <ClusterCard
                key={`${cap.id}:${c.id}`}
                sid={cap.id}
                c={c}
                knownPerson={people.find((p) => p.person_id === c.known_person_id)}
                targetPerson={targetPerson}
                checked={selected.includes(c.id)}
                onCheck={(v) => setSelected((s) => (v ? [...s, c.id] : s.filter((x) => x !== c.id)))}
                onChanged={refresh}
              />
            ))}
          </div>
        </>
      )}
    </>
  )
}

function ClusterCard({
  sid,
  c,
  knownPerson,
  targetPerson,
  checked,
  onCheck,
  onChanged,
}: {
  sid: string
  c: Cluster
  knownPerson?: Person
  targetPerson?: Person
  checked: boolean
  onCheck: (v: boolean) => void
  onChanged: () => void
}) {
  const known = !!c.known_person_id
  const [name, setName] = useState(c.name ?? '')
  const [role, setRole] = useState(c.role && c.role !== 'ignore' ? c.role : 'boss')
  const [attach, setAttach] = useState(!!targetPerson || known)
  const [picked, setPicked] = useState<number[]>([])
  const done = c.status !== 'pending'
  const attachId = attach ? (targetPerson?.person_id ?? c.known_person_id) : undefined
  const attaching = !!attachId
  const knownName = targetPerson?.name ?? knownPerson?.name ?? c.known_name ?? c.known_person_id
  const knownGroup = ROLE_LABEL[targetPerson?.role ?? knownPerson?.role ?? ''] ?? '未设置'

  const confirm = useMutation({
    mutationFn: async (action: 'enroll' | 'ignore') =>
      (
        await api.post(`/captures/${sid}/clusters/${c.id}/confirm`, {
          action,
          ...(action === 'enroll'
            ? attaching && attachId
              ? { person_id: attachId }
              : { name: name.trim(), role }
            : { role: 'ignore' }),
        })
      ).data,
    onSuccess: (d, action) => {
      toast.success(action === 'ignore' ? '已忽略' : `已入库：${d.name}（分组：${ROLE_LABEL[d.role] ?? '未设置'}），模板 ${d.enrolled_templates?.length ?? 0} 张`)
      onChanged()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const split = useMutation({
    mutationFn: async () =>
      (await api.post(`/captures/${sid}/clusters/${c.id}/split`, picked.length ? { sample_ids: picked } : { by_track: true }))
        .data,
    onSuccess: () => {
      setPicked([])
      toast.success('已拆分')
      onChanged()
    },
    onError: (e) => toast.error(errMsg(e)),
  })

  return (
    <Card className={cn(done && 'opacity-70')}>
      <CardHeader className='flex flex-row items-start gap-3 space-y-0'>
        {!done && <Checkbox checked={checked} onCheckedChange={(v) => onCheck(!!v)} className='mt-1' />}
        <img
          src={withToken(`/captures/${sid}/samples/${c.cover_sample_id}.jpg`)}
          alt='封面'
          className='size-20 rounded-md object-cover'
        />
        <div className='grid flex-1 gap-1'>
          <CardTitle className='flex items-center gap-2'>
            <span>{c.status === 'enrolled' ? c.name || '未命名人员' : `候选人物 #${c.id}`}</span>
            {c.status === 'enrolled' && <Badge variant={ROLE_VARIANT[c.role ?? '']}>分组：{ROLE_LABEL[c.role ?? ''] ?? '未设置'} · 已入库</Badge>}
            {c.status === 'ignored' && <Badge variant='outline'>已忽略</Badge>}
          </CardTitle>
          <CardDescription>
            {c.size} 张 · 合格 {c.quality_ok} · 轨迹 {c.tracks.filter((t) => t >= 0).length} 条 · {c.time_range[0]}–{c.time_range[1]}s
          </CardDescription>
          {known ? (
            <span className='text-xs'>
              疑似已注册：<b>{knownName}</b>（{c.known_similarity.toFixed(2)}）
            </span>
          ) : (
            <span className='text-xs text-muted-foreground'>新面孔</span>
          )}
        </div>
      </CardHeader>
      <CardContent className='grid gap-3'>
        <div className='grid grid-cols-6 gap-1'>
          {c.thumbs.map((t) => (
            <button
              key={t.sample_id}
              type='button'
              disabled={done}
              onClick={() => setPicked((p) => (p.includes(t.sample_id) ? p.filter((x) => x !== t.sample_id) : [...p, t.sample_id]))}
              className={cn(
                'relative overflow-hidden rounded border-2',
                picked.includes(t.sample_id) ? 'border-primary' : 'border-transparent'
              )}
              title={`${t.pts}s · 轨迹 ${t.track_id}${t.quality_ok ? ' · 合格' : ''}`}
            >
              <img src={withToken(`/captures/${sid}/samples/${t.sample_id}.jpg`)} alt='' className='aspect-square w-full object-cover' />
              {t.quality_ok && <span className='absolute end-0.5 bottom-0.5 size-2 rounded-full bg-green-500' />}
            </button>
          ))}
        </div>
        {!done && (
          <div className='grid gap-2'>
            {attaching ? (
              <div className='grid gap-1 text-sm'>
                <span>姓名：{knownName}</span>
                <span>分组：{knownPerson ? knownGroup : '加载中…'}</span>
                <span className='text-xs text-muted-foreground'>仅补录人脸，不修改姓名或分组；如需修改，请到人员管理。</span>
              </div>
            ) : (
              <div className='grid grid-cols-[1fr_110px] gap-2'>
                <div className='grid gap-1.5'>
                  <Label htmlFor={`capture-name-${sid}-${c.id}`}><UserRound className='size-4' />姓名</Label>
                  <Input id={`capture-name-${sid}-${c.id}`} placeholder='请输入姓名，如 张三' value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className='grid gap-1.5'>
                  <Label htmlFor={`capture-group-${sid}-${c.id}`}><Users className='size-4' />分组</Label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger id={`capture-group-${sid}-${c.id}`} className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='boss'>老板</SelectItem>
                      <SelectItem value='leader'>领导</SelectItem>
                      <SelectItem value='staff'>同事</SelectItem>
                      <SelectItem value='whitelist'>白名单</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
            {(known || targetPerson) && (
              <label className='flex items-center gap-2 text-xs'>
                <Checkbox checked={attach} onCheckedChange={(v) => setAttach(!!v)} />
                补录到已有人员「{knownName}」（不勾选则新建独立人员）
              </label>
            )}
          </div>
        )}
      </CardContent>
      {!done && (
        <CardFooter className='flex flex-wrap gap-2'>
          <Button size='sm' disabled={(!attaching && !name.trim()) || confirm.isPending} onClick={() => confirm.mutate('enroll')}>
            {attaching ? '补录到此人员' : '确认姓名与分组并入库'}
          </Button>
          <Button size='sm' variant='outline' onClick={() => confirm.mutate('ignore')}>
            忽略
          </Button>
          <Button size='sm' variant='ghost' onClick={() => split.mutate()}>
            <Split /> {picked.length ? `拆出选中 ${picked.length} 张` : '按轨迹拆分'}
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}
