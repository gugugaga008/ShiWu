import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

/** 识别服务断开时的全局提示；主进程会自动重启后端，这里负责让用户知道当前不可用。 */
export function BackendStatusBanner() {
  const qc = useQueryClient()
  const { isError, isFetching, refetch } = useQuery({
    queryKey: ['backend-health'],
    queryFn: async () => (await api.get('/status')).data,
    refetchInterval: 5000,
    retry: false,
  })
  const wasError = useRef(false)
  useEffect(() => {
    if (wasError.current && !isError) void qc.invalidateQueries()
    wasError.current = isError
  }, [isError, qc])
  if (!isError) return null
  return (
    <div role='alert' className='fixed inset-x-0 top-0 z-[90] flex items-center justify-center gap-3 bg-destructive px-4 py-2 text-sm text-white shadow-lg'>
      <AlertTriangle className='size-4 shrink-0' aria-hidden />
      <span>识别服务连接中断，正在自动重启；监控暂时不可用。</span>
      <Button size='sm' variant='secondary' disabled={isFetching} onClick={() => void refetch()}>
        <RefreshCw className={isFetching ? 'animate-spin' : ''} /> 重试
      </Button>
    </div>
  )
}
