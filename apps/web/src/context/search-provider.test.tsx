import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, type RenderResult } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { SearchProvider } from '@/context/search-provider'
import { useSettingsDialog } from '@/hooks/use-settings-dialog'
import { Search } from '@/components/search'
import { sidebarData } from '@/components/layout/data/sidebar-data'

const COMMAND_MENU_PLACEHOLDER = '搜索页面或命令…'
const originalNavGroups = sidebarData.navGroups

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setTheme: vi.fn(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  }
})

vi.mock('@/context/theme-provider', () => ({
  useTheme: () => ({ setTheme: mocks.setTheme }),
}))

type ShortcutModifier = 'Control' | 'Meta'

async function renderWithSearchProvider() {
  return await render(<SearchProvider>{null}</SearchProvider>)
}

/**
 * Open the palette by shortcut, retrying while the keydown listener may not be mounted yet.
 * Waits between attempts so a successful toggle is not immediately undone by a second chord.
 */
async function openCommandPalette(
  screen: RenderResult,
  modifier: ShortcutModifier = 'Control'
) {
  await vi.waitFor(
    async () => {
      const isCommandPaletteOpen =
        document.querySelector(
          `[placeholder="${COMMAND_MENU_PLACEHOLDER}"]`
        ) !== null

      if (!isCommandPaletteOpen) {
        await userEvent.keyboard(`{${modifier}>}k{/${modifier}}`)
      }

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    },
    { interval: 50, timeout: 5000 }
  )
}

describe('SearchProvider and CommandMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsDialog.getState().setOpen(false)
  })

  afterEach(() => {
    sidebarData.navGroups = originalNavGroups
  })

  it('renders the command palette when the palette is open', async () => {
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByText } = screen

    await openCommandPalette(screen)

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .toBeInTheDocument()
    await expect.element(getByText('主题')).toBeInTheDocument()
    await expect.element(getByText('浅色')).toBeInTheDocument()
    await expect.element(getByText('深色')).toBeInTheDocument()
    await expect.element(getByText('跟随系统')).toBeInTheDocument()
    await expect.element(getByText('概览')).toBeInTheDocument()
  })

  it('does not show the dialog content when search is closed', async () => {
    const { getByPlaceholder } = await renderWithSearchProvider()

    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it.each([
    ['Ctrl', 'Control'],
    ['Cmd', 'Meta'],
  ] as const)(
    'opens the command menu when %s + K is pressed',
    async (_label, modifier) => {
      const screen = await renderWithSearchProvider()

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .not.toBeInTheDocument()

      await openCommandPalette(screen, modifier)

      await expect
        .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
        .toBeInTheDocument()
    }
  )

  it.each([
    ['Ctrl', 'Control'],
    ['Cmd', 'Meta'],
  ] as const)('opens search with %s + P from any focused element and prevents printing', async (_label, modifier) => {
    const screen = await render(
      <SearchProvider>
        <button>页面按钮</button>
        <input aria-label='页面输入框' onKeyDown={(event) => event.stopPropagation()} />
        <textarea aria-label='多行输入框' onKeyDown={(event) => event.stopPropagation()} />
        <div contentEditable suppressContentEditableWarning role='textbox' aria-label='富文本输入框' onKeyDown={(event) => event.stopPropagation()} />
      </SearchProvider>
    )
    const prevented: boolean[] = []
    const observe = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'p') prevented.push(event.defaultPrevented)
    }
    document.addEventListener('keydown', observe, true)
    try {
      for (const name of ['页面按钮', '页面输入框', '多行输入框', '富文本输入框']) {
        await userEvent.click(screen.getByRole(name === '页面按钮' ? 'button' : 'textbox', { name }))
        await userEvent.keyboard(`{${modifier}>}p{/${modifier}}`)
        await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).toHaveFocus()
        await userEvent.keyboard('{Escape}')
        await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).not.toBeInTheDocument()
      }
      expect(prevented).toEqual([true, true, true, true])
    } finally {
      document.removeEventListener('keydown', observe, true)
    }
  })

  it('P keeps an open palette visible, while K still toggles it', async () => {
    const screen = await renderWithSearchProvider()
    await userEvent.keyboard('{Control>}p{/Control}')
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).toBeVisible()
    await userEvent.keyboard('{Control>}p{/Control}')
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).toBeVisible()
    await userEvent.keyboard('{Control>}k{/Control}')
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).not.toBeInTheDocument()
    await userEvent.keyboard('{Meta>}k{/Meta}')
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).toBeVisible()
  })

  it('normalizes shortcut keys, ignores held keys and removes its listener on unmount', async () => {
    const screen = await renderWithSearchProvider()
    const shortcut = (key: string, repeat = false) => new KeyboardEvent('keydown', { key, ctrlKey: true, repeat, bubbles: true, cancelable: true })
    const held = shortcut('p', true)
    document.dispatchEvent(held)
    expect(held.defaultPrevented).toBe(true)
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).not.toBeInTheDocument()
    const uppercase = shortcut('P')
    document.dispatchEvent(uppercase)
    expect(uppercase.defaultPrevented).toBe(true)
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).toBeVisible()
    document.dispatchEvent(shortcut('k', true))
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).toBeVisible()
    await screen.unmount()
    const afterUnmount = shortcut('p')
    document.dispatchEvent(afterUnmount)
    expect(afterUnmount.defaultPrevented).toBe(false)
  })

  it('does not intercept plain P or the existing Ctrl+Alt+P monitoring shortcut', async () => {
    const screen = await renderWithSearchProvider()
    for (const modifiers of [{}, { ctrlKey: true, altKey: true }]) {
      const event = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true, ...modifiers })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).not.toBeInTheDocument()
  })

  it('advertises P and K shortcuts and opens search from its button', async () => {
    const screen = await render(<SearchProvider><Search placeholder='全局搜索' /></SearchProvider>)
    const button = screen.getByRole('button', { name: /全局搜索/ })
    await expect.element(button).toHaveAttribute('aria-keyshortcuts', 'Meta+P Control+P Meta+K Control+K')
    await userEvent.click(button)
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).toBeVisible()
  })

  it('navigates to a top-level route and closes the palette when a nav item is selected', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.click(screen.getByText('概览'))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/' })
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('searches the actual add-person submenu by its Chinese title', async () => {
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    await userEvent.fill(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER), '添加人员')
    await userEvent.click(screen.getByRole('option', { name: '人员管理 添加人员' }))
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/people/add' })
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).not.toBeInTheDocument()
  })

  it('navigates for nested sidebar items (group with sub-items)', async () => {
    // 独立夹具覆盖任意嵌套导航，避免只验证产品内的固定菜单。
    sidebarData.navGroups = [{
      title: '测试导航',
      items: [{ title: '测试子菜单', items: [{ title: '测试页面', url: '/sources' }] }],
    }]
    const screen = await renderWithSearchProvider()
    const { getByPlaceholder, getByRole } = screen

    await openCommandPalette(screen)

    await userEvent.click(getByRole('option', { name: '测试子菜单 测试页面' }))

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/sources' })
    await expect
      .element(getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it.each(['top-level', 'nested'])('opens settings over the current page without navigation (%s command)', async (level) => {
    sidebarData.navGroups = [{
      title: '设置测试',
      items: level === 'top-level'
        ? [{ title: '全局设置', url: '/settings' }]
        : [{ title: '应用', items: [{ title: '全局设置', url: '/settings' }] }],
    }]
    const screen = await renderWithSearchProvider()
    await openCommandPalette(screen)
    await userEvent.click(screen.getByRole('option', { name: /全局设置/ }))
    expect(useSettingsDialog.getState().open).toBe(true)
    expect(mocks.navigate).not.toHaveBeenCalled()
    await expect.element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER)).not.toBeInTheDocument()
  })

  it('applies theme and closes the palette when a theme command is chosen', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.click(screen.getByText('深色'))

    expect(mocks.setTheme).toHaveBeenCalledWith('dark')
    await expect
      .element(screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER))
      .not.toBeInTheDocument()
  })

  it('shows empty state when the filter matches nothing', async () => {
    const screen = await renderWithSearchProvider()

    await openCommandPalette(screen)

    await userEvent.fill(
      screen.getByPlaceholder(COMMAND_MENU_PLACEHOLDER),
      'zzzz-no-match-xxxx'
    )

    await expect
      .element(screen.getByText('无结果'))
      .toBeInTheDocument()
  })
})
