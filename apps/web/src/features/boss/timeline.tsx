import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DoorOpen, ImageOff, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, ROLE_LABEL, ROLE_VARIANT, withToken } from '@/lib/api'
import { FilterSelect, roleOptions, usePeople, useSourceNames } from './filters'
import { fmtTime } from './live'
import { Page } from './page'

type Item = {
  id: number
  ts: number
  kind: 'action' | 'left'
  person_id: string | null
  name: string | null
  role: string | null
  role_label: string | null
  rule_id: string | null
  source: string | null
  similarity: number | null
  actions: { type: string }[] | null
  detail: { away_s?: number } | null
  snapshot_url: string | null
}

const ACTION_LABEL: Record<string, string> = {
  notify: '通知', sound: '声音', cover: '遮挡', minimize_all: '最小化', focus_app: '切换程序', mute: '静音',
  lock_screen: '锁屏', command: '命令', email: '邮件', log: '记录',
}
const dayKey = (t: number) => new Date(t * 1000).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })
const snap = (u: string) => withToken(u.replace(/^\/boss/, ''))

export function Timeline() {
  const people = usePeople()
  const sources = useSourceNames()
  const [person, setPerson] = useState('')
  const [role, setRole] = useState('')
  const [source, setSource] = useState('')
  const [date, setDate] = useState('')
  const [kinds, setKinds] = useState('action,left')
  const [open, setOpen] = useState<Item | null>(null)
  const range = useMemo(() => {
    if (!date) return {}
    const s = new Date(`${date}T00:00:00`).getTime() / 1000
    return { start: s, end: s + 86400 }
  }, [date])
  const { data: items = [], isLoading } = useQuery({
    queryKey: ['timeline', person, role, source, date, kinds, range],
    queryFn: async () =>
      (await api.get<Item[]>('/timeline', { params: { person_id: person || undefined, role: role || undefined, source: source || undefined, kinds, limit: 300, ...range } })).data,
    refetchInterval: 5000,
  })
  const groups = useMemo(() => {
    const g: [string, Item[]][] = []
    for (const it of items) {
      const k = dayKey(it.ts)
      if (!g.length || g[g.length - 1][0] !== k) g.push([k, []])
      g[g.length - 1][1].push(it)
    }
    return g
  }, [items])
  const nAct = items.filter((i) => i.kind === 'action').length
  return (
    <Page title='时间线' desc='按时间回看每次触发与触发快照（快照加密保存在本机）'>
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <FilterSelect value={person} onChange={setPerson} placeholder='全部人员' options={people.map((p) => ({ value: p.person_id, label: p.name }))} />
        <FilterSelect value={role} onChange={setRole} placeholder='全部分组' options={roleOptions} width='w-32' />
        <FilterSelect value={source} onChange={setSource} placeholder='全部画面源' options={sources.map((s) => ({ value: s, label: s }))} width='w-32' />
        <Input type='date' className='w-40' value={date} onChange={(e) => setDate(e.target.value)} />
        <FilterSelect value={kinds === 'action,left' ? '' : kinds} onChange={(v) => setKinds(v || 'action,left')} placeholder='触发 + 离开'
          options={[{ value: 'action', label: '只看触发' }, { value: 'left', label: '只看离开' }]} width='w-32' />
        <span className='ms-auto text-sm text-muted-foreground'>{items.length} 条 · 触发 {nAct} 次</span>
      </div>
      {isLoading ? null : groups.length === 0 ? (
        <Card>
          <CardContent className='py-16 text-center text-sm text-muted-foreground'>暂无记录</CardContent>
        </Card>
      ) : (
        <div className='grid gap-6'>
          {groups.map(([day, list]) => (
            <section key={day}>
              <h3 className='mb-2 text-sm font-semibold text-muted-foreground'>{day} · {list.length} 条</h3>
              <ol className='relative grid gap-3 border-s ps-5'>
                {list.map((it) => (
                  <li key={it.id} className='relative'>
                    <span className={`absolute -start-[27px] top-3 flex size-4 items-center justify-center rounded-full ring-4 ring-background ${it.kind === 'action' ? 'bg-destructive' : 'bg-emerald-500'}`} />
                    <Card className='flex-row items-center gap-4 p-3'>
                      {it.kind === 'action' ? (
                        it.snapshot_url ? (
                          <button type='button' onClick={() => setOpen(it)} className='shrink-0 overflow-hidden rounded-md border'>
                            <img src={snap(it.snapshot_url)} alt='快照' loading='lazy' className='h-20 w-36 object-cover transition hover:scale-105' />
                          </button>
                        ) : (
                          <div className='flex h-20 w-36 shrink-0 flex-col items-center justify-center gap-1 rounded-md bg-muted text-muted-foreground'>
                            <ImageOff className='size-5' />
                            <span className='text-xs'>无快照</span>
                          </div>
                        )
                      ) : (
                        <div className='flex h-12 w-36 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600'>
                          <DoorOpen className='size-5' />
                        </div>
                      )}
                      <div className='grid min-w-0 flex-1 gap-1'>
                        <div className='flex flex-wrap items-center gap-2'>
                          <span className='font-mono text-sm'>{fmtTime(it.ts)}</span>
                          <span className='font-medium'>{it.name ?? '未知'}</span>
                          {it.role && <Badge variant={ROLE_VARIANT[it.role] ?? 'outline'}>{ROLE_LABEL[it.role] ?? it.role}</Badge>}
                          {!it.role && it.rule_id === 'stranger' && <Badge>陌生人</Badge>}
                          {it.source && <Badge variant='outline'>{it.source}</Badge>}
                        </div>
                        <div className='flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
                          {it.kind === 'action' ? (
                            <>
                              <Zap className='size-3.5' /> 规则 {it.rule_id}
                              {(it.actions ?? []).map((a, i) => (
                                <Badge key={i} variant='secondary' className='text-[11px]'>{ACTION_LABEL[a.type] ?? a.type}</Badge>
                              ))}
                              {it.similarity ? <span>· 相似度 {it.similarity.toFixed(2)}</span> : null}
                            </>
                          ) : (
                            <>离开画面 {it.detail?.away_s ?? '?'} 秒 → 自动解除遮挡、恢复窗口</>
                          )}
                        </div>
                      </div>
                    </Card>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className='sm:max-w-4xl'>
          <DialogHeader>
            <DialogTitle>{open?.name} · {open && new Date(open.ts * 1000).toLocaleString('zh-CN', { hour12: false })}</DialogTitle>
            <DialogDescription>{open?.source} · 规则 {open?.rule_id}</DialogDescription>
          </DialogHeader>
          {open?.snapshot_url && <img src={snap(open.snapshot_url)} alt='快照' className='w-full rounded-md' />}
        </DialogContent>
      </Dialog>
    </Page>
  )
}
