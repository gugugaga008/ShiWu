import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { QrCode } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, errMsg } from '@/lib/api'

type PreviewSession = {
  id: string
  source?: string
  qr: string
  expires_at: number
  addresses: string[]
  address: string
}

export function MobilePreview({ source, disabled }: { source: string; disabled?: boolean }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [session, setSession] = useState<PreviewSession>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const pending = useRef(false)

  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [open])

  async function load() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    setDisconnected(false)
    try {
      // 同一路入口共享进行中的请求；后端会话不随弹窗或页面卸载而销毁。
      const result = await qc.fetchQuery({
        queryKey: ['mobile-preview-session', source],
        staleTime: 0,
        retry: false,
        queryFn: async () => {
          const { data: sessions } = await api.get<PreviewSession[]>('/mobile-preview')
          const existing = sessions.find((s) => s.source === source && s.expires_at * 1000 > Date.now())
          return existing ?? (await api.post<PreviewSession>('/mobile-preview', { source })).data
        },
      })
      setSession(result)
      setNow(Date.now())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function disconnect() {
    if (!session || pending.current) return
    pending.current = true
    setBusy(true)
    try {
      await api.delete('/mobile-preview', { params: { source } })
      setSession(undefined)
      setDisconnected(true)
      setError('')
    } catch {
      toast.error('断开预览失败；请重试，或停止该画面源。链接最迟在 10 分钟后失效。')
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  async function changeAddress(address: string) {
    if (!session || pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      // 同源多标签页可能生成多份二维码；切换网卡前一并撤销，失败则保留原会话。
      await api.delete('/mobile-preview', { params: { source } })
      setSession(undefined)
      setSession((await api.post<PreviewSession>('/mobile-preview', { source, address })).data)
      setNow(Date.now())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function changeOpen(value: boolean) {
    setOpen(value)
    if (value) void load()
  }

  const expired = !!session && now >= session.expires_at * 1000
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <Button variant='outline' disabled={disabled} onClick={() => changeOpen(true)}>
        <QrCode /> 手机预览
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'><QrCode className='size-5' aria-hidden />扫码查看「{source}」</DialogTitle>
          <DialogDescription>
            手机与电脑连接同一 Wi-Fi，扫码后在手机浏览器打开。关闭弹窗或切换页面不会断开，电脑不显示实时画面。
          </DialogDescription>
        </DialogHeader>
        <div className='grid justify-items-center gap-4'>
          {busy && <p role='status'>正在准备手机预览…</p>}
          {error && <p role='alert' className='text-sm text-destructive'>{error}</p>}
          {disabled ? <p role='status'>画面源已结束，手机预览已失效。</p> : session && !expired && !busy && (
            <>
              <img src={session.qr} alt='手机预览二维码' className='size-64 max-w-full rounded bg-white p-2' />
              <p className='text-sm text-muted-foreground'>有效期至 {new Date(session.expires_at * 1000).toLocaleTimeString('zh-CN', { hour12: false })}</p>
              {session.addresses.length > 1 && (
                <label className='grid w-full gap-1 text-sm'>
                  手机无法连接时切换电脑网卡（旧连接将断开）
                  <select className='rounded-md border bg-background p-2' value={session.address} onChange={(e) => void changeAddress(e.target.value)}>
                    {session.addresses.map((ip) => <option key={ip} value={ip}>{ip}</option>)}
                  </select>
                </label>
              )}
            </>
          )}
          {!disabled && expired && <p role='status'>二维码已过期，请重新生成。</p>}
          {disconnected && <p role='status'>手机预览已断开。</p>}
          <div className='flex flex-wrap justify-center gap-2'>
            {!disabled && (error || expired || disconnected) && <Button variant='outline' disabled={busy} onClick={() => void load()}>重新生成二维码</Button>}
            {session && <Button variant='destructive' disabled={busy} onClick={() => void disconnect()}>断开手机预览</Button>}
            <Button variant='outline' onClick={() => setOpen(false)}>隐藏二维码</Button>
          </div>
          <p className='text-xs text-muted-foreground'>链接最长有效 10 分钟，不会因重开弹窗而续期。主动断开会结束该路所有手机连接；到期、停止或替换画面源后也会失效。不要分享二维码，仅在可信局域网使用；连接失败请检查防火墙和 Wi-Fi 设备隔离。</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
