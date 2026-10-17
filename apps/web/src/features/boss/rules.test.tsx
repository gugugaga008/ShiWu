import { type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import '@/styles/index.css'
import { Rules, type Rule } from './rules'

const requests = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }))
vi.mock('@/lib/api', async (original) => ({ ...(await original<typeof import('@/lib/api')>()), api: requests }))
vi.mock('./page', () => ({ Page: ({ children }: { children: ReactNode }) => <main>{children}</main> }))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useBlocker: () => ({ status: 'idle', proceed: vi.fn(), reset: vi.fn() }),
}))

const clients: QueryClient[] = []
const actions = [
  { value: 'notify', label: '桌面通知' },
  { value: 'sound', label: '提示音' },
  { value: 'command', label: '自定义命令' },
]
function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'boss', role: 'boss', person_ids: [], stranger: false, stranger_after_s: 5,
    whitelist: false, suppress_others: false, priority: 10, sources: [], schedule: [],
    min_face_px: 0, min_face_ratio: 0, restore_on_leave: false, leave_after_s: 15,
    enabled: true, min_frames: 3, cooldown_s: 30, actions: [{ type: 'notify', params: { title: '提醒' } }], note: '分组规则', ...over,
  }
}
async function renderRules(rules: Rule[] = [rule()]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(qc)
  qc.setQueryData(['rules'], { rules, actions })
  qc.setQueryData(['monitor'], { paused: false, fired: 2, suppressed: 1, pipeline_running: true })
  qc.setQueryData(['people'], [{ person_id: 'p1', name: '张三', role: 'boss' }])
  qc.setQueryData(['source-names'], ['门口'])
  requests.get.mockImplementation(() => new Promise(() => {}))
  return render(<QueryClientProvider client={qc}><Rules /></QueryClientProvider>)
}

beforeEach(() => {
  requests.put.mockResolvedValue({ data: {} })
  requests.post.mockResolvedValue({ data: { ts: 1710000000, snapshot_url: '/boss/snapshots/x.jpg', actions: [{ type: 'notify' }], name: '测试', rule_id: 'boss' } })
})
afterEach(async () => {
  await cleanup()
  clients.splice(0).forEach((qc) => qc.clear())
  vi.resetAllMocks()
})

describe('规则设置单列与行为回归', () => {
  it.each([1440, 390])('在 %i px 下规则卡片及全部表单网格均为单列', async (width) => {
    await page.viewport(width, 900)
    await renderRules([rule(), rule({ id: 'stranger', role: null, stranger: true, priority: 5 })])
    const cards = [...document.querySelectorAll<HTMLElement>('[data-slot="card"]')]
    expect(cards).toHaveLength(2)
    const first = cards[0].getBoundingClientRect()
    const second = cards[1].getBoundingClientRect()
    expect(second.top).toBeGreaterThanOrEqual(first.bottom)
    expect(second.left).toBeCloseTo(first.left)
    const grids = [cards[0].parentElement!, ...cards.flatMap((card) => [...card.querySelectorAll<HTMLElement>('*')])]
      .filter((element) => getComputedStyle(element).display === 'grid')
    expect(grids.length).toBeGreaterThan(10)
    for (const grid of grids) {
      expect(getComputedStyle(grid).gridTemplateColumns.split(' '), grid.outerHTML).toHaveLength(1)
    }
  })

  it('单列表单仍保存分组兼容字段、条件、动作参数和备注', async () => {
    const screen = await renderRules()
    const fillField = async (label: string, value: string) => {
      const input = screen.getByText(label, { exact: true }).element().parentElement!.querySelector('input')!
      await userEvent.fill(input, value)
    }
    await screen.getByRole('combobox').all()[1].click()
    await screen.getByRole('option', { name: '领导', exact: true }).click()
    await fillField('优先级', '42')
    await fillField('连续出现（秒）', '4')
    await fillField('冷却（秒）', '90')
    await screen.getByRole('radio', { name: '最小人脸宽度' }).click()
    await fillField('最小人脸宽度（px）', '100')
    await fillField('备注', '编辑后的分组')
    await screen.getByRole('button', { name: '门口', exact: true }).click()
    await screen.getByPlaceholder('通知标题（默认：老板来了！）').fill('新提醒')
    await screen.getByRole('checkbox', { name: '提示音', exact: true }).click()
    await screen.getByRole('button', { name: '保存规则', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls[0]).toEqual(['/rules', [rule({
      role: 'leader', priority: 42, min_confirm_s: 4, cooldown_s: 90, min_face_mode: 'px', min_face_px: 100, min_face_ratio: 0,
      sources: ['门口'], note: '编辑后的分组',
      actions: [{ type: 'notify', params: { title: '新提醒' } }, { type: 'sound', params: {} }],
    })]])
  })

  it('新增分组规则仍使用 role 协议，人员、陌生人与白名单规则保持可用', async () => {
    const screen = await renderRules([])
    for (const kind of ['分组规则', '人员规则', '陌生人规则', '白名单规则']) {
      await screen.getByRole('combobox').all()[0].click()
      await screen.getByRole('option', { name: kind, exact: true }).click()
    }
    await expect.element(screen.getByText('持续未识别（秒）')).toBeVisible()
    await expect.element(screen.getByText('同时抑制其他规则')).toBeVisible()
    await expect.element(screen.getByRole('button', { name: /张三/ })).toBeVisible()
    await screen.getByRole('button', { name: '保存规则', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls.length).toBe(1)
    const saved = requests.put.mock.calls[0][1] as Rule[]
    expect(saved).toHaveLength(4)
    expect(saved[0]).toMatchObject({ role: 'boss', note: '分组规则' })
    expect(saved[1]).toMatchObject({ person_ids: ['p1'], note: '人员规则' })
    expect(saved[2]).toMatchObject({ stranger: true })
    expect(saved[3]).toMatchObject({ whitelist: true, role: 'whitelist', actions: [] })
  })

  it('修改自定义命令仍先确认，确认前不保存', async () => {
    const screen = await renderRules()
    await screen.getByRole('checkbox', { name: '自定义命令', exact: true }).click()
    await screen.getByPlaceholder('如 notify-send 识务').fill('echo test')
    await screen.getByRole('button', { name: '保存规则', exact: true }).click()
    await expect.element(screen.getByRole('alertdialog')).toBeVisible()
    expect(requests.put).not.toHaveBeenCalled()
    await screen.getByRole('button', { name: '我已确认，保存', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls.length).toBe(1)
    expect(requests.put.mock.calls[0][1][0].actions).toContainEqual({ type: 'command', params: { cmd: 'echo test' } })
  })

  it('测试动作和删除都需要确认，且删除要保存后才生效', async () => {
    const screen = await renderRules()
    await screen.getByRole('button', { name: '测试动作', exact: true }).click()
    await expect.element(screen.getByRole('alertdialog')).toBeVisible()
    expect(requests.post).not.toHaveBeenCalled()
    await screen.getByRole('alertdialog').getByRole('button', { name: '执行测试', exact: true }).click()
    await expect.poll(() => requests.post.mock.calls[0]).toEqual(['/monitor/test', { rule_id: 'boss', role: 'boss', name: '测试' }])
    await expect.element(screen.getByRole('dialog')).toBeVisible()
    await expect.element(screen.getByRole('heading', { name: '测试动作 · 测试' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('dialog')).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '删除', exact: true }).click()
    await expect.element(screen.getByRole('alertdialog')).toBeVisible()
    expect(requests.put).not.toHaveBeenCalled()
    await screen.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
    await expect.element(screen.getByText('识别到老板', { exact: true })).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '保存规则', exact: true }).click()
    await expect.poll(() => requests.put.mock.calls[0]).toEqual(['/rules', []])
  })
})
