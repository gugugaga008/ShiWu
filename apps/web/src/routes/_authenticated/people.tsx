import { createFileRoute } from '@tanstack/react-router'
import { People } from '@/features/boss/people'

export const Route = createFileRoute('/_authenticated/people')({ component: People })
