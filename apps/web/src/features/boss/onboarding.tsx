import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { setCookie, getCookie } from '@/lib/cookies'
import { cn } from '@/lib/utils'

const TOUR_COOKIE = 'shiwu_onboarded'

type Step = {
  /** 高亮元素的 data-tour 值；空则整屏无聚光灯（纯展示） */
  target?: string
  title: string
  desc: string
  /** 卡片相对高亮区的位置 */
  side?: 'top' | 'bottom' | 'left' | 'right'
}

const STEPS: Step[] = [
  {
    title: '欢迎使用识务',
    desc: '认出镜头里的人，自动执行提醒或遮挡。30 秒看完这个引导就能上手。',
  },
  {
    target: 'nav-settings',
    title: '第一步 · 添加画面源',
    desc: '打开「设置 → 画面源」，选一个摄像头、网络流或视频文件，点「添加并启动」。',
    side: 'right',
  },
  {
    target: 'nav-people',
    title: '第二步 · 登记要识别的人',
    desc: '到「人员管理 → 添加人员」，用照片或现场采集把老板、同事录进去。',
    side: 'right',
  },
  {
    target: 'nav-rules',
    title: '第三步 · 设置触发规则',
    desc: '到「规则设置」决定认出谁时做什么。默认只有系统通知；需要遮挡请勾选「全屏遮挡（假装工作）」。',
    side: 'right',
  },
  {
    target: 'nav-overview',
    title: '识别与事件',
    desc: '回到「概览」看各路画面源状态和实时事件，「时间线」可回看每次触发快照。',
    side: 'right',
  },
  {
    title: '准备就绪',
    desc: '监控开始后可以最小化窗口，识务会在托盘继续运行。随时可在左侧菜单再次进入对应页面调整。',
  },
]

type Rect = { x: number; y: number; w: number; h: number }

function targetRect(target: string): Rect | null {
  const el = document.querySelector(`[data-tour='${target}']`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  const pad = 8
  return { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 }
}

function cardPos(rect: Rect | null, side: Step['side']): CSSProperties {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (!rect) {
    return { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }
  }
  const gap = 18
  const cw = Math.min(360, vw - 32)
  const est = { w: cw, h: 170 }
  let x = rect.x + rect.w + gap
  let y = rect.y + rect.h / 2 - est.h / 2
  if (side === 'bottom' || x + cw > vw - 16) {
    x = Math.max(16, Math.min(rect.x + rect.w / 2 - cw / 2, vw - cw - 16))
    y = Math.min(rect.y + rect.h + gap, vh - est.h - 16)
  }
  if (side === 'top') {
    x = Math.max(16, Math.min(rect.x + rect.w / 2 - cw / 2, vw - cw - 16))
    y = Math.max(16, rect.y - est.h - gap)
  }
  y = Math.max(16, Math.min(y, vh - est.h - 16))
  return { left: x, top: y, width: cw }
}

/** 首次启动的分步引导：聚光灯高亮菜单，逐步讲流程。完成/跳过写 cookie，不再弹出。 */
export function Onboarding() {
  const [step, setStep] = useState<number | null>(null)
  const [rect, setRect] = useState<Rect | null>(null)

  useEffect(() => {
    const forced = new URLSearchParams(window.location.search).get('tour') === '1'
    if (!forced && getCookie(TOUR_COOKIE)) return
    // 等首屏布局稳定后再挂遮罩；从设置重看引导时立即打开
    const t = window.setTimeout(() => setStep(0), forced ? 50 : 600)
    return () => window.clearTimeout(t)
  }, [])

  const done = useCallback(() => {
    setCookie(TOUR_COOKIE, '1', 60 * 60 * 24 * 3650)
    setStep(null)
    const url = new URL(window.location.href)
    if (url.searchParams.has('tour')) {
      url.searchParams.delete('tour')
      window.history.replaceState({}, '', url)
    }
  }, [])

  const s = step === null ? null : STEPS[step]

  const measure = useCallback(() => {
    if (s?.target) setRect(targetRect(s.target))
    else setRect(null)
  }, [s])

  // 高亮目标可能随布局异步出现（如子菜单展开），持续用 rAF 轻量重测，直到拿到矩形或换步
  useLayoutEffect(() => {
    let raf = 0
    // 初始为 undefined：首个 tick（无论有没有目标）一定写入；否则最后一步会残留上一步的高亮。
    let lastRect: Rect | null | undefined
    const tick = () => {
      const next = s?.target ? targetRect(s.target) : null
      const changed = lastRect === undefined ||
        (next === null) !== (lastRect === null) ||
        (next && lastRect && (next.x !== lastRect.x || next.y !== lastRect.y || next.w !== lastRect.w || next.h !== lastRect.h))
      if (changed) { setRect(next); lastRect = next }
      raf = requestAnimationFrame(tick)
    }
    tick()
    window.addEventListener('resize', measure)
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', measure) }
  }, [measure, s])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (step === null) return
      if (e.key === 'Escape') done()
      else if (e.key === 'ArrowRight' || e.key === 'Enter') setStep((v) => (v === null ? v : Math.min(v + 1, STEPS.length - 1)))
      else if (e.key === 'ArrowLeft') setStep((v) => (v === null ? v : Math.max(v - 1, 0)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, done])

  // 引导允许直接点击被高亮菜单；点中目标即视为完成这一步，避免遮罩拦住操作。
  useEffect(() => {
    if (!s?.target) return
    const onClick = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest(`[data-tour='${s.target}']`)
      if (target) done()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [s, done])

  const { data: pipelines = [] } = useQuery({
    queryKey: ['onboarding-pipeline'],
    queryFn: async () => (await api.get<{ pipelines: { running: boolean }[] }>('/pipeline/status')).data.pipelines ?? [],
    enabled: step !== null,
  })
  const { data: people = [] } = useQuery({
    queryKey: ['onboarding-people'],
    queryFn: async () => (await api.get<{ person_id: string }[]>('/people')).data,
    enabled: step !== null,
  })
  const running = pipelines.some((item) => item.running)
  const hasPeople = people.length > 0

  if (s === null || step === null) return null
  const last = step === STEPS.length - 1
  const pos = cardPos(rect, s.side)
  const vw = window.innerWidth
  const vh = window.innerHeight

  return createPortal(
    <div className='pointer-events-none fixed inset-0 z-[100]' role='dialog' aria-modal='true' aria-label='新手引导'>
      {/* 遮罩：中间挖一个高亮孔；不拦截点击，允许直接操作被高亮的菜单 */}
      <svg className='pointer-events-none absolute inset-0 size-full' width={vw} height={vh} aria-hidden>
        <defs>
          <mask id='tour-hole'>
            <rect width={vw} height={vh} fill='white' />
            {rect && <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx='10' fill='black' />}
          </mask>
        </defs>
        <rect width={vw} height={vh} fill='rgb(0 0 0 / 0.62)' mask='url(#tour-hole)' />
        {rect && (
          <rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} rx='10'
            fill='none' stroke='rgb(251 191 36 / 0.9)' strokeWidth='2' />
        )}
      </svg>
      <button
        type='button'
        aria-label='跳过引导'
        onClick={done}
        className='pointer-events-auto absolute end-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20'
      >
        <X className='size-4' />
      </button>
      <div
        className={cn(
          'pointer-events-auto absolute rounded-xl border bg-popover p-4 text-popover-foreground shadow-2xl transition-all duration-200',
        )}
        style={pos}
      >
        <div className='mb-1 flex items-center justify-between gap-2'>
          <h3 className='font-semibold'>{s.title}</h3>
          <span className='shrink-0 text-xs text-muted-foreground'>{step + 1} / {STEPS.length}</span>
        </div>
        <p className='mb-4 text-sm leading-relaxed text-muted-foreground'>{s.desc}</p>
        {last && (
          <div className='mb-4 grid gap-2 rounded-md border bg-muted/40 p-3 text-sm'>
            <div className='flex items-center justify-between gap-3'>
              <span>{running ? '✓ 画面源已启动' : '○ 画面源未启动'}</span>
              {!running && <Link to='/sources' onClick={done} className='text-primary underline underline-offset-2'>去启动</Link>}
            </div>
            <div className='flex items-center justify-between gap-3'>
              <span>{hasPeople ? '✓ 已登记人员' : '○ 还没有登记人员'}</span>
              {!hasPeople && <Link to='/people/add' onClick={done} className='text-primary underline underline-offset-2'>去登记</Link>}
            </div>
          </div>
        )}
        <div className='flex items-center justify-between'>
          <Button size='sm' variant='ghost' onClick={done} className='text-muted-foreground'>跳过</Button>
          <div className='flex gap-2'>
            {step > 0 && (
              <Button size='sm' variant='outline' onClick={() => setStep(step - 1)}>
                <ChevronLeft className='size-4' /> 上一步
              </Button>
            )}
            <Button size='sm' onClick={() => (last ? done() : setStep(step + 1))}>
              {last ? '开始使用' : <>下一步 <ChevronRight className='size-4' /></>}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
