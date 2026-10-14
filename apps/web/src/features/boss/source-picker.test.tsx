import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { SourcePicker, type SourceValue } from './source-picker'

const requests = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: requests }))
const originalUA = window.navigator.userAgent
const clients: QueryClient[] = []
function setUA(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: ua })
}
function Picker({ kinds, initial }: { kinds: SourceValue['kind'][]; initial: SourceValue }) {
  const [value, setValue] = useState(initial)
  return <SourcePicker kinds={kinds} value={value} onChange={setValue} />
}
async function setup(kinds: SourceValue['kind'][], initial: SourceValue) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(qc)
  return render(<QueryClientProvider client={qc}><Picker kinds={kinds} initial={initial} /></QueryClientProvider>)
}
beforeEach(() => {
  requests.get.mockImplementation((path: string) => Promise.resolve({ data: path === '/sources/videos' ? [] : { devices: [], push: [] } }))
})
afterEach(async () => {
  setUA(originalUA)
  await cleanup()
  clients.splice(0).forEach((qc) => qc.clear())
  vi.resetAllMocks()
})

describe('添加模式限制画面源类型', () => {
  it('视频文件模式不提供摄像头或网络流，也不枚举摄像头', async () => {
    const screen = await setup(['file'], { kind: 'file', uri: '' })
    await screen.getByRole('combobox', { name: '源类型' }).click()
    await expect.element(screen.getByRole('option', { name: '本地视频文件' })).toBeVisible()
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(requests.get.mock.calls.every(([path]) => path !== '/sources/cameras')).toBe(true)
  })

  it('没有预置视频时也可输入用户自己的本机视频路径', async () => {
    const screen = await setup(['file'], { kind: 'file', uri: '' })
    const path = screen.getByRole('textbox', { name: '视频文件完整路径' })
    await path.fill('/tmp/user-video.mp4')
    await expect.element(path).toHaveValue('/tmp/user-video.mp4')
  })

  it('现场采集只有摄像头与网络流，切换类型清空旧地址，不读取文件列表', async () => {
    const screen = await setup(['camera', 'url'], { kind: 'camera', uri: 'old-camera' })
    await screen.getByRole('combobox', { name: '源类型' }).click()
    await expect.element(screen.getByRole('option', { name: '摄像头', exact: true })).toBeVisible()
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2)
    await screen.getByRole('option', { name: '网络流 URL', exact: true }).click()
    await expect.element(screen.getByRole('textbox', { name: '流地址' })).toHaveValue('')
    expect(requests.get.mock.calls.every(([path]) => path !== '/sources/videos')).toBe(true)
    for (const icon of document.querySelectorAll('label svg')) {
      expect(icon.getAttribute('stroke')).toBe('currentColor')
      expect(icon.getAttribute('fill')).toBe('none')
    }
  })

  it('Electron 只列出本机摄像头，不展示 OpenCV 或路径', async () => {
    setUA('Mozilla/5.0 Electron/28.0.0')
    requests.get.mockResolvedValue({ data: {
      devices: [{ id: '0', name: 'FaceTime HD', path: '0' }],
      push: [{ id: 'push://electron', name: 'getUserMedia Camera' }],
    } })
    const screen = await setup(['camera'], { kind: 'camera', uri: '' })
    await screen.getByRole('combobox', { name: '摄像头设备' }).click()
    await expect.element(screen.getByRole('option', { name: '本机摄像头' })).toBeVisible()
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/OpenCV|getUserMedia|路径/)
  })

  it('浏览器只列出设备名称，忙提示保留', async () => {
    setUA('Mozilla/5.0 Chrome/120.0.0.0')
    requests.get.mockResolvedValue({ data: {
      devices: [{ id: '0', name: 'FaceTime HD', path: '0', busy: '门口' }],
      push: [{ id: 'push://electron', name: 'getUserMedia Camera' }],
    } })
    const screen = await setup(['camera'], { kind: 'camera', uri: '' })
    await screen.getByRole('combobox', { name: '摄像头设备' }).click()
    await expect.element(screen.getByRole('option', { name: 'FaceTime HD · 正被「门口」使用' })).toBeVisible()
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(1)
    expect(document.body.textContent).not.toMatch(/OpenCV|本机摄像头|getUserMedia/)
  })
})
