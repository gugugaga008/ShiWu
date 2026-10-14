import { useEffect, useState } from 'react'
import { QrCode } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, errMsg } from '@/lib/api'

type PreviewSession = {
  id: string
  qr: string
  expires_at: number
  addresses: string[]
  address: string
}

async function revoke(id: string) {
  try {
    await api.delete(`/mobile-preview/${id}`)
  } catch {
    toast.error('撤销预览失败；请重试，或停止该视频源。链接最迟在 10 分钟后失效。')
  }
}

export function MobilePreview({ source, disabled }: { source: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant='outline' disabled={disabled} onClick={() => setOpen(true)}>
        <QrCode /> 手机预览
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>扫码查看「{source}」</DialogTitle>
          <DialogDescription>
            手机与电脑连接同一 Wi-Fi，扫描下方二维码后在手机浏览器打开。电脑不显示实时画面。
          </DialogDescription>
        </DialogHeader>
        {open && <PreviewCode source={source} />}
      </DialogContent>
    </Dialog>
  )
}

function PreviewCode({ source }: { source: string }) {
  const [address, setAddress] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; session?: PreviewSession; error?: string }>()
  const [now, setNow] = useState(() => Date.now())
  const key = `${source}:${address}:${attempt}`

  useEffect(() => {
    let disposed = false
    let session: PreviewSession | undefined
    void api.post<PreviewSession>('/mobile-preview', { source, ...(address ? { address } : {}) })
      .then(({ data }) => {
        session = data
        if (disposed) void revoke(data.id)
        else setResult({ key, session: data })
      })
      .catch((e: unknown) => {
        if (!disposed) setResult({ key, error: errMsg(e) })
      })
    return () => {
      disposed = true
      if (session) void revoke(session.id)
    }
  }, [source, address, attempt, key])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const current = result?.key === key ? result : undefined
  const session = current?.session
  const expired = !!session && now >= session.expires_at * 1000
  return (
    <div className='grid justify-items-center gap-4'>
      {!current && <p role='status'>正在生成二维码…</p>}
      {current?.error && <p role='alert' className='text-sm text-destructive'>{current.error}</p>}
      {session && !expired && (
        <>
          <img src={session.qr} alt='手机预览二维码' className='size-64 max-w-full rounded bg-white p-2' />
          <p className='text-sm text-muted-foreground'>有效期至 {new Date(session.expires_at * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</p>
          {session.addresses.length > 1 && (
            <label className='grid w-full gap-1 text-sm'>
              手机无法连接时切换电脑网卡
              <select className='rounded-md border bg-background p-2' value={session.address} onChange={(e) => setAddress(e.target.value)}>
                {session.addresses.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
              </select>
            </label>
          )}
        </>
      )}
      {expired && <p role='status'>二维码已过期，请重新生成。</p>}
      {(current?.error || expired) && <Button variant='outline' onClick={() => setAttempt((v) => v + 1)}>重新生成二维码</Button>}
      <p className='text-xs text-muted-foreground'>关闭弹窗即撤销访问；链接最长有效 10 分钟。不要分享二维码，仅在可信局域网使用。如无法连接，请检查防火墙和 Wi-Fi 设备隔离。</p>
    </div>
  )
}
