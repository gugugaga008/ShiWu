import { create } from 'zustand'

type SettingsDialogState = {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useSettingsDialog = create<SettingsDialogState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
