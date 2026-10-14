import { type ReactNode, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock3, Filter, FlaskConical, MonitorPlay, Plus, Save, Trash2, UserRound, Users, Zap, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { api, errMsg, ROLE_LABEL, ROLE_VARIANT } from '@/lib/api'
import { Page } from './page'

type Action = { type: string; params: Record<string, string | number | boolean> }
type TimeWindow = { days: number[]; start: string; end: string }
export type Rule = {
  id: string
  role: string | null
  person_ids: string[]
  stranger: boolean
  stranger_after_s: number
  whitelist: boolean
  suppress_others: boolean
  priority: number
  sources: string[]
  schedule: TimeWindow[]
  min_face_px: number
  min_face_ratio: number
  min_face_mode?: '' | 'px' | 'ratio'
  restore_on_leave: boolean
  leave_after_s: number
  enabled: boolean
  min_frames: number
  min_confirm_s?: number
  cooldown_s: number
  actions: Action[]
  note?: string | null
}
type PersonLite = { person_id: string; name: string; role: string | null }
const WD = ['一', '二', '三', '四', '五', '六', '日']
const ROLE_OPTIONS = ['boss', 'leader', 'staff', 'whitelist', 'ignore']
const blank = (over: Partial<Rule>): Rule => ({
  id: `r${Date.now().toString(36)}`, role: null, person_ids: [], stranger: false, stranger_after_s: 5, whitelist: false,
  suppress_others: false, priority: 10, sources: [], schedule: [], min_face_px: 0, min_face_ratio: 0, min_face_mode: '',
  restore_on_leave: false, leave_after_s: 15, enabled: true, min_frames: 3, min_confirm_s: 0.5, cooldown_s: 60, actions: [{ type: 'notify', params: {} }],
  note: '', ...over,
})
const kindOf = (r: Rule) => (r.whitelist ? 'whitelist' : r.stranger ? 'stranger' : r.person_ids.length ? 'person' : 'role')
const KIND_LABEL: Record<string, string> = { whitelist: '白名单', stranger: '陌生人', person: '人员', role: '分组' }
type RulesResp = { rules: Rule[]; actions: { value: string; label: string }[] }

const ACTION_HINT: Record<string, string> = {
  notify: '桌面通知（Linux 无通知服务时用应用浮窗）',
  sound: '播放提示音',
  cover: '全屏「假装在做表格」，快捷键 Ctrl+Alt+B 解除',
  minimize_all: 'Win: Shell.MinimizeAll · macOS: osascript · Linux: xdotool/wmctrl（仅 X11）',
  focus_app: '把指定程序切到前台（按窗口标题/程序名）',
  mute: 'Win: nircmd/媒体键 · macOS: osascript · Linux: pactl/amixer',
  lock_screen: 'Win: LockWorkStation · macOS: ⌃⌘Q · Linux: loginctl/xdg-screensaver',
  command: '运行自定义 shell 命令（谨慎使用）',
  email: '由识别服务按「设置 → 邮件通知」发送，附触发快照；有限流',
  log: '只写入事件日志',
}

function ParamEditor({ a, onChange }: { a: Action; onChange: (p: Action['params']) => void }) {
  const set = (k: string, v: string) => onChange({ ...a.params, [k]: v })
  if (a.type === 'focus_app')
    return <Input className='h-8' placeholder='程序名/窗口标题，如 Visual Studio Code' value={String(a.params.app ?? '')} onChange={(e) => set('app', e.target.value)} />
  if (a.type === 'command')
    return <Textarea className='min-h-8 font-mono text-xs' placeholder='如 notify-send 识务' value={String(a.params.cmd ?? '')} onChange={(e) => set('cmd', e.target.value)} />
  if (a.type === 'sound')
    return (
      <Select value={String(a.params.file ?? 'Classic_Beep.wav')} onValueChange={(v) => set('file', v)}>
        <SelectTrigger className='h-8 w-48'>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='Classic_Beep.wav'>经典蜂鸣</SelectItem>
          <SelectItem value='Subtle_Ding.wav'>轻柔叮咚</SelectItem>
        </SelectContent>
      </Select>
    )
  if (a.type === 'email')
    return (
      <div className='flex flex-wrap items-center gap-2'>
        <Input className='h-8 flex-1' placeholder='收件人（留空用设置里的收件人）' value={String(a.params.to ?? '')} onChange={(e) => set('to', e.target.value)} />
        <label className='flex items-center gap-1.5 text-xs'>
          <Checkbox checked={a.params.attach_snapshot !== false} onCheckedChange={(v) => onChange({ ...a.params, attach_snapshot: !!v })} />
          附快照
        </label>
      </div>
    )
  if (a.type === 'notify')
    return <Input className='h-8' placeholder='通知标题（默认：老板来了！）' value={String(a.params.title ?? '')} onChange={(e) => set('title', e.target.value)} />
  return null
}

function Field({ label, children, hint, icon: Icon }: { label: string; children: ReactNode; hint?: string; icon?: LucideIcon }) {
  return (
    <div className='grid gap-1.5'>
      <Label>{Icon && <Icon className='size-4' aria-hidden />}{label}</Label>
      {children}
      {hint && <span className='text-xs text-muted-foreground'>{hint}</span>}
    </div>
  )
}

function ScheduleEditor({ value, onChange }: { value: TimeWindow[]; onChange: (v: TimeWindow[]) => void }) {
  return (
    <div className='grid gap-2'>
      {value.map((w, i) => (
        <div key={i} className='flex flex-wrap items-center gap-1.5'>
          {WD.map((d, j) => {
            const on = w.days.length === 0 || w.days.includes(j)
            return (
              <button
                key={j}
                type='button'
                className={`size-7 rounded-md border text-xs ${on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'}`}
                onClick={() => {
                  const all = w.days.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : w.days
                  const days = on ? all.filter((x) => x !== j) : [...all, j].sort()
                  onChange(value.map((x, k) => (k === i ? { ...x, days } : x)))
                }}
              >
                {d}
              </button>
            )
          })}
          <Input type='time' className='h-8 w-28' value={w.start} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)))} />
          <span className='text-xs'>至</span>
          <Input type='time' className='h-8 w-28' value={w.end === '24:00' ? '23:59' : w.end} onChange={(e) => onChange(value.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)))} />
          <Button size='icon' variant='ghost' className='size-7' onClick={() => onChange(value.filter((_, k) => k !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <div className='flex items-center gap-2'>
        <Button size='sm' variant='outline' className='h-7' onClick={() => onChange([...value, { days: [0, 1, 2, 3, 4], start: '09:00', end: '18:00' }])}>
          <Plus /> 时间段
        </Button>
        <span className='text-xs text-muted-foreground'>{value.length ? '结束早于开始表示跨夜' : '不限时间（全天候）'}</span>
      </div>
    </div>
  )
}

function RuleCard({ r, types, people, sources, onChange, onDelete }: {
  r: Rule
  types: RulesResp['actions']
  people: PersonLite[]
  sources: string[]
  onChange: (r: Rule) => void
  onDelete: () => void
}) {
  const kind = kindOf(r)
  const has = (t: string) => r.actions.find((a) => a.type === t)
  const toggle = (t: string, on: boolean) =>
    onChange({ ...r, actions: on ? [...r.actions, { type: t, params: {} }] : r.actions.filter((a) => a.type !== t) })
  const test = useMutation({
    mutationFn: async () => (await api.post('/monitor/test', { rule_id: r.id, role: r.role ?? 'boss', name: '测试' })).data,
    onSuccess: () => toast.success('已发出测试动作（桌面端执行；邮件由服务端发送）'),
    onError: (e) => toast.error(errMsg(e)),
  })
  const who =
    kind === 'stranger' ? `陌生人持续 ${r.stranger_after_s} 秒未识别` :
    kind === 'person' ? people.filter((p) => r.person_ids.includes(p.person_id)).map((p) => p.name).join('、') || '（未选择人员）' :
    `识别到${ROLE_LABEL[r.role ?? ''] ?? r.role ?? '?'}`
  const allSources = Array.from(new Set([...sources, ...r.sources]))
  const faceMode = r.min_face_mode ?? (r.min_face_px > 0 ? 'px' : r.min_face_ratio > 0 ? 'ratio' : '')
  return (
    <Card className={r.enabled ? '' : 'opacity-70'}>
      <CardHeader className='flex flex-row items-center justify-between space-y-0'>
        <div className='flex min-w-0 items-center gap-2'>
          <Badge variant={kind === 'whitelist' ? 'outline' : kind === 'stranger' ? 'default' : ROLE_VARIANT[r.role ?? ''] ?? 'secondary'}>{KIND_LABEL[kind]}</Badge>
          <CardTitle className='truncate text-base'>{kind === 'whitelist' ? `白名单：${ROLE_LABEL[r.role ?? ''] ?? (who || '')}` : who}</CardTitle>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <Label htmlFor={`en-${r.id}`} className='text-sm text-muted-foreground'>启用</Label>
          <Switch id={`en-${r.id}`} checked={r.enabled} onCheckedChange={(enabled) => onChange({ ...r, enabled })} />
        </div>
      </CardHeader>
      <CardContent className='grid gap-4'>
        <div className='grid grid-cols-1 gap-3'>
          {kind !== 'stranger' && (
            <Field label='分组' icon={Users}>
              <Select value={r.role ?? '_any'} onValueChange={(v) => onChange({ ...r, role: v === '_any' ? null : v })}>
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {kind === 'person' && <SelectItem value='_any'>不限</SelectItem>}
                  {ROLE_OPTIONS.map((x) => (
                    <SelectItem key={x} value={x}>{ROLE_LABEL[x]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {kind === 'stranger' && (
            <Field label='持续未识别（秒）'>
              <Input type='number' min={0} value={r.stranger_after_s} onChange={(e) => onChange({ ...r, stranger_after_s: +e.target.value })} />
            </Field>
          )}
          <Field label='优先级' hint='数字越大越先匹配，同一张脸只走第一条'>
            <Input type='number' value={r.priority} onChange={(e) => onChange({ ...r, priority: +e.target.value })} />
          </Field>
          <Field label='连续出现（秒）'>
            <Input type='number' min={0} step={0.1} value={r.min_confirm_s ?? 0.5} onChange={(e) => onChange({ ...r, min_confirm_s: +e.target.value })} />
          </Field>
          {kind !== 'whitelist' && (
            <Field label='冷却（秒）'>
              <Input type='number' min={0} value={r.cooldown_s} onChange={(e) => onChange({ ...r, cooldown_s: +e.target.value })} />
            </Field>
          )}
        </div>
        {(kind === 'person' || (kind === 'whitelist' && r.person_ids.length > 0)) && (
          <Field label='人员（可多选）' icon={UserRound}>
            <div className='flex flex-wrap gap-1.5'>
              {people.map((p) => {
                const on = r.person_ids.includes(p.person_id)
                return (
                  <Button key={p.person_id} size='sm' variant={on ? 'default' : 'outline'} className='h-7'
                    onClick={() => onChange({ ...r, person_ids: on ? r.person_ids.filter((x) => x !== p.person_id) : [...r.person_ids, p.person_id] })}>
                    {p.name}
                    {p.role ? <span className='opacity-70'>· {ROLE_LABEL[p.role] ?? p.role}</span> : null}
                  </Button>
                )
              })}
              {!people.length && <span className='text-xs text-muted-foreground'>还没有登记人员</span>}
            </div>
          </Field>
        )}
        <div className='grid gap-3 rounded-md border p-3'>
          <span className='flex items-center gap-2 text-sm font-medium'><Filter className='size-4' aria-hidden />条件 <Badge variant='outline' className='text-[10px]'>并且</Badge></span>
          <Field label='画面源' icon={MonitorPlay}>
            <div className='flex flex-wrap gap-1.5'>
              {allSources.map((n) => {
                const on = r.sources.includes(n)
                return (
                  <Button key={n} size='sm' variant={on ? 'default' : 'outline'} className='h-7'
                    onClick={() => onChange({ ...r, sources: on ? r.sources.filter((x) => x !== n) : [...r.sources, n] })}>
                    {n}
                  </Button>
                )
              })}
              <span className='self-center text-xs text-muted-foreground'>{r.sources.length ? '' : '所有画面源'}</span>
            </div>
          </Field>
          <Field label='时间段（星期 + 时间窗）' icon={Clock3}>
            <ScheduleEditor value={r.schedule} onChange={(schedule) => onChange({ ...r, schedule })} />
          </Field>
          <div className='grid gap-3'>
            <Field label='人脸大小'>
              <RadioGroup
                className='flex flex-wrap gap-3'
                value={faceMode || 'none'}
                onValueChange={(v) => {
                  const min_face_mode = (v === 'none' ? '' : v) as '' | 'px' | 'ratio'
                  onChange({
                    ...r,
                    min_face_mode,
                    min_face_px: min_face_mode === 'px' ? r.min_face_px : 0,
                    min_face_ratio: min_face_mode === 'ratio' ? r.min_face_ratio : 0,
                  })
                }}
              >
                <label className='flex items-center gap-1.5 text-sm'><RadioGroupItem value='none' aria-label='不限制' />不限制</label>
                <label className='flex items-center gap-1.5 text-sm'><RadioGroupItem value='px' aria-label='最小人脸宽度' />最小人脸宽度</label>
                <label className='flex items-center gap-1.5 text-sm'><RadioGroupItem value='ratio' aria-label='最小占画面宽度' />最小占画面宽度</label>
              </RadioGroup>
            </Field>
            {faceMode === 'px' && (
              <Field label='最小人脸宽度（px）' hint='越大 = 越近才触发'>
                <Input type='number' min={0} value={r.min_face_px} onChange={(e) => onChange({ ...r, min_face_px: +e.target.value })} />
              </Field>
            )}
            {faceMode === 'ratio' && (
              <Field label='最小占画面宽度（%）'>
                <Input type='number' min={0} max={100} step={1} value={Math.round(r.min_face_ratio * 1000) / 10} onChange={(e) => onChange({ ...r, min_face_ratio: +e.target.value / 100 })} />
              </Field>
            )}
          </div>
        </div>
        {kind === 'whitelist' ? (
          <label className='flex items-center gap-2 rounded-md border p-3 text-sm'>
            <Switch checked={r.suppress_others} onCheckedChange={(suppress_others) => onChange({ ...r, suppress_others })} />
            <span>
              同时抑制其他规则
              <span className='block text-xs text-muted-foreground'>白名单的人出现时，同一画面源上其他人的规则先不响（例如有人陪客户过来）</span>
            </span>
          </label>
        ) : (
          <>
            <label className='flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm'>
              <Switch checked={r.restore_on_leave} onCheckedChange={(restore_on_leave) => onChange({ ...r, restore_on_leave })} />
              <span className='flex-1'>
                离开后自动恢复
                <span className='block text-xs text-muted-foreground'>触发人离开画面超过设定秒数后，自动解除遮挡并恢复之前被最小化的窗口</span>
              </span>
              {r.restore_on_leave && (
                <span className='flex items-center gap-1 text-xs'>
                  <Input type='number' min={1} className='h-8 w-20' value={r.leave_after_s} onChange={(e) => onChange({ ...r, leave_after_s: +e.target.value })} /> 秒
                </span>
              )}
            </label>
            <div className='grid gap-2 rounded-md border p-3'>
              <span className='flex items-center gap-2 text-sm font-medium'><Zap className='size-4' aria-hidden />动作</span>
              <div className='grid grid-cols-1 gap-1.5'>
                {types.map((t) => (
                  <label key={t.value} className='flex items-center gap-2 text-sm' title={ACTION_HINT[t.value]}>
                    <Checkbox checked={!!has(t.value)} onCheckedChange={(v) => toggle(t.value, !!v)} />
                    {t.label}
                  </label>
                ))}
              </div>
              {r.actions.filter((a) => ['focus_app', 'command', 'sound', 'notify', 'email'].includes(a.type)).map((a) => (
                <div key={a.type} className='grid grid-cols-1 gap-2'>
                  <span className='text-xs text-muted-foreground'>{types.find((t) => t.value === a.type)?.label}</span>
                  <ParamEditor a={a} onChange={(params) => onChange({ ...r, actions: r.actions.map((x) => (x.type === a.type ? { ...x, params } : x)) })} />
                </div>
              ))}
            </div>
          </>
        )}
        <Field label='备注'>
          <Input value={r.note ?? ''} onChange={(e) => onChange({ ...r, note: e.target.value })} />
        </Field>
      </CardContent>
      <CardFooter className='justify-between'>
        <Button size='sm' variant='outline' disabled={!r.enabled || kind === 'whitelist'} onClick={() => test.mutate()}>
          <FlaskConical /> 测试动作
        </Button>
        <Button size='sm' variant='ghost' className='text-destructive' onClick={onDelete}>
          <Trash2 /> 删除
        </Button>
      </CardFooter>
    </Card>
  )
}

export function Rules() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['rules'], queryFn: async () => (await api.get<RulesResp>('/rules')).data })
  const { data: people = [] } = useQuery({ queryKey: ['people'], queryFn: async () => (await api.get<PersonLite[]>('/people')).data })
  const { data: sources = [] } = useQuery({ queryKey: ['source-names'], queryFn: async () => (await api.get<string[]>('/sources/names')).data })
  const [rules, setRules] = useState<Rule[]>([])
  const [loadedData, setLoadedData] = useState<RulesResp>()
  if (data && data !== loadedData) {
    setLoadedData(data)
    setRules(data.rules)
  }
  const [confirmCmd, setConfirmCmd] = useState<string[] | null>(null)
  const savedCmds = new Set(
    (data?.rules ?? []).flatMap((r) => r.actions.filter((a) => a.type === 'command').map((a) => `${r.id}:${a.params.cmd ?? ''}`))
  )
  // 新增或修改了「自定义命令」需要二次确认
  const changedCmds = rules
    .filter((r) => r.enabled)
    .flatMap((r) => r.actions.filter((a) => a.type === 'command').map((a) => ({ key: `${r.id}:${a.params.cmd ?? ''}`, label: `${r.note || r.id}：${a.params.cmd ?? ''}` })))
    .filter((c) => !savedCmds.has(c.key))
  const trySave = () => (changedCmds.length ? setConfirmCmd(changedCmds.map((c) => c.label)) : save.mutate())
  const save = useMutation({
    mutationFn: async () => (await api.put('/rules', rules)).data,
    onSuccess: () => {
      toast.success('规则已保存，立即生效')
      qc.invalidateQueries({ queryKey: ['rules'] })
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <Page title='规则设置' desc='分组 / 人员 / 陌生人 / 白名单规则并存；按优先级从高到低，每张脸只匹配第一条满足条件的规则'>
      <div className='mb-4 flex flex-wrap gap-2'>
        <Select value='' onValueChange={(k) => setRules((rs) => [...rs, blank(
          k === 'person' ? { person_ids: people[0] ? [people[0].person_id] : [], priority: 50, note: '人员规则' } :
          k === 'stranger' ? { stranger: true, priority: 5, stranger_after_s: 5, note: '陌生人' } :
          k === 'whitelist' ? { whitelist: true, role: 'whitelist', priority: 100, min_frames: 1, actions: [], note: '白名单' } :
          { role: 'boss', note: '分组规则' })])}>
          <SelectTrigger className='w-36'>
            <Plus /> <span>新增规则</span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='person'>人员规则</SelectItem>
            <SelectItem value='role'>分组规则</SelectItem>
            <SelectItem value='stranger'>陌生人规则</SelectItem>
            <SelectItem value='whitelist'>白名单规则</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={trySave}>
          <Save /> 保存规则
        </Button>
      </div>
      <ConfirmDialog
        open={!!confirmCmd}
        onOpenChange={(o) => !o && setConfirmCmd(null)}
        title='确认启用自定义命令？'
        desc={
          <div className='grid gap-2'>
            <p>识别到对应分组时，桌面端会以你的用户权限直接运行下面的命令。请确认命令来源可信：</p>
            <pre className='rounded bg-muted p-2 text-xs whitespace-pre-wrap'>{(confirmCmd ?? []).join('\n')}</pre>
          </div>
        }
        destructive
        confirmText='我已确认，保存'
        handleConfirm={() => {
          setConfirmCmd(null)
          save.mutate()
        }}
      />
      <div className='grid grid-cols-1 gap-4'>
        {[...rules].sort((a, b) => b.priority - a.priority).map((r) => (
          <RuleCard key={r.id} r={r} types={data?.actions ?? []} people={people} sources={sources}
            onChange={(nr) => setRules((rs) => rs.map((x) => (x.id === r.id ? nr : x)))}
            onDelete={() => setRules((rs) => rs.filter((x) => x.id !== r.id))} />
        ))}
      </div>
    </Page>
  )
}
