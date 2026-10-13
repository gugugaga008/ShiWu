import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, ROLE_LABEL, ROLE_VARIANT } from '@/lib/api'

type Row = {
  id: number
  ts: number
  kind: string
  person_id: string | null
  name: string | null
  role: string | null
  rule_id: string | null
  similarity: number | null
  actions: { type: string }[] | null
  source: string | null
  detail: unknown
}

const KIND: Record<string, string> = {
  action: '触发动作',
  recognized: '识别',
  monitor_paused: '暂停监控',
  monitor_resumed: '恢复监控',
  action_result: '动作结果',
}
const ACTION: Record<string, string> = {
  notify: '通知',
  sound: '声音',
  cover: '遮挡',
  minimize_all: '最小化',
  focus_app: '切换程序',
  mute: '静音',
  lock_screen: '锁屏',
  command: '命令',
  log: '记录',
}
const FILTER: Record<string, string | undefined> = {
  all: 'action,recognized,monitor_paused,monitor_resumed,action_result',
  action: 'action,action_result',
  recognized: 'recognized',
  monitor: 'monitor_paused,monitor_resumed',
}

type Result = { type: string; ok: boolean; message: string }

function describe(r: Row) {
  if (r.kind === 'action') return (r.actions ?? []).map((a) => ACTION[a.type] ?? a.type).join(' + ') || '—'
  if (r.kind === 'action_result') {
    const res = ((r.detail as { results?: Result[] })?.results ?? []) as Result[]
    return res.map((x) => `${x.ok ? '✓' : '✗'}${ACTION[x.type] ?? x.type}${x.ok ? '' : `（${x.message}）`}`).join('  ')
  }
  if (r.kind === 'recognized') return r.similarity != null ? `相似度 ${r.similarity.toFixed(3)}` : ''
  return r.source ? `来源：${r.source === 'tray' ? '托盘' : r.source}` : ''
}

export function EventLogCard({ limit = 20 }: { limit?: number }) {
  const [tab, setTab] = useState('all')
  const { data = [] } = useQuery({
    queryKey: ['eventlog', tab, limit],
    queryFn: async () => (await api.get<Row[]>('/eventlog', { params: { limit, kind: FILTER[tab] } })).data,
    refetchInterval: 2000,
  })
  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between space-y-0'>
        <div>
          <CardTitle>事件日志</CardTitle>
          <CardDescription>持久化在本机 events.db，每 2 秒刷新</CardDescription>
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value='all'>全部</TabsTrigger>
            <TabsTrigger value='action'>动作</TabsTrigger>
            <TabsTrigger value='recognized'>识别</TabsTrigger>
            <TabsTrigger value='monitor'>监控开关</TabsTrigger>
          </TabsList>
        </Tabs>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <p className='py-6 text-center text-sm text-muted-foreground'>暂无记录</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className='w-40'>时间</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>人员</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>详情</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className='text-muted-foreground'>
                    {new Date(r.ts * 1000).toLocaleString('zh-CN', { hour12: false })}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.kind === 'action' ? 'destructive' : r.kind === 'recognized' ? 'secondary' : 'outline'}>
                      {KIND[r.kind] ?? r.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>{r.name ?? '—'}</TableCell>
                  <TableCell>
                    {r.role ? <Badge variant={ROLE_VARIANT[r.role] ?? 'outline'}>{ROLE_LABEL[r.role] ?? r.role}</Badge> : '—'}
                  </TableCell>
                  <TableCell className='max-w-[520px] truncate text-sm'>{describe(r)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
