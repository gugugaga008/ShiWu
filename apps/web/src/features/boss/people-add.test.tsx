import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { usePhotoAdd } from '@/hooks/use-photo-add'
import { type Capture, type Cluster } from '@/lib/api'
import { PeopleAdd } from './people-add'
import { type SourceValue } from './source-picker'
import '@/styles/index.css'

const requests = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }))
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: requests }))
vi.mock('sonner', () => ({ toast: notifications }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a> }))
vi.mock('./page', () => ({ Page: ({ children }: { children: ReactNode }) => <main>{children}</main> }))
vi.mock('./source-picker', () => ({
  SourcePicker: ({ value, onChange, kinds = ['file', 'camera', 'url'] }: { value: SourceValue; onChange: (value: SourceValue) => void; kinds?: SourceValue['kind'][] }) => (
    <div>
      <label>测试源类型<select aria-label='测试源类型' value={value.kind} onChange={(event) => onChange({ kind: event.target.value as SourceValue['kind'], uri: '' })}>
        {kinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
      </select></label>
      <label>测试画面源<input aria-label='测试画面源' value={value.uri} onChange={(event) => onChange({ ...value, uri: event.target.value })} /></label>
    </div>
  ),
}))
const clients: QueryClient[] = []
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(qc)
  qc.setQueryData(['captures'], [])
  qc.setQueryData(['people'], [])
  return qc
}
function form(qc: QueryClient, initialMode?: 'photo' | 'file' | 'live') {
  return <StrictMode><QueryClientProvider client={qc}><PeopleAdd initialMode={initialMode} /></QueryClientProvider></StrictMode>
}
function photos(...names: string[]) {
  const input = document.querySelector<HTMLInputElement>('#photo-person-files')!
  const files = new DataTransfer()
  names.forEach((name) => files.items.add(new File(['test-photo'], name, { type: 'image/jpeg' })))
  input.files = files.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
function cluster(overrides: Partial<Cluster> = {}): Cluster {
  return { id: 1, size: 3, status: 'pending', person_id: null, name: null, role: null, tracks: [1], quality_ok: 3,
    time_range: [0, 1], known_person_id: null, known_similarity: 0, cover_sample_id: 1, thumbs: [], ...overrides }
}
function capture(kind: 'file' | 'camera' | 'url', status = 'ready', clusters = [cluster()]): Capture {
  return { id: `${kind}-session`, status, source: { kind, uri: `${kind}-source` }, progress: 0.5, error: null, stats: {},
    created_at: 1, clusters, noise_count: 0 }
}
function seedSessions(qc: QueryClient, sessions: Capture[]) {
  qc.setQueryData(['captures'], sessions)
  sessions.forEach((session) => qc.setQueryData(['capture', session.id], session))
  requests.get.mockImplementation(async (url: string) => ({ data: url === '/captures' ? sessions : url === '/people' ? [] : sessions.find((session) => url === `/captures/${session.id}`) }))
}
beforeEach(() => {
  usePhotoAdd.getState().reset()
  requests.get.mockResolvedValue({ data: [] })
  requests.post.mockImplementation(async (url: string) => ({ data: url === '/people'
    ? { person_id: 'p-new', name: '王五', role: 'boss' }
    : { accepted: 2, rejected: [] } }))
})
afterEach(async () => {
  await cleanup()
  clients.splice(0).forEach((qc) => qc.clear())
  vi.resetAllMocks()
})

describe('照片添加人员', () => {
  it('姓名、分组与多张照片均需填写，trim 后保留 role 协议并上传文件', async () => {
    const screen = await render(form(client()))
    const submit = screen.getByRole('button', { name: '上传并添加人员' })
    await expect.element(screen.getByRole('button', { name: '照片添加', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect.element(submit).toBeDisabled()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('   ')
    photos('front.jpg', 'side.jpg')
    await expect.element(submit).toBeDisabled()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill(' 王五 ')
    await screen.getByRole('combobox', { name: '分组', exact: true }).click()
    await screen.getByRole('option', { name: '老板', exact: true }).click()
    await submit.click()
    await expect.poll(() => requests.post.mock.calls.length).toBe(2)
    expect(requests.post.mock.calls[0]).toEqual(['/people', { name: '王五', role: 'boss' }])
    const [url, body] = requests.post.mock.calls[1] as [string, FormData]
    expect(url).toBe('/people/p-new/photos')
    expect([...body.keys()]).toEqual(['files', 'files'])
    expect(body.getAll('files').map((file) => (file as File).name)).toEqual(['front.jpg', 'side.jpg'])
    await expect.element(screen.getByRole('status')).toHaveTextContent('本次通过 2 张')
    expect(requests.put).not.toHaveBeenCalled()
    expect(requests.delete).not.toHaveBeenCalled()
  })

  it('没有选择照片时不能仅创建空人员', async () => {
    const screen = await render(form(client()))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    await expect.element(screen.getByRole('button', { name: '上传并添加人员' })).toBeDisabled()
    expect(requests.post).not.toHaveBeenCalled()
  })

  it('明确的上传校验失败后保留身份与文件，切换模式再重试不会重复创建或改名改组', async () => {
    requests.post.mockImplementation(async (url: string) => {
      if (url === '/people') return { data: { person_id: 'retained', name: '王五', role: 'staff' } }
      throw { response: { status: 422, data: { detail: 'invalid image' } } }
    })
    const screen = await render(form(client()))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('可修改后重试上传')
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toBeDisabled()
    await expect.element(screen.getByRole('combobox', { name: '分组', exact: true })).toBeDisabled()
    await screen.getByRole('button', { name: '现场采集添加', exact: true }).click()
    await screen.getByRole('button', { name: '照片添加', exact: true }).click()
    requests.post.mockResolvedValue({ data: { accepted: 1, rejected: [] } })
    await screen.getByRole('button', { name: '重试 / 补录照片' }).click()
    await expect.poll(() => requests.post.mock.calls.map(([url]) => url)).toEqual(['/people', '/people/retained/photos', '/people/retained/photos'])
    expect(requests.put).not.toHaveBeenCalled()
    expect(requests.delete).not.toHaveBeenCalled()
    await expect.poll(() => notifications.success.mock.calls.length).toBe(1)
  })

  it('0 accepted 不提示成功，不自动删除人员，更换照片后向相同 ID 重试', async () => {
    requests.post.mockImplementation(async (url: string) => ({ data: url === '/people'
      ? { person_id: 'p-new', name: '王五', role: 'staff' }
      : { accepted: 0, rejected: [{ source: 'bad.jpg', reasons: ['no_face'] }] } }))
    const screen = await render(form(client()))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('bad.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('未录入任何照片')
    expect(notifications.success).not.toHaveBeenCalled()
    expect(requests.delete).not.toHaveBeenCalled()
    photos('good.jpg')
    requests.post.mockResolvedValue({ data: { accepted: 1, rejected: [] } })
    await screen.getByRole('button', { name: '重试 / 补录照片' }).click()
    await expect.poll(() => requests.post.mock.calls.length).toBe(3)
    expect(requests.post.mock.calls[2][0]).toBe('/people/p-new/photos')
    expect((requests.post.mock.calls[2][1] as FormData).get('files')).toHaveProperty('name', 'good.jpg')
    await expect.element(screen.getByRole('status')).toHaveTextContent('本次通过 1 张')
  })

  it('部分照片通过时准确展示数量和拒绝原因，继续补录不会新建，下一位需重新填姓名与照片', async () => {
    requests.post.mockImplementation(async (url: string) => ({ data: url === '/people'
      ? { person_id: 'p-new', name: '王五', role: 'staff' }
      : { accepted: 1, rejected: [{ source: 'bad.jpg', reasons: ['no_face'] }] } }))
    const screen = await render(form(client()))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg', 'bad.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('status')).toHaveTextContent('本次通过 1 张，拒绝 1 张')
    await expect.element(screen.getByText('未通过：bad.jpg（no_face）')).toBeVisible()
    photos('side.jpg')
    await screen.getByRole('button', { name: '重试 / 补录照片' }).click()
    await expect.poll(() => requests.post.mock.calls.length).toBe(3)
    expect(requests.post.mock.calls[2][0]).toBe('/people/p-new/photos')
    await screen.getByRole('button', { name: '添加下一位' }).click()
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('')
    await expect.element(screen.getByRole('button', { name: '上传并添加人员' })).toBeDisabled()
    expect(requests.delete).not.toHaveBeenCalled()
  })

  it('上传期间禁用身份、文件和再次提交，不重复创建或丢失切换前任务', async () => {
    let finish!: (result: { data: { accepted: number; rejected: [] } }) => void
    requests.post.mockImplementation(async (url: string) => url === '/people'
      ? { data: { person_id: 'p-new', name: '王五', role: 'staff' } }
      : new Promise((resolve) => { finish = resolve }))
    const screen = await render(form(client()))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('button', { name: '正在上传…' })).toBeDisabled()
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toBeDisabled()
    expect(document.querySelector<HTMLInputElement>('#photo-person-files')!.disabled).toBe(true)
    await screen.getByRole('button', { name: '视频文件添加', exact: true }).click()
    finish({ data: { accepted: 1, rejected: [] } })
    await screen.getByRole('button', { name: '照片添加', exact: true }).click()
    await expect.element(screen.getByRole('status')).toHaveTextContent('本次通过 1 张')
    expect(requests.post).toHaveBeenCalledTimes(2)
    expect(requests.delete).not.toHaveBeenCalled()
  })

  it('明确的创建校验失败允许修改后重试，不错误锁死表单', async () => {
    requests.post.mockRejectedValueOnce({ response: { status: 422, data: { detail: '姓名校验失败' } } })
    const screen = await render(form(client()))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('创建失败：姓名校验失败')
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toBeEnabled()
    await expect.element(screen.getByRole('button', { name: '上传并添加人员' })).toBeEnabled()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('李四')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('status')).toHaveTextContent('本次通过 2 张')
    expect(requests.post.mock.calls.filter(([url]) => url === '/people')).toHaveLength(2)
    expect(requests.delete).not.toHaveBeenCalled()
  })

  it('在途创建跨路由保留锁与原任务，返回后不会重复提交', async () => {
    let finish!: (value: unknown) => void
    requests.post.mockImplementation(async (url: string) => url === '/people'
      ? new Promise((resolve) => { finish = resolve }) : { data: { accepted: 1, rejected: [] } })
    const qc = client()
    const screen = await render(form(qc))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await cleanup()
    const returned = await render(form(qc))
    await expect.element(returned.getByRole('button', { name: '正在上传…' })).toBeDisabled()
    expect(requests.post).toHaveBeenCalledTimes(1)
    finish({ data: { person_id: 'in-flight', name: '王五', role: 'staff' } })
    await expect.element(returned.getByRole('status')).toHaveTextContent('本次通过 1 张')
    expect(requests.post.mock.calls.map(([url]) => url)).toEqual(['/people', '/people/in-flight/photos'])
  })

  it.each([undefined, 500])('上传网络/5xx结果不明（%s）阻止原批次重发，跨路由保留身份与保护', async (status) => {
    requests.post.mockImplementation(async (url: string) => {
      if (url === '/people') return { data: { person_id: 'retained', name: '王五', role: 'staff' } }
      throw status ? { response: { status } } : new Error('response lost')
    })
    const qc = client()
    const screen = await render(form(qc))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('上传结果无法确认')
    await cleanup()
    const returned = await render(form(qc))
    await expect.element(returned.getByRole('button', { name: '重试 / 补录照片' })).toBeDisabled()
    await expect.element(returned.getByRole('button', { name: '添加下一位' })).toBeDisabled()
    await expect.element(returned.getByRole('button', { name: '已核对，选择新照片' })).toBeDisabled()
    await returned.getByRole('checkbox', { name: '我已核对人员及模板数量' }).click()
    await returned.getByRole('button', { name: '已核对，选择新照片' }).click()
    await expect.element(returned.getByRole('button', { name: '重试 / 补录照片' })).toBeDisabled()
    photos('new-angle.jpg')
    requests.post.mockResolvedValue({ data: { accepted: 1, rejected: [] } })
    await returned.getByRole('button', { name: '重试 / 补录照片' }).click()
    await expect.element(returned.getByRole('status')).toHaveTextContent('本次通过 1 张')
    expect(requests.post.mock.calls.map(([url]) => url)).toEqual(['/people', '/people/retained/photos', '/people/retained/photos'])
    expect((requests.post.mock.calls[2][1] as FormData).get('files')).toHaveProperty('name', 'new-angle.jpg')
    expect(requests.delete).not.toHaveBeenCalled()
  })

  it('创建不明跨路由仍锁止，核对并选择已有人员后只向该 ID 补录', async () => {
    const person = { person_id: 'created-before-disconnect', name: '王五', role: 'staff' }
    requests.get.mockResolvedValue({ data: [person] })
    requests.post.mockRejectedValue(new Error('response lost'))
    const qc = client()
    qc.setQueryData(['people'], [person])
    const screen = await render(form(qc))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('创建结果无法确认')
    await cleanup()
    const returned = await render(form(qc))
    await expect.element(returned.getByRole('button', { name: '上传并添加人员' })).toBeDisabled()
    await returned.getByRole('combobox', { name: '核对后选择已有人员' }).click()
    await returned.getByRole('option', { name: '王五 · 同事' }).click()
    await expect.element(returned.getByRole('button', { name: '使用所选人员继续补录' })).toBeDisabled()
    await returned.getByRole('checkbox', { name: '我已核对人员及模板数量' }).click()
    await returned.getByRole('button', { name: '使用所选人员继续补录' }).click()
    requests.post.mockResolvedValue({ data: { accepted: 1, rejected: [] } })
    await returned.getByRole('button', { name: '重试 / 补录照片' }).click()
    await expect.element(returned.getByRole('status')).toHaveTextContent('本次通过 1 张')
    expect(requests.post.mock.calls.map(([url]) => url)).toEqual(['/people', '/people/created-before-disconnect/photos'])
    await returned.getByRole('button', { name: '添加下一位' }).click()
    await returned.getByRole('textbox', { name: '姓名', exact: true }).fill('下一位乙')
    photos('b.jpg')
    requests.post.mockRejectedValue({ response: { status: 500 } })
    await returned.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(returned.getByRole('alert')).toHaveTextContent('创建结果无法确认')
    await expect.element(returned.getByRole('combobox', { name: '核对后选择已有人员' })).toHaveTextContent('选择已创建的人员以继续补录')
    await expect.element(returned.getByRole('checkbox', { name: '我已核对人员及模板数量' })).not.toBeChecked()
    await returned.getByRole('checkbox', { name: '我已核对人员及模板数量' }).click()
    await expect.element(returned.getByRole('button', { name: '使用所选人员继续补录' })).toBeDisabled()
    expect(requests.post.mock.calls.map(([url]) => url)).toEqual(['/people', '/people/created-before-disconnect/photos', '/people'])
  })

  it('创建响应不明时不自动重发创建，避免重试导致重复人员', async () => {
    requests.post.mockRejectedValue(new Error('connection lost'))
    const screen = await render(form(client()))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    photos('front.jpg')
    await screen.getByRole('button', { name: '上传并添加人员' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('创建结果无法确认')
    await expect.element(screen.getByRole('button', { name: '上传并添加人员' })).toBeDisabled()
    expect(requests.post).toHaveBeenCalledTimes(1)
    expect(notifications.success).not.toHaveBeenCalled()
    expect(requests.delete).not.toHaveBeenCalled()
  })
})

describe('视频 / 现场采集的共享工作区', () => {
  it('文件模式仅允许 file；现场模式仅允许 camera/url，提交实际 kind', async () => {
    const qc = client()
    const sessions: Capture[] = []
    requests.post.mockImplementation(async (_url: string, body: { kind: 'file' | 'camera' | 'url' }) => {
      const session = capture(body.kind, 'recording')
      sessions.unshift(session)
      return { data: session }
    })
    requests.get.mockImplementation(async (url: string) => ({ data: url === '/captures' ? [...sessions] : sessions.find((session) => url === `/captures/${session.id}`) }))
    const screen = await render(form(qc, 'file'))
    await expect.element(screen.getByRole('button', { name: '视频文件添加', exact: true })).toHaveAttribute('aria-pressed', 'true')
    expect([...document.querySelectorAll('section[aria-label="视频文件添加工作区"] option')].map((option) => option.textContent)).toEqual(['file'])
    expect([...document.querySelectorAll('section[aria-label="现场采集添加工作区"] option')].map((option) => option.textContent)).toEqual(['camera', 'url'])
    await screen.getByRole('textbox', { name: '测试画面源' }).fill('test.mp4')
    await screen.getByRole('button', { name: '开始分析' }).click()
    await expect.poll(() => requests.post.mock.calls[0]).toEqual(['/captures', { kind: 'file', uri: 'test.mp4', duration_s: 15 }])
    await screen.getByRole('button', { name: '现场采集添加', exact: true }).click()
    await screen.getByRole('textbox', { name: '测试画面源' }).fill('camera-1')
    await screen.getByRole('button', { name: '开始采集' }).click()
    await expect.poll(() => requests.post.mock.calls[1]).toEqual(['/captures', { kind: 'camera', uri: 'camera-1', duration_s: 15 }])
    await screen.getByRole('button', { name: '视频文件添加', exact: true }).click()
    await expect.element(screen.getByRole('textbox', { name: '测试画面源' })).toHaveValue('test.mp4')
    await expect.element(screen.getByRole('button', { name: '开始分析' })).toBeDisabled()
  })

  it('现场网络流使用 url 协议，时长必须在 3–120 秒内', async () => {
    const qc = client()
    const sessions: Capture[] = []
    requests.get.mockImplementation(async (url: string) => ({ data: url === '/captures' ? sessions : sessions[0] }))
    requests.post.mockImplementation(async () => {
      const session = capture('url', 'recording', [])
      sessions.push(session)
      return { data: session }
    })
    const screen = await render(form(qc, 'live'))
    await screen.getByRole('combobox', { name: '测试源类型' }).selectOptions('url')
    await screen.getByRole('textbox', { name: '测试画面源' }).fill('rtsp://example.invalid/live')
    const duration = screen.getByRole('spinbutton', { name: '录制时长（秒）' })
    await duration.fill('0')
    await expect.element(screen.getByRole('button', { name: '开始采集' })).toBeDisabled()
    await duration.fill('121')
    await expect.element(screen.getByRole('button', { name: '开始采集' })).toBeDisabled()
    await duration.fill('30')
    await screen.getByRole('button', { name: '开始采集' }).click()
    await expect.poll(() => requests.post.mock.calls[0]).toEqual(['/captures', { kind: 'url', uri: 'rtsp://example.invalid/live', duration_s: 30 }])
  })

  it('路由初始模式变化只切换工作区，已输入草稿不丢失', async () => {
    const qc = client()
    seedSessions(qc, [capture('file')])
    const screen = await render(form(qc, 'photo'))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('照片草稿')
    await screen.rerender(form(qc, 'file'))
    await expect.element(screen.getByRole('button', { name: '视频文件添加', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('视频草稿')
    await screen.rerender(form(qc, 'live'))
    await expect.element(screen.getByRole('button', { name: '现场采集添加', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await screen.getByRole('button', { name: '照片添加', exact: true }).click()
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('照片草稿')
    await screen.getByRole('button', { name: '视频文件添加', exact: true }).click()
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('视频草稿')
  })

  it('按源类型恢复各自任务，三模式切换不会丢失候选姓名、分组与合并选择', async () => {
    const qc = client()
    seedSessions(qc, [capture('camera'), capture('file', 'ready', [cluster(), cluster({ id: 2 })])])
    const screen = await render(form(qc, 'file'))
    const names = screen.getByRole('textbox', { name: '姓名', exact: true })
    await names.nth(0).fill('文件人物')
    await screen.getByRole('combobox', { name: '分组', exact: true }).nth(0).click()
    await screen.getByRole('option', { name: '领导', exact: true }).click()
    const fileSection = document.querySelector('section[aria-label="视频文件添加工作区"]')!
    const checks = fileSection.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')
    checks[0].click()
    checks[1].click()
    await expect.element(screen.getByRole('button', { name: '合并选中（2）' })).toBeEnabled()
    await screen.getByRole('button', { name: '现场采集添加', exact: true }).click()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('现场人物')
    await screen.getByRole('button', { name: '照片添加', exact: true }).click()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('照片人物')
    await screen.getByRole('button', { name: '视频文件添加', exact: true }).click()
    await expect.element(names.nth(0)).toHaveValue('文件人物')
    await expect.element(screen.getByRole('combobox', { name: '分组', exact: true }).nth(0)).toHaveTextContent('领导')
    await expect.element(screen.getByRole('button', { name: '合并选中（2）' })).toBeEnabled()
    await screen.getByRole('button', { name: '合并选中（2）' }).click()
    await expect.poll(() => requests.post.mock.calls[0]).toEqual(['/captures/file-session/merge', { cluster_ids: [1, 2] }])
    await screen.getByRole('button', { name: '按轨迹拆分' }).nth(0).click()
    await expect.poll(() => requests.post.mock.calls[1]).toEqual(['/captures/file-session/clusters/1/split', { by_track: true }])
    await screen.getByRole('button', { name: '现场采集添加', exact: true }).click()
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('现场人物')
    await screen.getByRole('button', { name: '照片添加', exact: true }).click()
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('照片人物')
  })

  it('录制和聚类任务切换后继续展示进度，现场不会展示文件任务', async () => {
    const qc = client()
    const file = capture('file', 'recording', [])
    const live = capture('url', 'clustering', [])
    seedSessions(qc, [live, file])
    const screen = await render(form(qc, 'file'))
    await expect.element(screen.getByText('录制分析中', { exact: true })).toBeVisible()
    await expect.element(screen.getByText('进度 50%')).toBeVisible()
    await screen.getByRole('button', { name: '现场采集添加', exact: true }).click()
    await expect.element(screen.getByText('聚类中', { exact: true })).toBeVisible()
    await screen.getByRole('button', { name: '照片添加', exact: true }).click()
    qc.setQueryData(['capture', file.id], { ...file, status: 'ready', clusters: [cluster()] })
    await screen.getByRole('button', { name: '视频文件添加', exact: true }).click()
    await expect.element(screen.getByRole('button', { name: '确认姓名与分组并入库' })).toBeDisabled()
    await expect.element(screen.getByText('待标记', { exact: true })).toBeVisible()
  })
})
