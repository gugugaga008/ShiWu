import { createFileRoute } from '@tanstack/react-router'
import { Rules } from '@/features/boss/rules'

export const Route = createFileRoute('/_authenticated/rules')({ component: Rules })
