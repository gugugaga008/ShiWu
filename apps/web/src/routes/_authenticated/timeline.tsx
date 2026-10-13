import { createFileRoute } from '@tanstack/react-router'
import { Timeline } from '@/features/boss/timeline'

export const Route = createFileRoute('/_authenticated/timeline')({ component: Timeline })
