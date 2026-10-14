import { StrictMode, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { MobilePreview } from './mobile-preview'
import { Sources } from './sources'

const requests = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: requests }))
vi.mock('./live', async (original) => ({ ...(await original<typeof import('./live')>()), useLive: () => ({ events: [], connected: true, frames: { '门口': { jpeg: 'data:image/jpeg;base64,cHJpdmF0ZQ==' } } }) }))
vi.mock('./source-picker', () => ({ SourcePicker: () => null }))
vi.mock('./page', () => ({ Page: ({ children }: { children: ReactNode }) => <main>{children}</main> }))

const session = () => ({ id: 'test-session', qr: 'data:image/png;base64,iVBORw0KGgo=', expires_at: Date.now() / 1000 + 600, address: '192.168.1.2', addresses: ['192.168.1.2'] })

beforeEach(() => {
  requests.post.mockResolvedValue({ data: session() })
  requests.delete.mockResolvedValue({ data: { ok: true } })
})
afterEach(async () => {
  await cleanup()
  await Promise.resolve()
  vi.resetAllMocks()
})

describe('手机扫码预览', () => {
  it('默认不创建预览，点击后仅显示二维码，关闭撤销访问', async () => {
    const screen = await render(<MobilePreview source='门口' />)
    expect(requests.post).not.toHaveBeenCalled()
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    expect(requests.post).toHaveBeenCalledWith('/mobile-preview', { source: '门口' })
    expect(document.querySelectorAll('video').length).toBe(0)
    await screen.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.poll(() => requests.delete.mock.calls).toEqual([['/mobile-preview/test-session']])
  })

  it('创建尚未完成就关闭，迟到的会话仍被撤销', async () => {
    let resolve!: (v: { data: ReturnType<typeof session> }) => void
    requests.post.mockImplementation(() => new Promise((r) => { resolve = r }))
    const screen = await render(<MobilePreview source='门口' />)
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByText('正在生成二维码…')).toBeVisible()
    await screen.getByRole('button', { name: 'Close', exact: true }).click()
    resolve({ data: session() })
    await expect.poll(() => requests.delete.mock.calls).toEqual([['/mobile-preview/test-session']])
  })

  it('创建失败可重试，过期二维码不显示', async () => {
    requests.post.mockRejectedValueOnce(new Error('无法连接局域网'))
    const screen = await render(<MobilePreview source='门口' />)
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('无法连接局域网')
    requests.post.mockResolvedValue({ data: { ...session(), expires_at: Date.now() / 1000 - 1 } })
    await screen.getByRole('button', { name: '重新生成二维码' }).click()
    await expect.element(screen.getByText('二维码已过期，请重新生成。')).toBeVisible()
    expect(document.querySelector('img')).toBeNull()
  })

  it('严格模式卸载会撤销会话，已结束视频源不能预览', async () => {
    const screen = await render(<StrictMode><MobilePreview source='门口' /></StrictMode>)
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    await screen.unmount()
    await expect.poll(() => requests.delete.mock.calls.length).toBe(requests.post.mock.calls.length)
    const ended = await render(<MobilePreview source='门口' disabled />)
    await expect.element(ended.getByRole('button', { name: '手机预览' })).toBeDisabled()
  })

  it('切换网卡会撤销旧二维码并创建新会话', async () => {
    requests.post.mockResolvedValueOnce({ data: { ...session(), addresses: ['192.168.1.2', '192.168.2.2'] } })
    const screen = await render(<MobilePreview source='门口' />)
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('combobox')).toBeVisible()
    requests.post.mockResolvedValueOnce({ data: { ...session(), id: 'second-session', address: '192.168.2.2' } })
    await screen.getByRole('combobox').selectOptions('192.168.2.2')
    await expect.poll(() => requests.post.mock.calls[1]).toEqual(['/mobile-preview', { source: '门口', address: '192.168.2.2' }])
    await expect.poll(() => requests.delete.mock.calls[0]).toEqual(['/mobile-preview/test-session'])
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
  })

  it('视频源页面不渲染实时JPEG，即使实时通道已有帧', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    requests.get.mockResolvedValue({ data: { max_sources: 4, pipelines: [{ name: '门口', running: true, source: { name: '门口', kind: 'camera', uri: '0' }, stats: null, faces: [] }] } })
    const screen = await render(<QueryClientProvider client={qc}><Sources /></QueryClientProvider>)
    await expect.element(screen.getByRole('button', { name: '手机预览' })).toBeVisible()
    expect(document.querySelector('img, video')).toBeNull()
    expect(requests.post).not.toHaveBeenCalled()
    await screen.unmount()
    qc.clear()
  })
})
