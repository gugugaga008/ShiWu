import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { cleanup, render } from 'vitest-browser-react'
import { SidebarProvider } from '@/components/ui/sidebar'
import { sidebarData } from './data/sidebar-data'
import { NavGroup } from './nav-group'

const location = vi.hoisted(() => ({ href: '/people/add?mode=file' }))
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useLocation: ({ select }: { select: (value: { href: string }) => unknown }) => select(location),
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) => <a href={to} {...props}>{children}</a>,
}))
beforeEach(async () => { await page.viewport(1280, 900) })
afterEach(cleanup)

describe('人员管理子菜单', () => {
  it('直达带参数的添加人员页面时自动展开，列表与添加项各有单色图标', async () => {
    const screen = await render(<SidebarProvider defaultOpen><NavGroup {...sidebarData.navGroups[0]} /></SidebarProvider>)
    const add = screen.getByRole('link', { name: '添加人员', exact: true })
    const list = screen.getByRole('link', { name: '人员列表', exact: true })
    await expect.element(add).toBeVisible()
    await expect.element(add).toHaveAttribute('data-active', 'true')
    await expect.element(list).toHaveAttribute('data-active', 'false')
    for (const link of [add.element(), list.element()]) {
      const icon = link.querySelector('svg')!
      expect(icon).not.toBeNull()
      expect(icon.getAttribute('stroke')).toBe('currentColor')
      expect(icon.getAttribute('fill')).toBe('none')
    }
    expect(document.querySelector('a[href="/capture"]')).toBeNull()
  })

  it('收起侧栏仍可通过下拉菜单进入人员添加', async () => {
    const screen = await render(<SidebarProvider defaultOpen={false}><NavGroup {...sidebarData.navGroups[0]} /></SidebarProvider>)
    await screen.getByRole('button', { name: '人员管理', exact: true }).click()
    await expect.element(screen.getByRole('menuitem', { name: '添加人员', exact: true })).toBeVisible()
    expect(document.querySelector('[role="menuitem"][href="/people/add"]')).not.toBeNull()
  })
})
