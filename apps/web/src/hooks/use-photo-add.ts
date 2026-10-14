import { create } from 'zustand'
import { toast } from 'sonner'
import { api, errMsg, type Person } from '@/lib/api'

type PhotoReport = { accepted: number; rejected?: { source?: string; reasons?: string[] }[] }
const emptyDraft = () => ({
  name: '', role: 'staff', files: [] as File[], person: null as Person | null,
  report: null as PhotoReport | null, error: '', pending: false,
  creationUncertain: false, uploadUncertain: false, supplementing: false,
})
type Draft = ReturnType<typeof emptyDraft>
type PhotoAddState = Draft & {
  update: (patch: Partial<Pick<Draft, 'name' | 'role' | 'files'>>) => void
  submit: () => Promise<void>
  reset: () => void
  resumePerson: (person: Person) => void
  beginSupplement: (person: Person) => void
  clearUncertainUpload: () => void
  dropGonePerson: () => void
}

// 只在当前窗口内存保留流程；路由卸载不会丢失在途请求、人员 ID 或结果不明保护。
export const usePhotoAdd = create<PhotoAddState>((set, get) => ({
  ...emptyDraft(),
  update: (patch) => { if (!get().pending) set(patch) },
  reset: () => { if (!get().pending) set(emptyDraft()) },
  resumePerson: (person) => {
    if (!get().pending && get().creationUncertain) {
      set({ person, name: person.name, role: person.role ?? '', creationUncertain: false, error: '' })
    }
  },
  beginSupplement: (person) => {
    if (!get().pending) {
      set({ ...emptyDraft(), person, name: person.name, role: person.role ?? 'staff', supplementing: true })
    }
  },
  clearUncertainUpload: () => {
    if (!get().pending) set({ files: [], uploadUncertain: false, report: null, error: '' })
  },
  dropGonePerson: () => {
    if (!get().pending && get().person) {
      set({ person: null, report: null, error: '', creationUncertain: false, uploadUncertain: false })
    }
  },
  submit: async () => {
    const draft = get()
    if (draft.pending || draft.creationUncertain || draft.uploadUncertain || !draft.name.trim() || !draft.files.length) return
    set({ pending: true, report: null, error: '' })
    let creating = !draft.person
    let target = draft.person
    try {
      if (!target) {
        target = (await api.post<Person>('/people', { name: draft.name.trim(), role: draft.role })).data
        if (!target?.person_id) throw new Error('创建结果未返回人员 ID')
        set({ person: target })
      }
      creating = false
      const body = new FormData()
      draft.files.forEach((file) => body.append('files', file))
      const result = (await api.post<PhotoReport>(`/people/${target.person_id}/photos`, body)).data
      if (!Number.isInteger(result?.accepted) || result.accepted < 0) throw new Error('上传结果不完整')
      set({ report: result })
      if (result.accepted > 0) {
        const rejected = result.rejected?.length ?? 0
        toast.success(`已录入：${target.name}，通过 ${result.accepted} 张${rejected ? `，拒绝 ${rejected} 张` : ''}`)
        if (get().supplementing) set({ files: [], report: result, error: '' })
        else set(emptyDraft())
      } else {
        const message = '未录入任何照片；人员已保留，请更换清晰正脸照片后重试，不会重复创建人员。'
        set({ error: message })
        toast.error(message)
      }
    } catch (cause) {
      const status = (cause as { response?: { status?: number } } | null)?.response?.status
      // 照片可能已部分入库：只有明确的前置拒绝才允许直接重试，网络/5xx 不盲目重发。
      const gone = !creating && status === 404
      const definitelyRejected = creating
        ? !!status && status >= 400 && status < 500 && status !== 408
        : !!status && [401, 403, 404, 413, 415, 422].includes(status)
      const creationUncertain = creating && !definitelyRejected
      const uploadUncertain = !creating && !definitelyRejected && !gone
      const message = creationUncertain
        ? '创建结果无法确认，请先到人员列表核对；为避免重复创建，当前表单不会再次创建人员。'
        : uploadUncertain
          ? '上传结果无法确认，照片可能已入库；请先核对人员列表及模板数量，不要刷新或重发原批次。'
          : gone
            ? `上传失败：${errMsg(cause)}。该人员已不存在，可修改后重新添加。`
            : target
              ? `上传失败：${errMsg(cause)}。人员已保留，可修改后重试上传。`
              : `创建失败：${errMsg(cause)}。请修改后重试。`
      set({ person: gone ? null : target, creationUncertain, uploadUncertain, error: message })
      toast.error(message)
    } finally {
      set({ pending: false })
    }
  },
}))
