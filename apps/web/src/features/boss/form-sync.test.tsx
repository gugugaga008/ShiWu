import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { Rules, type Rule } from './rules'
import { SettingsDialog } from './settings'

const requests = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  api: requests,
}))
vi.mock('./page', () => ({
  Page: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))
vi.mock('./source-picker', () => ({ SourcePicker: () => null }))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn() }),
}))

const clients: QueryClient[] = []

function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  })
  clients.push(qc)
  return qc
}

function rule(note: string): Rule {
  return {
    id: 'boss', role: 'boss', person_ids: [], stranger: false, stranger_after_s: 5,
    whitelist: false, suppress_others: false, priority: 10, sources: [], schedule: [],
    min_face_px: 0, min_face_ratio: 0, restore_on_leave: false, leave_after_s: 15,
    enabled: true, min_frames: 3, cooldown_s: 30, actions: [], note,
  }
}

function settings(host: string) {
  return {
    default_source: { kind: 'camera', uri: '0' }, default_sources: [], max_sources: 4,
    snapshot_enabled: true, snapshot_retention_days: 30,
    smtp_host: host, smtp_port: 465, smtp_security: 'ssl', smtp_user: '', smtp_from: '',
    smtp_to: ['a@x.local', 'b@x.local'], smtp_verify_tls: true,
    email_per_hour: 10, email_min_interval_s: 60, autostart: false, auto_monitor: false,
    adaptive: true, active_fps: 10, idle_fps: 2, camera_width: 1280, camera_height: 720,
  }
}

function form(qc: QueryClient, children: ReactNode) {
  return <StrictMode><QueryClientProvider client={qc}>{children}</QueryClientProvider></StrictMode>
}

beforeEach(() => {
  requests.get.mockResolvedValue({ data: [] })
  requests.put.mockResolvedValue({ data: {} })
})

afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear())
  vi.resetAllMocks()
})

describe('服务端数据与编辑表单同步', () => {
  it('规则异步加载后填入表单，相同数据重渲染不覆盖编辑，新的数据会同步', async () => {
    const qc = client()
    qc.setQueryData(['monitor'], { paused: false, fired: 0 })
    qc.setQueryData(['people'], [])
    qc.setQueryData(['source-names'], [])
    requests.get.mockImplementation(() => new Promise(() => {}))
    const screen = await render(form(qc, <Rules />))
    expect(document.querySelector('input:not([type])')).toBeNull()

    qc.setQueryData(['rules'], { rules: [rule('初始规则')], actions: [] })
    const note = screen.getByRole('textbox')
    await expect.element(note).toHaveValue('初始规则')
    await note.fill('本地编辑')
    await screen.rerender(form(qc, <Rules />))
    await expect.element(note).toHaveValue('本地编辑')

    qc.setQueryData(['rules'], { rules: [rule('重新加载的规则')], actions: [] })
    await expect.element(note).toHaveValue('重新加载的规则')
  })

  it('规则保存提交当前编辑内容', async () => {
    const qc = client()
    const response = { rules: [rule('初始规则')], actions: [] }
    qc.setQueryData(['rules'], response)
    qc.setQueryData(['monitor'], { paused: false, fired: 0 })
    qc.setQueryData(['people'], [])
    qc.setQueryData(['source-names'], [])
    requests.get.mockResolvedValue({ data: response })
    const screen = await render(form(qc, <Rules />))
    await screen.getByRole('textbox').fill('保存的规则')
    await screen.getByRole('button', { name: '保存规则', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls).toEqual([
      ['/rules', [rule('保存的规则')]],
    ])
  })

  it('设置支持异步加载、保留本地编辑并同步新的服务端数据', async () => {
    const qc = client()
    requests.get.mockImplementation(() => new Promise(() => {}))
    const screen = await render(form(qc, <SettingsDialog open onOpenChange={() => {}} />))
    await expect.element(screen.getByText('加载中…')).toBeVisible()

    qc.setQueryData(['settings'], settings('initial.smtp.local'))
    await screen.getByRole('button', { name: '邮件通知', exact: true }).click()
    const host = screen.getByPlaceholder('smtp.qq.com')
    await expect.element(host).toHaveValue('initial.smtp.local')
    await host.fill('edited.smtp.local')
    await screen.rerender(form(qc, <SettingsDialog open onOpenChange={() => {}} />))
    await expect.element(host).toHaveValue('edited.smtp.local')

    qc.setQueryData(['settings'], settings('refetched.smtp.local'))
    await expect.element(host).toHaveValue('refetched.smtp.local')
  })

  it('设置保存保留旧版默认源兼容与收件人格式转换', async () => {
    const qc = client()
    const response = settings('initial.smtp.local')
    qc.setQueryData(['settings'], response)
    requests.get.mockImplementation((path: string) => Promise.resolve({ data: path === '/pipeline/status' ? { pipelines: [], max_sources: 4 } : response }))
    const screen = await render(form(qc, <SettingsDialog open onOpenChange={() => {}} />))
    await screen.getByRole('button', { name: '邮件通知', exact: true }).click()
    await screen.getByPlaceholder('smtp.qq.com').fill('saved.smtp.local')
    await screen.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls[0]).toEqual([
      '/settings', {
        ...response,
        smtp_host: 'saved.smtp.local',
        default_sources: [{ name: '主画面', kind: 'camera', uri: '0' }],
        default_source: { name: '主画面', kind: 'camera', uri: '0' },
      },
    ])
  })
})
