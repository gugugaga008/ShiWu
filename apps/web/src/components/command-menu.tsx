import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ArrowRight, ChevronRight, Laptop, Moon, Power, Settings2, Sun, UserRound } from 'lucide-react'
import { useSearch } from '@/context/search-provider'
import { useTheme } from '@/context/theme-provider'
import { useSettingsDialog, type SettingsSection } from '@/hooks/use-settings-dialog'
import { api, ROLE_LABEL, type Person } from '@/lib/api'
import { searchTokens, searchValue } from '@/lib/search-text'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command'
import { sidebarData } from './layout/data/sidebar-data'
import { ScrollArea } from './ui/scroll-area'

const SETTINGS_COMMANDS: { section: SettingsSection; title: string; extra: string[] }[] = [
  { section: 'sources', title: '画面源', extra: ['摄像头', '视频'] },
  { section: 'defaults', title: '默认画面源', extra: [] },
  { section: 'startup', title: '开机自启', extra: ['自启动', '启动', 'zidongqi', 'zdq'] },
  { section: 'preview', title: '手机扫码预览', extra: [] },
  { section: 'performance', title: '性能', extra: [] },
  { section: 'snapshots', title: '触发快照', extra: [] },
  { section: 'email', title: '邮件通知', extra: [] },
  { section: 'privacy', title: '数据与隐私', extra: ['数据', '导出', '清除'] },
  { section: 'about', title: '关于与诊断', extra: ['版本', '诊断', '帮助'] },
]

export function CommandMenu() {
  const navigate = useNavigate()
  const { setTheme } = useTheme()
  const { open, setOpen } = useSearch()
  const { data: people = [] } = useQuery({
    queryKey: ['people'],
    queryFn: async () => (await api.get<Person[]>('/people')).data,
    enabled: open,
  })

  const runCommand = React.useCallback(
    (command: () => unknown) => {
      setOpen(false)
      command()
    },
    [setOpen]
  )

  const openPage = (url: string | undefined) => runCommand(() => {
    if (url === '/settings') useSettingsDialog.getState().setOpen(true)
    else navigate({ to: url })
  })

  return (
    <CommandDialog modal open={open} onOpenChange={setOpen}>
      <CommandInput placeholder='搜索页面、人员、设置或命令…' />
      <CommandList>
        <ScrollArea type='hover' className='h-72 pe-1'>
          <CommandEmpty>无结果</CommandEmpty>
          {sidebarData.navGroups.map((group) => (
            <CommandGroup key={group.title} heading={group.title}>
              {group.items.map((navItem, i) => {
                if (navItem.url)
                  return (
                    <CommandItem
                      key={`${navItem.url}-${i}`}
                      value={searchValue(navItem.title)}
                      keywords={searchTokens(navItem.title)}
                      onSelect={() => {
                        openPage(navItem.url)
                      }}
                    >
                      <div className='flex size-4 items-center justify-center'>
                        {navItem.icon ? <navItem.icon className='size-4' aria-hidden /> : <ArrowRight className='size-2 text-muted-foreground/80' aria-hidden />}
                      </div>
                      {navItem.title}
                    </CommandItem>
                  )

                return navItem.items?.map((subItem, i) => (
                  <CommandItem
                    key={`${navItem.title}-${subItem.url}-${i}`}
                    value={searchValue(`${navItem.title} ${subItem.title}`, [subItem.url ?? ''])}
                    keywords={searchTokens(`${navItem.title}${subItem.title}`, [navItem.title, subItem.title])}
                    onSelect={() => {
                      openPage(subItem.url)
                    }}
                  >
                    <div className='flex size-4 items-center justify-center'>
                      {subItem.icon ? <subItem.icon className='size-4' aria-hidden /> : <ArrowRight className='size-2 text-muted-foreground/80' aria-hidden />}
                    </div>
                    {navItem.title} <ChevronRight aria-hidden /> {subItem.title}
                  </CommandItem>
                ))
              })}
            </CommandGroup>
          ))}
          {people.length > 0 && (
            <CommandGroup heading='人员'>
              {people.map((person) => (
                <CommandItem
                  key={person.person_id}
                  value={searchValue(person.name, [ROLE_LABEL[person.role ?? ''] ?? '', person.person_id])}
                  keywords={searchTokens(person.name, [ROLE_LABEL[person.role ?? ''] ?? ''])}
                  onSelect={() => openPage('/people')}
                >
                  <UserRound /> {person.name}
                  <span className='text-muted-foreground'>{ROLE_LABEL[person.role ?? ''] ?? '未分组'}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading='设置'>
            {SETTINGS_COMMANDS.map((item) => (
              <CommandItem
                key={item.section}
                value={searchValue(item.title, item.extra)}
                keywords={searchTokens(item.title, item.extra)}
                onSelect={() => runCommand(() => useSettingsDialog.getState().openSection(item.section))}
              >
                {item.section === 'startup' ? <Power /> : <Settings2 />}
                {item.title}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading='主题'>
            <CommandItem value={searchValue('浅色')} keywords={searchTokens('浅色')} onSelect={() => runCommand(() => setTheme('light'))}>
              <Sun /> <span>浅色</span>
            </CommandItem>
            <CommandItem value={searchValue('深色')} keywords={searchTokens('深色')} onSelect={() => runCommand(() => setTheme('dark'))}>
              <Moon className='scale-90' />
              <span>深色</span>
            </CommandItem>
            <CommandItem value={searchValue('跟随系统')} keywords={searchTokens('跟随系统')} onSelect={() => runCommand(() => setTheme('system'))}>
              <Laptop />
              <span>跟随系统</span>
            </CommandItem>
          </CommandGroup>
        </ScrollArea>
      </CommandList>
    </CommandDialog>
  )
}
