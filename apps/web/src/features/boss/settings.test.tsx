import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import '@/styles/index.css'
import { SettingsDialog } from './settings'

const requests = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: requests }))
vi.mock('./source-picker', () => ({ SourcePicker: () => null }))

const clients: QueryClient[] = []
const settings = {
  default_source: null, default_sources: [], max_sources: 4,
  snapshot_enabled: true, snapshot_retention_days: 30,
  smtp_host: '', smtp_port: 465, smtp_security: 'ssl', smtp_user: '', smtp_from: '', smtp_to: [], smtp_verify_tls: true,
  email_per_hour: 10, email_min_interval_s: 60, autostart: false, auto_monitor: false,
  adaptive: true, active_fps: 10, idle_fps: 2, camera_width: 1280, camera_height: 720,
}

async function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(qc)
  return render(<QueryClientProvider client={qc}><SettingsDialog open onOpenChange={() => {}} /></QueryClientProvider>)
}
beforeEach(() => {
  requests.get.mockImplementation((path: string) => Promise.resolve({ data: path === '/settings' ? settings : { pipelines: [{ name: '门口', running: true }] } }))
  requests.put.mockResolvedValue({ data: {} })
})
afterEach(async () => {
  await cleanup()
  clients.splice(0).forEach((qc) => qc.clear())
  vi.resetAllMocks()
})

describe('分层设置弹窗', () => {
  it('一次只展示一个二级菜单，切换菜单保留草稿并统一保存', async () => {
    const screen = await setup()
    await expect.element(screen.getByRole('dialog')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: '添加默认源' })).toBeVisible()
    expect(document.querySelector('input[placeholder="smtp.qq.com"]')).toBeNull()
    await screen.getByRole('button', { name: '邮件通知', exact: true }).click()
    await screen.getByPlaceholder('smtp.qq.com').fill('mail.example.test')
    await screen.getByRole('button', { name: '性能', exact: true }).click()
    expect(document.querySelector('input[placeholder="smtp.qq.com"]')).toBeNull()
    await screen.getByRole('button', { name: '邮件通知', exact: true }).click()
    await expect.element(screen.getByPlaceholder('smtp.qq.com')).toHaveValue('mail.example.test')
    await screen.getByRole('button', { name: '保存设置', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls[0]?.[1].smtp_host).toBe('mail.example.test')
  })

  it('设置内提供手机扫码入口，不展示电脑实时画面也不自动签发会话', async () => {
    const screen = await setup()
    await screen.getByRole('button', { name: '手机扫码预览', exact: true }).click()
    await expect.element(screen.getByRole('button', { name: '手机预览', exact: true })).toBeVisible()
    expect(document.querySelector('img, video')).toBeNull()
    expect(requests.post).not.toHaveBeenCalled()
  })

  it('窄屏下弹窗无横向溢出，内容可滚动', async () => {
    await page.viewport(390, 844)
    try {
      const screen = await setup()
      await screen.getByRole('button', { name: '邮件通知', exact: true }).click()
      const dialog = document.querySelector('[role="dialog"]')!
      expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1)
      expect(dialog.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight)
      await expect.element(screen.getByRole('button', { name: '保存设置', exact: true })).toBeVisible()
    } finally {
      await page.viewport(1280, 720)
    }
  })
})
