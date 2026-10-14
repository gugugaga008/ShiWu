import { type SVGProps } from 'react'
import { cn } from '@/lib/utils'

/** 识务标记：雷达扫视，区别于通用人脸扫描图标。 */
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
      <circle cx='16' cy='16' r='11' stroke='currentColor' strokeWidth='1.8' />
      <path d='M16 5.8a10.2 10.2 0 0 1 10.2 10.2' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' />
      <path d='M16 16l7.2-7.2' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' />
      <circle cx='16' cy='16' r='3.1' fill='currentColor' />
    </svg>
  )
}
