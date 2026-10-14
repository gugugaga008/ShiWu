import { useEffect, useState } from 'react'
import { useSettingsDialog } from '@/hooks/use-settings-dialog'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Mail, Plus, Save, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { api, errMsg } from '@/lib/api'
import { cn } from '@/lib/utils'
import { MobilePreview } from './mobile-preview'
import { Page } from './page'
import { SourcePicker, type SourceValue } from './source-picker'

type NamedSource = SourceValue & { name: string }
type Settings = {
  default_source: SourceValue | null
  default_sources: NamedSource[]
  max_sources: number
  snapshot_enabled: boolean
  snapshot_retention_days: number
  snapshots?: { count: number; bytes: number; encrypted: boolean }
  smtp_host: string
  smtp_port: number
  smtp_security: 'ssl' | 'starttls' | 'none'
  smtp_user: string
  smtp_from: string
  smtp_to: string[] | string
  smtp_verify_tls: boolean
  smtp_password_set?: boolean
  email_per_hour: number
  email_min_interval_s: number
  autostart: boolean
  auto_monitor: boolean
  adaptive: boolean
  active_fps: number
  idle_fps: number
  camera_width: number
  camera_height: number
}

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className='flex items-center justify-between gap-4 border-b py-3 last:border-0'>
      <div>
        <div className='font-medium'>{label}</div>
        {desc && <div className='text-sm text-muted-foreground'>{desc}</div>}
      </div>
      {children}
    </div>
  )
}

const MENU = [
  { label: '基础', items: [{ id: 'sources', label: '默认视频源' }, { id: 'startup', label: '启动' }] },
  { label: '监控与隐私', items: [{ id: 'preview', label: '手机扫码预览' }, { id: 'performance', label: '性能' }, { id: 'snapshots', label: '触发快照' }] },
  { label: '通知', items: [{ id: 'email', label: '邮件通知' }] },
] as const

type Section = typeof MENU[number]['items'][number]['id']

export function SettingsPage() {
  const setOpen = useSettingsDialog((s) => s.setOpen)
  useEffect(() => { setOpen(true) }, [setOpen])
  return (
    <Page title='设置' desc='按分类管理配置，实时画面仅在手机查看'>
      <Button onClick={() => setOpen(true)}>打开设置</Button>
    </Page>
  )
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl'>
        <DialogHeader className='shrink-0 border-b p-5'>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>选择分类下的二级菜单；更改后点击保存，关闭不会自动保存。</DialogDescription>
        </DialogHeader>
        {open && <SettingsForm />}
      </DialogContent>
    </Dialog>
  )
}

function PreviewSettings() {
  const { data, isError } = useQuery({
    queryKey: ['pipeline'],
    queryFn: async () => (await api.get<{ pipelines: { name: string; running: boolean }[] }>('/pipeline/status')).data,
    refetchInterval: 1500,
  })
  const pipelines = data?.pipelines ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>手机扫码预览</CardTitle>
        <CardDescription>隐藏二维码或关闭设置，手机仍可查看至本次会话到期。电脑不展示实时画面。</CardDescription>
      </CardHeader>
      <CardContent className='grid gap-3'>
        {isError && <p role='alert'>无法读取视频源状态，请稍后重试。</p>}
        {!isError && !data && <p role='status'>正在读取视频源…</p>}
        {data && pipelines.length === 0 && <p className='text-sm text-muted-foreground'>暂无视频源，请先在「视频源」页面添加并启动。</p>}
        {pipelines.map((p) => (
          <div key={p.name} className='flex flex-wrap items-center justify-between gap-3 rounded-md border p-3'>
            <div><div className='font-medium'>{p.name}</div><p className='text-xs text-muted-foreground'>{p.running ? '运行中' : '已停止'}</p></div>
            <MobilePreview source={p.name} disabled={!p.running} />
          </div>
        ))}
        <p className='text-xs text-muted-foreground'>会话最长 10 分钟；到期后重新扫码。需要提前停止时，打开对应二维码并点击「断开手机预览」。</p>
      </CardContent>
    </Card>
  )
}

function SettingsForm() {
  const [section, setSection] = useState<Section>('sources')
  const { data } = useQuery({ queryKey: ['settings'], queryFn: async () => (await api.get<Settings>('/settings')).data })
  const qc = useQueryClient()
  const [s, setS] = useState<Settings | null>(null)
  const [pw, setPw] = useState('')
  const [testTo, setTestTo] = useState('')
  const [loadedData, setLoadedData] = useState<Settings>()
  if (data && data !== loadedData) {
    setLoadedData(data)
    setS({
      ...data,
      default_sources: data.default_sources?.length ? data.default_sources : data.default_source ? [{ name: '主画面', ...data.default_source }] : [],
      smtp_to: Array.isArray(data.smtp_to) ? data.smtp_to.join(', ') : data.smtp_to,
    })
  }
  const payload = () => {
    const srcs = (s?.default_sources ?? []).filter((x) => x.uri)
    const to = String(s?.smtp_to ?? '').split(/[,;，；\s]+/).filter(Boolean)
    return { ...s, default_sources: srcs, default_source: srcs[0] ?? null, smtp_to: to, ...(pw ? { smtp_password: pw } : {}) }
  }
  const save = useMutation({
    mutationFn: async () => (await api.put('/settings', payload())).data,
    onSuccess: () => {
      toast.success('设置已保存')
      setPw('')
      qc.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const testMail = useMutation({
    mutationFn: async () => {
      await api.put('/settings', payload())
      return (await api.post('/settings/test-email', testTo ? { to: testTo } : {})).data
    },
    onSuccess: (r) => {
      toast.success(r.message)
      setPw('')
      qc.invalidateQueries({ queryKey: ['settings'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  if (!s) return <p role='status' className='p-6'>加载中…</p>
  const set = (p: Partial<Settings>) => setS({ ...s, ...p })
  return (
    <>
      <div className='flex min-h-0 flex-col overflow-y-auto md:flex-row md:overflow-hidden'>
        <nav aria-label='设置分类' className='grid shrink-0 gap-4 border-b bg-muted/30 p-4 md:w-48 md:overflow-y-auto md:border-e md:border-b-0'>
          {MENU.map((group) => (
            <div key={group.label}>
              <h2 className='mb-1 px-2 text-xs font-semibold text-muted-foreground'>{group.label}</h2>
              <div className='grid gap-1'>
                {group.items.map((item) => (
                  <button key={item.id} type='button' aria-current={section === item.id ? 'page' : undefined}
                    className={cn('flex items-center justify-between rounded-md px-2 py-2 text-start text-sm hover:bg-accent', section === item.id && 'bg-accent font-medium')}
                    onClick={() => setSection(item.id)}>
                    {item.label}<ChevronRight className='size-3.5' />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className='min-w-0 flex-1 p-4 md:overflow-y-auto' aria-label='设置内容'>
        {section === 'preview' && <PreviewSettings />}
        {section === 'sources' && <Card>
          <CardHeader>
            <CardTitle>默认视频源</CardTitle>
            <CardDescription>桌面端启动（含开机自启）后自动开始监控；可设多路，同时运行</CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3'>
            {s.default_sources.map((d, i) => (
              <div key={i} className='grid gap-2 rounded-md border p-3'>
                <div className='flex items-center gap-2'>
                  <Input className='h-8 w-36' value={d.name} placeholder='名称' onChange={(e) => set({ default_sources: s.default_sources.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  <span className='flex-1 text-xs text-muted-foreground'>规则可按此名称限定视频源</span>
                  <Button size='icon' variant='ghost' className='size-8' onClick={() => set({ default_sources: s.default_sources.filter((_, j) => j !== i) })}>
                    <Trash2 />
                  </Button>
                </div>
                <SourcePicker value={d} onChange={(v) => set({ default_sources: s.default_sources.map((x, j) => (j === i ? { ...x, ...v } : x)) })} />
              </div>
            ))}
            <Button variant='outline' size='sm' className='w-fit' disabled={s.default_sources.length >= s.max_sources}
              onClick={() => set({ default_sources: [...s.default_sources, { name: s.default_sources.length ? '桌面' : '门口', kind: 'camera', uri: '' }] })}>
              <Plus /> 添加默认源
            </Button>
            <div className='grid grid-cols-2 gap-3'>
              <div className='grid gap-1.5'>
                <Label>摄像头分辨率</Label>
                <Select
                  value={`${s.camera_width}x${s.camera_height}`}
                  onValueChange={(v) => {
                    const [w, h] = v.split('x').map(Number)
                    set({ camera_width: w, camera_height: h })
                  }}
                >
                  <SelectTrigger className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='640x480'>640×480</SelectItem>
                    <SelectItem value='1280x720'>1280×720（推荐）</SelectItem>
                    <SelectItem value='1920x1080'>1920×1080</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>}
        {section === 'startup' && <Card>
          <CardHeader>
            <CardTitle>启动</CardTitle>
          </CardHeader>
          <CardContent>
            <Row label='开机自启' desc='登录系统后在托盘静默启动（Windows/macOS 登录项，Linux 写入 ~/.config/autostart）'>
              <Switch checked={s.autostart} onCheckedChange={(autostart) => set({ autostart })} />
            </Row>
            <Row label='启动后自动开始监控' desc='使用上面的默认视频源'>
              <Switch checked={s.auto_monitor} onCheckedChange={(auto_monitor) => set({ auto_monitor })} />
            </Row>
          </CardContent>
        </Card>}
        {section === 'performance' && <Card>
          <CardHeader>
            <CardTitle>性能</CardTitle>
            <CardDescription>自适应抽帧：画面有人时提高识别帧率，没人时降频省电，并按单帧耗时自动限速</CardDescription>
          </CardHeader>
          <CardContent>
            <Row label='自适应抽帧' desc='摄像头 / 网络流生效'>
              <Switch checked={s.adaptive} onCheckedChange={(adaptive) => set({ adaptive })} />
            </Row>
            <Row label='有人时帧率（fps）'>
              <Input className='w-24' type='number' min={1} max={30} value={s.active_fps} onChange={(e) => set({ active_fps: +e.target.value })} />
            </Row>
            <Row label='无人时帧率（fps）'>
              <Input className='w-24' type='number' min={0.5} max={10} step={0.5} value={s.idle_fps} onChange={(e) => set({ idle_fps: +e.target.value })} />
            </Row>
            <Row label='最多同时运行视频源' desc='多路共享一个识别引擎，路数越多每路帧率越低'>
              <Input className='w-24' type='number' min={1} max={8} value={s.max_sources} onChange={(e) => set({ max_sources: +e.target.value })} />
            </Row>
          </CardContent>
        </Card>}
        {section === 'snapshots' && <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2'>
              触发快照
              {s.snapshots && <Badge variant='secondary'>{s.snapshots.encrypted ? 'AES-GCM 加密' : '未加密'}</Badge>}
            </CardTitle>
            <CardDescription>规则触发时保存一张带框画面，在「时间线」回看、随邮件发送</CardDescription>
          </CardHeader>
          <CardContent>
            <Row label='保存触发快照' desc={s.snapshots ? `当前 ${s.snapshots.count} 张，共 ${(s.snapshots.bytes / 1048576).toFixed(1)} MB` : undefined}>
              <Switch checked={s.snapshot_enabled} onCheckedChange={(snapshot_enabled) => set({ snapshot_enabled })} />
            </Row>
            <Row label='保留天数' desc='过期自动删除；0 表示永久保留'>
              <Input className='w-24' type='number' min={0} max={3650} value={s.snapshot_retention_days} onChange={(e) => set({ snapshot_retention_days: +e.target.value })} />
            </Row>
          </CardContent>
        </Card>}
        {section === 'email' && <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2'>
              邮件通知 {s.smtp_password_set && <Badge variant='secondary'>授权码已加密保存</Badge>}
            </CardTitle>
            <CardDescription>在规则里勾选「发送邮件」动作后生效；邮件含时间、人员、分组与触发快照</CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3'>
            <div className='grid gap-2 sm:grid-cols-[1fr_80px_120px]'>
              <div className='grid gap-1.5'>
                <Label>SMTP 服务器</Label>
                <Input placeholder='smtp.qq.com' value={s.smtp_host} onChange={(e) => set({ smtp_host: e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label>端口</Label>
                <Input type='number' value={s.smtp_port} onChange={(e) => set({ smtp_port: +e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label>加密</Label>
                <Select value={s.smtp_security} onValueChange={(v) => set({ smtp_security: v as Settings['smtp_security'], smtp_port: v === 'ssl' ? 465 : v === 'starttls' ? 587 : 25 })}>
                  <SelectTrigger className='w-full'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='ssl'>SSL/TLS</SelectItem>
                    <SelectItem value='starttls'>STARTTLS</SelectItem>
                    <SelectItem value='none'>不加密</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className='grid grid-cols-2 gap-2'>
              <div className='grid gap-1.5'>
                <Label>账号</Label>
                <Input autoComplete='off' placeholder='me@qq.com' value={s.smtp_user} onChange={(e) => set({ smtp_user: e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label>授权码 / 密码</Label>
                <Input type='password' autoComplete='new-password' placeholder={s.smtp_password_set ? '已保存（留空不修改）' : '邮箱后台生成的授权码'} value={pw} onChange={(e) => setPw(e.target.value)} />
              </div>
              <div className='grid gap-1.5'>
                <Label>发件人</Label>
                <Input placeholder='默认同账号' value={s.smtp_from} onChange={(e) => set({ smtp_from: e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label>收件人（逗号分隔）</Label>
                <Input value={String(s.smtp_to)} onChange={(e) => set({ smtp_to: e.target.value })} />
              </div>
            </div>
            <div className='grid grid-cols-2 gap-2'>
              <div className='grid gap-1.5'>
                <Label>每小时最多（封）</Label>
                <Input type='number' min={0} value={s.email_per_hour} onChange={(e) => set({ email_per_hour: +e.target.value })} />
              </div>
              <div className='grid gap-1.5'>
                <Label>两封最短间隔（秒）</Label>
                <Input type='number' min={0} value={s.email_min_interval_s} onChange={(e) => set({ email_min_interval_s: +e.target.value })} />
              </div>
            </div>
            <label className='flex items-center gap-2 text-sm'>
              <Switch checked={s.smtp_verify_tls} onCheckedChange={(smtp_verify_tls) => set({ smtp_verify_tls })} /> 校验服务器证书
            </label>
            <div className='flex flex-wrap gap-2 border-t pt-3'>
              <Input className='h-9' placeholder='测试收件人（留空用上面的收件人）' value={testTo} onChange={(e) => setTestTo(e.target.value)} />
              <Button variant='outline' disabled={testMail.isPending || !s.smtp_host} onClick={() => testMail.mutate()}>
                <Mail /> {testMail.isPending ? '发送中…' : '发送测试邮件'}
              </Button>
            </div>
          </CardContent>
        </Card>}
        </div>
      </div>
      <div className='flex shrink-0 justify-end border-t p-4'>
        <Button disabled={save.isPending || testMail.isPending} onClick={() => save.mutate()}>
          <Save /> {save.isPending ? '保存中…' : '保存设置'}
        </Button>
      </div>
    </>
  )
}
