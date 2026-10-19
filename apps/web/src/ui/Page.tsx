// A screen's content column (T21): centred, padded, and no wider than reads well. It never scrolls
// itself; the shell's #screen is the one scroll container (D-08).
import type { ReactNode } from 'react'
import { cx } from './cx.ts'

export interface PageProps {
  width?: 'narrow' | 'wide'
  children: ReactNode
}

export function Page({ width = 'wide', children }: PageProps) {
  return (
    <div className={cx('mx-auto w-full px-4 py-5 sm:px-6', width === 'narrow' ? 'max-w-md' : 'max-w-3xl')}>
      {children}
    </div>
  )
}
