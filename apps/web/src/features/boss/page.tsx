import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

export function Page({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <>
      <Header>
        <div className='font-semibold'>识务</div>
        <div className='ms-auto flex items-center gap-2'>
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
