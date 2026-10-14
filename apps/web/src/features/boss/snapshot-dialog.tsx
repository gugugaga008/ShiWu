import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function SnapshotDialog({
  open,
  onOpenChange,
  title,
  timeLabel,
  description,
  imageSrc,
  imageAlt = '快照',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  timeLabel?: string
  description?: string
  imageSrc?: string | null
  imageAlt?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='overflow-hidden p-0 sm:max-w-4xl'>
        <div className='bg-zinc-950 px-6 py-5 text-zinc-50'>
          <DialogHeader>
            <DialogTitle className='text-zinc-50'>{title}</DialogTitle>
            {timeLabel && <p className='font-mono text-sm text-amber-400'>{timeLabel}</p>}
            {description && <DialogDescription className='text-zinc-400'>{description}</DialogDescription>}
          </DialogHeader>
        </div>
        {imageSrc ? (
          <div className='bg-zinc-900 p-3'>
            <img src={imageSrc} alt={imageAlt} className='max-h-[70vh] w-full rounded-md object-contain' />
          </div>
        ) : (
          <p className='p-6 text-sm text-muted-foreground'>无快照</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
