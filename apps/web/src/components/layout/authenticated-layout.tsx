import { lazy, Suspense } from 'react'
import { Outlet } from '@tanstack/react-router'
import { Onboarding } from '@/features/boss/onboarding'
import { useSettingsDialog } from '@/hooks/use-settings-dialog'
import { getCookie } from '@/lib/cookies'
import { cn } from '@/lib/utils'
import { LayoutProvider } from '@/context/layout-provider'
import { SearchProvider } from '@/context/search-provider'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from '@/components/layout/app-sidebar'
import { BackendStatusBanner } from '@/components/layout/backend-status-banner'
import { SkipToMain } from '@/components/skip-to-main'

const SettingsDialog = lazy(() => import('@/features/boss/settings').then((m) => ({ default: m.SettingsDialog })))

type AuthenticatedLayoutProps = {
  children?: React.ReactNode
}

export function AuthenticatedLayout({ children }: AuthenticatedLayoutProps) {
  const defaultOpen = getCookie('sidebar_state') !== 'false'
  const { open, setOpen } = useSettingsDialog()
  return (
    <SearchProvider>
      <LayoutProvider>
        <SidebarProvider defaultOpen={defaultOpen}>
          <SkipToMain />
          <AppSidebar />
          <BackendStatusBanner />
          <SidebarInset
            className={cn(
              // Set content container, so we can use container queries
              '@container/content',

              // If layout is fixed, set the height
              // to 100svh to prevent overflow
              'has-data-[layout=fixed]:h-svh',

              // If layout is fixed and sidebar is inset,
              // set the height to 100svh - spacing (total margins) to prevent overflow
              'peer-data-[variant=inset]:has-data-[layout=fixed]:h-[calc(100svh-(var(--spacing)*4))]'
            )}
          >
            {children ?? <Outlet />}
          </SidebarInset>
          {open && <Suspense fallback={null}><SettingsDialog open={open} onOpenChange={setOpen} /></Suspense>}
          <Onboarding />
        </SidebarProvider>
      </LayoutProvider>
    </SearchProvider>
  )
}
