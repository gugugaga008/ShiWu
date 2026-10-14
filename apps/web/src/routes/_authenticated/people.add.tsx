import { createFileRoute } from '@tanstack/react-router'
import { PeopleAdd } from '@/features/boss/people-add'

type Mode = 'photo' | 'file' | 'live'

export const Route = createFileRoute('/_authenticated/people/add')({
  validateSearch: (search: Record<string, unknown>): { mode?: Mode; person?: string } => ({
    mode: search.mode === 'photo' || search.mode === 'file' || search.mode === 'live' ? search.mode : undefined,
    person: typeof search.person === 'string' && search.person ? search.person : undefined,
  }),
  component: function AddPeopleRoute() {
    const { mode, person } = Route.useSearch()
    return <PeopleAdd initialMode={mode ?? 'photo'} personId={person} />
  },
})
