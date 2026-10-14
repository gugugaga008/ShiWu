import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, ROLE_LABEL, ROLE_VARIANT, withToken } from '@/lib/api'
import { FilterSelect, roleOptions, usePeople, useSourceNames } from './filters'
import { Page } from './page'

type Stats = {
  days: number
  dates: string[]
  daily: ({ date: string; appearances: number; triggers: number } & Record<string, number | string>)[]
  people: { person_id: string; name: string; role: string | null; role_label?: string; total: number; by_date: Record<string, number> }[]
  heatmap: number[][]
  trigger_roles: Record<string, number>
  totals: { appearances: number; triggers: number; people: number }
}

const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#14b8a6']
const short = (d: string) => d.slice(5)
const TRIG_LABEL = (r: string) => ROLE_LABEL[r] ?? (r === 'stranger' ? '陌生人' : r === 'other' ? '其他' : r)

function Heatmap({ data }: { data: number[][] }) {
  const max = Math.max(1, ...data.flat())
  return (
    <div className='overflow-x-auto'>
      <div className='grid grid-cols-[32px_repeat(24,1fr)] gap-[2px] text-[10px]'>
        <span />
        {Array.from({ length: 24 }, (_, h) => (
          <span key={h} className='text-center text-muted-foreground'>{h % 3 === 0 ? h : ''}</span>
        ))}
        {data.map((row, d) => (
          <div key={d} className='contents'>
            <span className='self-center text-muted-foreground'>{WD[d]}</span>
            {row.map((v, h) => (
              <div key={h} title={`${WD[d]} ${h}:00–${h + 1}:00 · ${v} 次`} className='aspect-square rounded-[3px] border border-border/40'
                style={{ background: v ? `rgba(239, 68, 68, ${0.12 + 0.88 * (v / max)})` : undefined }} />
            ))}
          </div>
        ))}
      </div>
      <div className='mt-2 flex items-center gap-1 text-[10px] text-muted-foreground'>
        少 {[0.15, 0.35, 0.55, 0.75, 1].map((a) => <span key={a} className='size-3 rounded-[3px]' style={{ background: `rgba(239,68,68,${a})` }} />)} 多
      </div>
    </div>
  )
}

export function StatsPage() {
  const people = usePeople()
  const sources = useSourceNames()
  const [days, setDays] = useState('7')
  const [person, setPerson] = useState('')
  const [role, setRole] = useState('')
  const [source, setSource] = useState('')
  const params = { days, person_id: person || undefined, role: role || undefined, source: source || undefined }
  const { data } = useQuery({
    queryKey: ['stats', params],
    queryFn: async () => (await api.get<Stats>('/stats', { params })).data,
    refetchInterval: 15000,
  })
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()
  const top = (data?.people ?? []).slice(0, 6)
  const perPerson = (data?.dates ?? []).map((d) => ({ date: short(d), ...Object.fromEntries(top.map((p) => [p.name, p.by_date[d] ?? 0])) }))
  const trigKeys = Object.keys(data?.trigger_roles ?? {})
  const trend = (data?.daily ?? []).map((d) => ({ ...d, date: short(d.date) }))
  return (
    <Page title='统计' desc='按人 / 分组 / 日期统计出现次数、时段分布与触发趋势'>
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <FilterSelect value={days === '7' ? '' : days} onChange={(v) => setDays(v || '7')} placeholder='最近 7 天'
          options={[{ value: '14', label: '最近 14 天' }, { value: '30', label: '最近 30 天' }, { value: '90', label: '最近 90 天' }]} width='w-32' />
        <FilterSelect value={person} onChange={setPerson} placeholder='全部人员' options={people.map((p) => ({ value: p.person_id, label: p.name }))} />
        <FilterSelect value={role} onChange={setRole} placeholder='全部分组' options={roleOptions} width='w-32' />
        <FilterSelect value={source} onChange={setSource} placeholder='全部视频源' options={sources.map((s) => ({ value: s, label: s }))} width='w-32' />
        <Button variant='outline' className='ms-auto' asChild>
          <a href={withToken(`/stats/export.csv?${qs}`)} download>
            <Download /> 导出 CSV
          </a>
        </Button>
      </div>
      <div className='mb-4 grid gap-4 sm:grid-cols-3'>
        {[['出现次数', data?.totals.appearances, '同一条轨迹记 1 次'], ['触发次数', data?.totals.triggers, '规则触发动作'], ['出现人数', data?.totals.people, '已登记人员']].map(([t, v, d]) => (
          <Card key={t as string}>
            <CardHeader>
              <CardDescription>{t}</CardDescription>
              <CardTitle className='text-3xl'>{v ?? 0}</CardTitle>
              <span className='text-xs text-muted-foreground'>{d}</span>
            </CardHeader>
          </Card>
        ))}
      </div>
      <div className='grid gap-4 xl:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle>每天出现次数（按人）</CardTitle>
          </CardHeader>
          <CardContent className='h-72'>
            <ResponsiveContainer width='100%' height='100%'>
              <BarChart data={perPerson}>
                <CartesianGrid strokeDasharray='3 3' vertical={false} />
                <XAxis dataKey='date' fontSize={12} />
                <YAxis allowDecimals={false} fontSize={12} width={28} />
                <Tooltip />
                <Legend />
                {top.map((p, i) => (
                  <Bar key={p.person_id} dataKey={p.name} stackId='a' fill={COLORS[i % COLORS.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>触发次数趋势</CardTitle>
          </CardHeader>
          <CardContent className='h-72'>
            <ResponsiveContainer width='100%' height='100%'>
              <LineChart data={trend}>
                <CartesianGrid strokeDasharray='3 3' vertical={false} />
                <XAxis dataKey='date' fontSize={12} />
                <YAxis allowDecimals={false} fontSize={12} width={28} />
                <Tooltip />
                <Legend />
                <Line type='monotone' dataKey='triggers' name='全部触发' stroke='#111827' strokeWidth={2} dot={false} />
                {trigKeys.map((k, i) => (
                  <Line key={k} type='monotone' dataKey={`t_${k}`} name={TRIG_LABEL(k)} stroke={COLORS[i % COLORS.length]} dot={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>时段分布热力图</CardTitle>
            <CardDescription>星期 × 小时的出现次数</CardDescription>
          </CardHeader>
          <CardContent>
            <Heatmap data={data?.heatmap ?? Array.from({ length: 7 }, () => Array(24).fill(0))} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>人员明细</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>人员</TableHead>
                  <TableHead>分组</TableHead>
                  <TableHead className='text-end'>合计</TableHead>
                  {(data?.dates ?? []).slice(-5).map((d) => (
                    <TableHead key={d} className='text-end'>{short(d)}</TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.people ?? []).map((p) => (
                  <TableRow key={p.person_id}>
                    <TableCell className='font-medium'>{p.name}</TableCell>
                    <TableCell>{p.role ? <Badge variant={ROLE_VARIANT[p.role] ?? 'outline'}>{ROLE_LABEL[p.role] ?? p.role}</Badge> : '—'}</TableCell>
                    <TableCell className='text-end font-semibold'>{p.total}</TableCell>
                    {(data?.dates ?? []).slice(-5).map((d) => (
                      <TableCell key={d} className='text-end text-muted-foreground'>{p.by_date[d] || ''}</TableCell>
                    ))}
                  </TableRow>
                ))}
                {!data?.people.length && (
                  <TableRow>
                    <TableCell colSpan={8} className='py-6 text-center text-muted-foreground'>暂无数据</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </Page>
  )
}
