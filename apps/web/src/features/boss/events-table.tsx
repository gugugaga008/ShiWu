import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { type BossEvent, EVENT_LABEL, ROLE_LABEL, ROLE_VARIANT } from '@/lib/api'
import { fmtTime } from './live'

export function EventsTable({ events }: { events: BossEvent[] }) {
  if (!events.length) return <p className='py-6 text-center text-sm text-muted-foreground'>暂无事件</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>时间</TableHead>
          <TableHead>事件</TableHead>
          <TableHead>人员</TableHead>
          <TableHead>分组</TableHead>
          <TableHead className='text-end'>相似度</TableHead>
          <TableHead className='text-end'>视频源</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e, i) => {
          const role = (e.role ?? e.data?.role) as string | undefined
          const sim = e.data?.similarity as number | undefined
          return (
            <TableRow key={i}>
              <TableCell>{fmtTime(e.wall_time)}</TableCell>
              <TableCell>{EVENT_LABEL[e.type] ?? e.type}</TableCell>
              <TableCell>{(e.data?.name as string) ?? '—'}</TableCell>
              <TableCell>
                {role ? <Badge variant={ROLE_VARIANT[role] ?? 'outline'}>{ROLE_LABEL[role] ?? role}</Badge> : '—'}
              </TableCell>
              <TableCell className='text-end'>{sim != null ? sim.toFixed(3) : '—'}</TableCell>
              <TableCell className='text-end text-muted-foreground'>{e.source_id ? String(e.source_id).split('/').pop() : '—'}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
