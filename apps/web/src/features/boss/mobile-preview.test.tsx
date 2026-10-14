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

const session = () => ({ id: 'test-session', source: '门口', qr: 'data:image/png;base64,iVBORw0KGgo=', expires_at: Date.now() / 1000 + 600, address: '192.168.1.2', addresses: ['192.168.1.2'] })
const clients: QueryClient[] = []
function wrapper(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(qc)
  return <StrictMode><QueryClientProvider client={qc}>{children}</QueryClientProvider></StrictMode>
}

beforeEach(() => {
  requests.get.mockResolvedValue({ data: [] })
  requests.post.mockResolvedValue({ data: session() })
  requests.delete.mockResolvedValue({ data: { success: true } })
})
afterEach(async () => {
  await cleanup()
  clients.splice(0).forEach((qc) => qc.clear())
  await Promise.resolve()
  vi.resetAllMocks()
})

describe('手机扫码预览', () => {
  it('默认不创建预览，关闭只隐藏二维码，重开复用同一有效会话且不续期', async () => {
    const existing = session()
    const screen = await render(wrapper(<MobilePreview source='门口' />))
    expect(requests.post).not.toHaveBeenCalled()
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    expect(requests.post).toHaveBeenCalledWith('/mobile-preview', { source: '门口' })
    expect(document.querySelectorAll('video').length).toBe(0)
    await screen.getByRole('button', { name: '隐藏二维码', exact: true }).click()
    expect(requests.delete).not.toHaveBeenCalled()
    requests.get.mockResolvedValue({ data: [existing] })
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    expect(requests.post).toHaveBeenCalledTimes(1)
    expect(requests.delete).not.toHaveBeenCalled()
  })

  it('生成尚未完成就关闭，迟到会话保留供手机使用', async () => {
    let resolve!: (v: { data: ReturnType<typeof session> }) => void
    requests.post.mockImplementation(() => new Promise((r) => { resolve = r }))
    const screen = await render(wrapper(<MobilePreview source='门口' />))
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.poll(() => requests.post.mock.calls.length).toBe(1)
    await screen.getByRole('button', { name: 'Close', exact: true }).click()
    resolve({ data: session() })
    await Promise.resolve()
    expect(requests.delete).not.toHaveBeenCalled()
  })

  it('创建失败可重试，过期二维码不显示', async () => {
    requests.post.mockRejectedValueOnce(new Error('无法连接局域网'))
    const screen = await render(wrapper(<MobilePreview source='门口' />))
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('alert')).toHaveTextContent('无法连接局域网')
    requests.post.mockResolvedValue({ data: { ...session(), expires_at: Date.now() / 1000 - 1 } })
    await screen.getByRole('button', { name: '重新生成二维码' }).click()
    await expect.element(screen.getByText('二维码已过期，请重新生成。')).toBeVisible()
    expect(document.querySelector('img')).toBeNull()
  })

  it('页面卸载不撤销，切回页面可恢复会话，停止的视频源不能预览', async () => {
    const existing = session()
    const screen = await render(wrapper(<MobilePreview source='门口' />))
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    await screen.unmount()
    expect(requests.delete).not.toHaveBeenCalled()
    requests.get.mockResolvedValue({ data: [existing] })
    const restored = await render(wrapper(<MobilePreview source='门口' />))
    await restored.getByRole('button', { name: '手机预览' }).click()
    await expect.element(restored.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    expect(requests.post).toHaveBeenCalledTimes(1)
    await restored.unmount()
    const ended = await render(wrapper(<MobilePreview source='门口' disabled />))
    await expect.element(ended.getByRole('button', { name: '手机预览' })).toBeDisabled()
  })

  it('只有主动断开才撤销，并可重新生成', async () => {
    const screen = await render(wrapper(<MobilePreview source='门口' />))
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    await screen.getByRole('button', { name: '断开手机预览' }).click()
    await expect.element(screen.getByText('手机预览已断开。')).toBeVisible()
    expect(requests.delete).toHaveBeenCalledExactlyOnceWith('/mobile-preview', { params: { source: '门口' } })
    expect(document.querySelector('img')).toBeNull()
    await screen.getByRole('button', { name: '重新生成二维码' }).click()
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    expect(requests.post).toHaveBeenCalledTimes(2)
  })

  it('切换网卡撤销旧二维码，再创建新会话', async () => {
    requests.post.mockResolvedValueOnce({ data: { ...session(), addresses: ['192.168.1.2', '192.168.2.2'] } })
    const screen = await render(wrapper(<MobilePreview source='门口' />))
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('combobox')).toBeVisible()
    requests.post.mockResolvedValueOnce({ data: { ...session(), id: 'second-session', address: '192.168.2.2' } })
    await screen.getByRole('combobox').selectOptions('192.168.2.2')
    await expect.poll(() => requests.post.mock.calls[1]).toEqual(['/mobile-preview', { source: '门口', address: '192.168.2.2' }])
    expect(requests.delete).toHaveBeenCalledWith('/mobile-preview', { params: { source: '门口' } })
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
  })

  it('切换网卡撤销失败时保留原会话，不能签发无法管理的额外会话', async () => {
    const existing = { ...session(), addresses: ['192.168.1.2', '192.168.2.2'] }
    requests.get.mockResolvedValue({ data: [existing] })
    requests.delete.mockRejectedValue(new Error('撤销失败'))
    const screen = await render(wrapper(<MobilePreview source='门口' />))
    await screen.getByRole('button', { name: '手机预览' }).click()
    await expect.element(screen.getByRole('combobox')).toBeVisible()
    await screen.getByRole('combobox').selectOptions('192.168.2.2')
    await expect.element(screen.getByRole('alert')).toHaveTextContent('撤销失败')
    await expect.element(screen.getByRole('img', { name: '手机预览二维码' })).toBeVisible()
    expect(requests.post).not.toHaveBeenCalled()
  })

  it('视频源页面不渲染实时JPEG，即使实时通道已有帧', async () => {
    requests.get.mockResolvedValue({ data: { max_sources: 4, pipelines: [{ name: '门口', running: true, source: { name: '门口', kind: 'camera', uri: '0' }, stats: null, faces: [] }] } })
    const screen = await render(wrapper(<Sources />))
    await expect.element(screen.getByRole('button', { name: '手机预览' })).toBeVisible()
    expect(document.querySelector('img, video')).toBeNull()
    expect(requests.post).not.toHaveBeenCalled()
  })
})
