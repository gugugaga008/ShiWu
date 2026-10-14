import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { type Capture, type Cluster, type Person } from '@/lib/api'
import { CaptureWorkspace } from './capture'
import { People } from './people'
import '@/styles/index.css'

const requests = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }))
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: requests }))
vi.mock('sonner', () => ({ toast: notifications }))
vi.mock('./source-picker', () => ({ SourcePicker: () => null }))
vi.mock('@tanstack/react-router', () => ({ Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }))
vi.mock('./page', () => ({
  Page: ({ children, desc }: { children: ReactNode; desc: string }) => <main><p>{desc}</p>{children}</main>,
}))

const clients: QueryClient[] = []
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  clients.push(qc)
  return qc
}
function form(qc: QueryClient, children: ReactNode) {
  return <StrictMode><QueryClientProvider client={qc}>{children}</QueryClientProvider></StrictMode>
}
function person(overrides: Partial<Person> = {}): Person {
  return { person_id: 'p1', name: '张三', role: 'staff', role_label: '同事', has_face_data: true, templates: 2, ...overrides }
}
function cluster(overrides: Partial<Cluster> = {}): Cluster {
  return { id: 1, size: 3, status: 'pending', person_id: null, name: null, role: null, tracks: [1], quality_ok: 3,
    time_range: [0, 1], known_person_id: null, known_similarity: 0, cover_sample_id: 1, thumbs: [], ...overrides }
}
function capture(c: Cluster, id = 'session-a'): Capture {
  return { id, status: 'ready', error: null, progress: 1, source: { kind: 'file', uri: 'test.mp4' }, stats: {},
    created_at: 1, clusters: [c], noise_count: 0 }
}
function seedCapture(c: Cluster, people: Person[] = []) {
  const qc = client()
  let current = capture(c)
  qc.setQueryData(['captures'], [current])
  qc.setQueryData(['capture', current.id], current)
  qc.setQueryData(['people'], people)
  requests.get.mockImplementation(async (url: string) => ({ data: url === '/people' ? people : url === '/captures' ? [current] : current }))
  requests.post.mockImplementation(async (_url: string, body: { person_id?: string; name?: string; role?: string }) => {
    const target = people.find((p) => p.person_id === body.person_id)
    const enrolled = { ...c, status: 'enrolled', person_id: target?.person_id ?? 'new-person',
      name: target?.name ?? body.name ?? null, role: target?.role ?? body.role ?? null }
    current = capture(enrolled)
    return { data: { ...enrolled, enrolled_templates: [{ sample_id: 1 }] } }
  })
  return qc
}

beforeEach(() => {
  requests.get.mockResolvedValue({ data: [] })
  requests.post.mockResolvedValue({ data: {} })
  requests.put.mockResolvedValue({ data: {} })
})
afterEach(async () => {
  await cleanup()
  clients.splice(0).forEach((qc) => qc.clear())
  vi.resetAllMocks()
})

describe('采集人员的姓名与分组', () => {
  it('新面孔必须独立填写姓名，分组不能替代；入库后显示姓名与分组', async () => {
    const qc = seedCapture(cluster())
    const screen = await render(form(qc, <CaptureWorkspace mode='file' />))
    const enroll = screen.getByRole('button', { name: '确认姓名与分组并入库' })
    await expect.element(screen.getByRole('combobox', { name: '分组' })).toHaveTextContent('老板')
    await expect.element(enroll).toBeDisabled()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('   ')
    await expect.element(enroll).toBeDisabled()
    expect(requests.post).not.toHaveBeenCalled()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill(' 李四 ')
    await screen.getByRole('combobox', { name: '分组' }).click()
    await screen.getByRole('option', { name: '领导', exact: true }).click()
    await enroll.click()
    await expect.poll(() => requests.post.mock.calls).toEqual([
      ['/captures/session-a/clusters/1/confirm', { action: 'enroll', name: '李四', role: 'leader' }],
    ])
    await expect.element(screen.getByText('李四', { exact: true })).toBeVisible()
    await expect.element(screen.getByText('分组：领导 · 已入库')).toBeVisible()
    await expect.poll(() => notifications.success.mock.calls[0][0]).toContain('李四（分组：领导）')
  })

  it('已有人员补录只发送 person_id，展示其当前姓名与分组，不意外改成老板', async () => {
    const qc = seedCapture(cluster({ known_person_id: 'p1', known_name: '旧姓名', known_similarity: 0.8 }), [person()])
    const screen = await render(form(qc, <CaptureWorkspace mode='file' />))
    await expect.element(screen.getByText('姓名：张三')).toBeVisible()
    await expect.element(screen.getByText('分组：同事')).toBeVisible()
    expect(document.querySelector('input:not([type]), input[type="text"]')).toBeNull()
    expect(document.querySelector('[role="combobox"]')).toBeNull()
    await screen.getByRole('button', { name: '补录到此人员' }).click()
    await expect.poll(() => requests.post.mock.calls).toEqual([
      ['/captures/session-a/clusters/1/confirm', { action: 'enroll', person_id: 'p1' }],
    ])
    await expect.element(screen.getByText('分组：同事 · 已入库')).toBeVisible()
    await expect.poll(() => notifications.success.mock.calls[0][0]).toContain('张三（分组：同事）')
  })

  it('取消补录后新建独立人员，不能自动复制疑似人员姓名；切回补录不发送新建草稿', async () => {
    const qc = seedCapture(cluster({ known_person_id: 'p1', known_name: '张三' }), [person()])
    const screen = await render(form(qc, <CaptureWorkspace mode='file' />))
    const attach = screen.getByRole('checkbox', { name: /补录到已有人员/ })
    await attach.click()
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('')
    await expect.element(screen.getByRole('button', { name: '确认姓名与分组并入库' })).toBeDisabled()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('王五')
    await attach.click()
    await screen.getByRole('button', { name: '补录到此人员' }).click()
    await expect.poll(() => requests.post.mock.calls[0][1]).toEqual({ action: 'enroll', person_id: 'p1' })
  })

  it('取消补录后可独立新建姓名与分组，不向疑似人员发起修改', async () => {
    const qc = seedCapture(cluster({ known_person_id: 'p1', known_name: '张三' }), [person()])
    const screen = await render(form(qc, <CaptureWorkspace mode='file' />))
    await screen.getByRole('checkbox', { name: /补录到已有人员/ }).click()
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('李四')
    await screen.getByRole('combobox', { name: '分组' }).click()
    await screen.getByRole('option', { name: '同事', exact: true }).click()
    await screen.getByRole('button', { name: '确认姓名与分组并入库' }).click()
    await expect.poll(() => requests.post.mock.calls[0][1]).toEqual({ action: 'enroll', name: '李四', role: 'staff' })
    expect(requests.put).not.toHaveBeenCalled()
    await expect.element(screen.getByText('李四', { exact: true })).toBeVisible()
  })

  it('异步人员查询更新补录展示，不使用候选草稿冒充已有人员', async () => {
    const qc = seedCapture(cluster({ known_person_id: 'p1', known_name: '张三' }))
    requests.get.mockImplementation(() => new Promise(() => {}))
    const screen = await render(form(qc, <CaptureWorkspace mode='file' />))
    await expect.element(screen.getByText('分组：加载中…')).toBeVisible()
    qc.setQueryData(['people'], [person({ name: '王五', role: 'leader' })])
    await expect.element(screen.getByText('姓名：王五')).toBeVisible()
    await expect.element(screen.getByText('分组：领导')).toBeVisible()
  })

  it('切换采集会话后相同簇编号不会沿用上一人的姓名', async () => {
    const qc = seedCapture(cluster())
    const screen = await render(form(qc, <CaptureWorkspace mode='file' />))
    await screen.getByRole('textbox', { name: '姓名', exact: true }).fill('上一位')
    const second = capture(cluster(), 'session-b')
    qc.setQueryData(['capture', 'session-b'], second)
    qc.setQueryData(['captures'], [second])
    await expect.element(screen.getByRole('textbox', { name: '姓名', exact: true })).toHaveValue('')
  })
})

describe('人员管理的姓名与分组', () => {
  it('人员列表仅展示管理与添加入口，不再直接新建空人员', async () => {
    const qc = client()
    qc.setQueryData(['people'], [])
    const screen = await render(form(qc, <People />))
    expect(document.querySelector('thead')?.textContent).toContain('分组')
    await expect.element(screen.getByRole('link', { name: '添加人员' })).toHaveAttribute('href', '/people/add')
    expect(document.querySelector('#new-person-name')).toBeNull()
    expect(document.querySelector('#new-person-group')).toBeNull()
    expect(requests.post).not.toHaveBeenCalled()
  })

  it('调整分组仅提交 role，显式改名只提交 name', async () => {
    const qc = client()
    qc.setQueryData(['people'], [person()])
    requests.get.mockResolvedValue({ data: [person()] })
    const screen = await render(form(qc, <People />))
    await screen.getByRole('combobox', { name: '张三的分组' }).click()
    await screen.getByRole('option', { name: '领导', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls[0]).toEqual(['/people/p1', { role: 'leader' }])
    await screen.getByRole('button', { name: '改名', exact: true }).click()
    await screen.getByRole('textbox', { name: '修改张三的姓名' }).fill('  ')
    await expect.element(screen.getByRole('button', { name: '保存姓名' })).toBeDisabled()
    await screen.getByRole('textbox', { name: '修改张三的姓名' }).fill(' 李四 ')
    await screen.getByRole('button', { name: '保存姓名' }).click()
    await expect.poll(() => requests.put.mock.calls[1]).toEqual(['/people/p1', { name: '李四' }])
  })

  it('照片补录使用人员 ID 和文件，不提交姓名或分组更新', async () => {
    const qc = client()
    qc.setQueryData(['people'], [person()])
    requests.get.mockResolvedValue({ data: [person()] })
    requests.post.mockResolvedValue({ data: { accepted: 1, rejected: [] } })
    await render(form(qc, <People />))
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const files = new DataTransfer()
    files.items.add(new File(['test-photo'], 'photo.jpg', { type: 'image/jpeg' }))
    fileInput.files = files.files
    fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    await expect.poll(() => requests.post.mock.calls.length).toBe(1)
    const [url, body] = requests.post.mock.calls[0] as [string, FormData]
    expect(url).toBe('/people/p1/photos')
    expect([...body.keys()]).toEqual(['files'])
    expect((body.get('files') as File).name).toBe('photo.jpg')
    expect(requests.put).not.toHaveBeenCalled()
  })

  it('重新开始改名时使用最新服务器姓名，不提交旧草稿', async () => {
    const qc = client()
    qc.setQueryData(['people'], [person()])
    const screen = await render(form(qc, <People />))
    await screen.getByRole('button', { name: '改名', exact: true }).click()
    await screen.getByRole('textbox', { name: '修改张三的姓名' }).fill('未保存草稿')
    await screen.getByRole('button', { name: '改名', exact: true }).click()
    qc.setQueryData(['people'], [person({ name: '新姓名' })])
    await expect.element(screen.getByText('新姓名', { exact: true })).toBeVisible()
    await screen.getByRole('button', { name: '改名', exact: true }).click()
    await expect.element(screen.getByRole('textbox', { name: '修改新姓名的姓名' })).toHaveValue('新姓名')
  })
})
