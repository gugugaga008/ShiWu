import { createFileRoute } from '@tanstack/react-router'
import { CapturePage } from '@/features/boss/capture'

export const Route = createFileRoute('/_authenticated/capture')({ component: CapturePage })
