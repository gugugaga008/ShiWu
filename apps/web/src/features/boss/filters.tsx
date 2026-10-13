import { useQuery } from '@tanstack/react-query'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api, type Person, ROLE_LABEL } from '@/lib/api'

const ALL = '_all'

export function usePeople() {
  return useQuery({ queryKey: ['people'], queryFn: async () => (await api.get<Person[]>('/people')).data }).data ?? []
}
export function useSourceNames() {
  return useQuery({ queryKey: ['source-names'], queryFn: async () => (await api.get<string[]>('/sources/names')).data }).data ?? []
}

export function FilterSelect({ value, onChange, options, placeholder, width = 'w-36' }: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  width?: string
}) {
  return (
    <Select value={value || ALL} onValueChange={(v) => onChange(v === ALL ? '' : v)}>
      <SelectTrigger className={width}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{placeholder}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export const roleOptions = ['boss', 'leader', 'staff', 'whitelist'].map((r) => ({ value: r, label: ROLE_LABEL[r] }))
