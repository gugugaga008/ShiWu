import { createFileRoute } from '@tanstack/react-router'
import { Sources } from '@/features/boss/sources'

export const Route = createFileRoute('/_authenticated/sources')({ component: Sources })
