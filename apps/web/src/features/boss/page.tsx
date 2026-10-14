import { BarChart3, History, LayoutDashboard, MonitorPlay, Settings, SlidersHorizontal, UserRoundPlus, Users, type LucideIcon } from 'lucide-react'
import { useSettingsDialog } from '@/hooks/use-settings-dialog'
import { Button } from '@/components/ui/button'
import { Search } from '@/components/search'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

const PAGE_ICONS: Record<string, LucideIcon> = {
  总览: LayoutDashboard,
  画面源: MonitorPlay,
  人员管理: Users,
  添加人员: UserRoundPlus,
  规则设置: SlidersHorizontal,
  时间线: History,
  统计: BarChart3,
  设置: Settings,
}

export function Page({ title, desc, children, icon }: { title: string; desc?: string; children: React.ReactNode; icon?: LucideIcon }) {
  const Icon = icon ?? PAGE_ICONS[title]
  return (
    <>
      <Header>
        <div className='font-semibold'>识务</div>
        <div className='ms-auto flex items-center gap-2'>
          <Search />
          <Button variant='ghost' size='icon' aria-label='打开设置' onClick={() => useSettingsDialog.getState().setOpen(true)}><Settings /></Button>
          <ThemeSwitch />
        </div>
      </Header>
      <Main>
        <div className='mb-4'>
          <h1 className='flex items-center gap-2.5 text-2xl font-bold tracking-tight'>{Icon && <Icon className='size-6 shrink-0' aria-hidden />}{title}</h1>
          {desc && <p className='text-muted-foreground'>{desc}</p>}
        </div>
        {children}
      </Main>
    </>
  )
}
