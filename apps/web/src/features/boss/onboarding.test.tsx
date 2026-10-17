import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import '@/styles/index.css'
import { Onboarding } from './onboarding'

const requests = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: requests }))

const clients: QueryClient[] = []

beforeEach(() => {
  document.cookie = 'shiwu_onboarded=; path=/; max-age=0'
  requests.get.mockImplementation((path: string) => Promise.resolve({
    data: path === '/pipeline/status' ? { pipelines: [{ running: true }] } : [{ person_id: 'p1' }],
  }))
})
afterEach(async () => {
  await cleanup()
  clients.splice(0).forEach((queryClient) => queryClient.clear())
  vi.resetAllMocks()
  document.body.innerHTML = ''
})

describe('首次启动引导', () => {
  it('第二步会高亮侧栏目标，而不是退化成居中弹窗', async () => {
    const target = document.createElement('div')
    target.dataset.tour = 'nav-settings'
    target.style.cssText = 'position:fixed;left:20px;top:300px;width:200px;height:32px'
    target.textContent = '设置'
    document.body.appendChild(target)

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(queryClient)
    const screen = await render(<QueryClientProvider client={queryClient}><Onboarding /></QueryClientProvider>)

    await expect.element(screen.getByText('欢迎使用识务', { exact: true })).toBeVisible()
    await screen.getByRole('button', { name: /下一步/ }).click()

    await expect.element(screen.getByText('第一步 · 添加画面源', { exact: true })).toBeVisible()
    await expect.poll(() => !!document.querySelector('mask#tour-hole rect[fill="black"]')).toBe(true)
    const card = [...document.querySelectorAll<HTMLElement>('[class*="pointer-events-auto"]')]
      .find((element) => element.textContent?.includes('第一步 · 添加画面源'))!
    expect(card.style.left).not.toBe('50%')
  })
})
