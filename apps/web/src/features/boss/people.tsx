import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Check, ImagePlus, Pencil, Trash2, UserPlus, UserRound, Users } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { usePhotoAdd } from '@/hooks/use-photo-add'
import { api, errMsg, type Person, withToken } from '@/lib/api'
import { Page } from './page'
import { SnapshotDialog } from './snapshot-dialog'

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
  return (
    <Page title='人员管理' desc='姓名用于区分个人，老板/领导/同事是分组；补录照片不会修改姓名或分组'>
      <div className='mb-3'>
        <Button asChild><Link to='/people/add'><UserPlus /> 添加人员</Link></Button>
      </div>
      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>照片</TableHead>
                <TableHead><span className='flex items-center gap-1.5'><UserRound className='size-4' />姓名</span></TableHead>
                <TableHead><span className='flex items-center gap-1.5'><Users className='size-4' />分组</span></TableHead>
                <TableHead>人脸模板</TableHead>
                <TableHead>注册时间</TableHead>
                <TableHead className='text-end'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={6}>加载中…</TableCell>
                </TableRow>
              )}
              {!isLoading && people.length === 0 && (
                <TableRow><TableCell colSpan={6} className='py-8 text-center text-muted-foreground'>
                  <span className='inline-flex items-center gap-2'><Users className='size-5' />暂无人员，请点击「添加人员」录入照片或采集。</span>
                </TableCell></TableRow>
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
  const [photoOpen, setPhotoOpen] = useState(false)
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
      const draft = usePhotoAdd.getState()
      if (draft.person?.person_id === p.person_id) draft.dropGonePerson()
      onChanged()
    },
    onError: (e) => toast.error(errMsg(e)),
  })
  const photoSrc = p.has_photo ? withToken(`/people/${p.person_id}/photo.jpg`) : ''
  return (
    <TableRow>
      <TableCell>
        {p.has_photo ? (
          <button type='button' className='rounded-full' onClick={() => setPhotoOpen(true)}>
            <Avatar className='size-10'>
              <AvatarImage src={photoSrc} alt={`${p.name}的照片`} />
              <AvatarFallback><UserRound className='size-4' /></AvatarFallback>
            </Avatar>
            <span className='sr-only'>查看{p.name}的照片</span>
          </button>
        ) : (
          <Avatar className='size-10'>
            <AvatarFallback><UserRound className='size-4' /></AvatarFallback>
          </Avatar>
        )}
        <SnapshotDialog open={photoOpen} onOpenChange={setPhotoOpen} title={p.name} description='人员照片' imageSrc={photoSrc} imageAlt={`${p.name}的照片`} />
      </TableCell>
      <TableCell>
        {editing ? (
          <div className='flex gap-1'>
            <Input aria-label={`修改${p.name}的姓名`} className='h-8 w-40' value={name} onChange={(e) => setName(e.target.value)} />
            <Button size='icon' variant='ghost' aria-label='保存姓名' disabled={!name.trim() || update.isPending} onClick={() => update.mutate({ name: name.trim() })}>
              <Check />
            </Button>
          </div>
        ) : (
          <span className='font-medium'>{p.name}</span>
        )}
      </TableCell>
      <TableCell>
        <Select value={p.role ?? 'none'} onValueChange={(role) => update.mutate({ role })}>
          <SelectTrigger aria-label={`${p.name}的分组`} className='h-8 w-28'>
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
        <Button size='sm' variant='ghost' onClick={() => { setName(p.name); setEditing((v) => !v) }}>
          <Pencil /> 编辑
        </Button>
        <Button size='sm' variant='ghost' asChild>
          <Link to='/people/add' search={{ person: p.person_id }}><ImagePlus /> 补录</Link>
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
