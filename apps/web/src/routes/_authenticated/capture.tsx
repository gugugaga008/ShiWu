import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_authenticated/capture')({
  beforeLoad: () => { throw redirect({ to: '/people/add', search: { mode: 'file' }, replace: true }) },
})
