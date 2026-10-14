import { create } from 'zustand'

export type SettingsSection = 'sources' | 'defaults' | 'startup' | 'preview' | 'performance' | 'snapshots' | 'email'

type SettingsDialogState = {
  open: boolean
  section: SettingsSection
  setOpen: (open: boolean) => void
  setSection: (section: SettingsSection) => void
  openSection: (section: SettingsSection) => void
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  section: 'sources',
  setOpen: (open) => set({ open }),
  setSection: (section) => set({ section }),
  openSection: (section) => set({ open: true, section }),
}))
