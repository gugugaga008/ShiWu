import { type SVGProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * 识务标记：取景框内的人脸轮廓 + 一道预警扫线。
 * 取景框取自人脸检测的角框，扫线命中右上角的目标点，寓意“认出谁来了”。
 */
export function Logo({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox='0 0 32 32'
      xmlns='http://www.w3.org/2000/svg'
      fill='none'
      className={cn('size-6', className)}
      aria-hidden
      {...props}
    >
      <title>识务</title>
      {/* 取景框四角 */}
      <path
        d='M7 12.5V8.8A1.8 1.8 0 0 1 8.8 7h3.7M19.5 7h3.7a1.8 1.8 0 0 1 1.8 1.8v3.7M25 19.5v3.7a1.8 1.8 0 0 1-1.8 1.8h-3.7M12.5 25H8.8A1.8 1.8 0 0 1 7 23.2v-3.7'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
      />
      {/* 人脸轮廓 */}
      <path
        d='M16 12c-2.5 0-4 1.9-4 4.2 0 1.5.6 2.7 1.6 3.5.8.7 1.9 1 2.4 1 .5 0 1.6-.3 2.4-1 1-.8 1.6-2 1.6-3.5 0-2.3-1.5-4.2-4-4.2Z'
        stroke='currentColor'
        strokeWidth='1.8'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
      {/* 预警扫线：从左下向右上扫过 */}
      <path d='M10.5 21.5 22 10' stroke='currentColor' strokeWidth='1.7' strokeLinecap='round' opacity='0.55' />
      {/* 命中的目标点 */}
      <circle cx='22' cy='10' r='2.4' fill='currentColor' />
    </svg>
  )
}
