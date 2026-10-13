import { createFileRoute } from '@tanstack/react-router'
import { SettingsPage } from '@/features/boss/settings'

export const Route = createFileRoute('/_authenticated/settings')({ component: SettingsPage })
