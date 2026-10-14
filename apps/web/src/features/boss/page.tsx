import { Settings } from 'lucide-react'
import { useSettingsDialog } from '@/hooks/use-settings-dialog'
import { Button } from '@/components/ui/button'
import { Search } from '@/components/search'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

export function Page({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
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
          <h1 className='text-2xl font-bold tracking-tight'>{title}</h1>
          {desc && <p className='text-muted-foreground'>{desc}</p>}
        </div>
        {children}
      </Main>
    </>
  )
}
