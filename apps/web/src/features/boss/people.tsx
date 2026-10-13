import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ImagePlus, Pencil, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { api, errMsg, type Person } from '@/lib/api'
import { Page } from './page'

export function People() {
  const qc = useQueryClient()
  const { data: people = [], isLoading } = useQuery({
    queryKey: ['people'],
    queryFn: async () => (await api.get<Person[]>('/people')).data,
  })
  const inv = () => {
    qc.invalidateQueries({ queryKey: ['people'] })
    qc.invalidateQueries({ queryKey: ['status'] })
  }
  const [newName, setNewName] = useState('')
  const create = useMutation({
    mutationFn: async () => (await api.post('/people', { name: newName, role: 'staff' })).data,
    onSuccess: () => {
      setNewName('')
      toast.success('已新建，请补录照片')
      inv()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <Page title='人员管理' desc='改名、改角色、补录照片（经质量门槛）或删除'>
      <div className='mb-3 flex max-w-md gap-2'>
        <Input placeholder='新建人员姓名' value={newName} onChange={(e) => setNewName(e.target.value)} />
        <Button disabled={!newName} onClick={() => create.mutate()}>
          <UserPlus /> 新建
        </Button>
      </div>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>姓名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>人脸模板</TableHead>
                <TableHead>注册时间</TableHead>
                <TableHead className='text-end'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={5}>加载中…</TableCell>
                </TableRow>
              )}
              {people.map((p) => (
                <PersonRow key={p.person_id} p={p} onChanged={inv} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Page>
  )
}

function PersonRow({ p, onChanged }: { p: Person; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(p.name)
  const [del, setDel] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const update = useMutation({
    mutationFn: async (body: { name?: string; role?: string }) => (await api.put(`/people/${p.person_id}`, body)).data,
    onSuccess: () => {
      setEditing(false)
      toast.success('已保存')
      onChanged()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const remove = useMutation({
    mutationFn: async () => (await api.delete(`/people/${p.person_id}`)).data,
    onSuccess: () => {
      setDel(false)
      toast.success('已删除')
      onChanged()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const upload = useMutation({
    mutationFn: async (files: FileList) => {
      const fd = new FormData()
      Array.from(files).forEach((f) => fd.append('files', f))
      return (await api.post(`/people/${p.person_id}/photos`, fd)).data
    },
    onSuccess: (d) => {
      toast.success(`补录完成：通过 ${d.accepted} 张，拒绝 ${d.rejected?.length ?? 0} 张`)
      onChanged()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  return (
    <TableRow>
      <TableCell>
        {editing ? (
          <div className='flex gap-1'>
            <Input className='h-8 w-40' value={name} onChange={(e) => setName(e.target.value)} />
            <Button size='icon' variant='ghost' onClick={() => update.mutate({ name })}>
              <Check />
            </Button>
          </div>
        ) : (
          <span className='font-medium'>{p.name}</span>
        )}
      </TableCell>
      <TableCell>
        <Select value={p.role ?? 'none'} onValueChange={(role) => update.mutate({ role })}>
          <SelectTrigger className='h-8 w-28'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='none' disabled>
              未设置
            </SelectItem>
            <SelectItem value='boss'>老板</SelectItem>
            <SelectItem value='leader'>领导</SelectItem>
            <SelectItem value='staff'>同事</SelectItem>
            <SelectItem value='whitelist'>白名单</SelectItem>
            <SelectItem value='ignore'>忽略</SelectItem>
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        {p.templates > 0 || p.has_face_data ? (
          <Badge variant='secondary'>{p.templates} 张</Badge>
        ) : (
          <Badge variant='outline'>未录入</Badge>
        )}
      </TableCell>
      <TableCell className='text-muted-foreground'>
        {p.joined_at ? new Date(p.joined_at).toLocaleString('zh-CN', { hour12: false }) : '—'}
      </TableCell>
      <TableCell className='text-end'>
        <input
          ref={fileRef}
          type='file'
          accept='image/*'
          multiple
          hidden
          onChange={(e) => e.target.files?.length && upload.mutate(e.target.files)}
        />
        <Button size='sm' variant='ghost' onClick={() => setEditing((v) => !v)}>
          <Pencil /> 改名
        </Button>
        <Button size='sm' variant='ghost' disabled={upload.isPending} onClick={() => fileRef.current?.click()}>
          <ImagePlus /> 补录
        </Button>
        <Button size='sm' variant='ghost' className='text-destructive' onClick={() => setDel(true)}>
          <Trash2 /> 删除
        </Button>
        <ConfirmDialog
          open={del}
          onOpenChange={setDel}
          title={`删除「${p.name}」？`}
          desc='将同时删除其人脸数据与全部模板，不可恢复。'
          destructive
          confirmText='删除'
          handleConfirm={() => remove.mutate()}
        />
      </TableCell>
    </TableRow>
  )
}
