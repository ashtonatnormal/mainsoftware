// Editing toolbar for Sheets: undo/redo, bold/italic, alignment, number format,
// fill colour, Σ quick functions and fill down/right. Compact on phones (it
// scrolls sideways inside itself; menus are fixed so they aren't clipped).
import { useRef, useState, type ReactNode } from 'react'
import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowRightToLine, Bold, ChevronDown, Italic, PaintBucket, Redo2, Sigma, Undo2 } from 'lucide-react'
import type { SheetCell } from '../../types'
import { cx } from '../../ui'
import { FILL_CLASS } from './Grid'
import { MenuItem, Popover } from './Popover'

export type QuickFn = 'SUM' | 'AVERAGE' | 'MIN' | 'MAX' | 'COUNT'
export type FillDir = 'down' | 'right'
type Align = NonNullable<SheetCell['align']>
type Fmt = SheetCell['fmt'] | 'auto'
type Fill = SheetCell['fill'] | 'none'

export const FORMATS: { value: Fmt; label: string; example: string }[] = [
  { value: 'auto', label: 'Automatic', example: '1234.5' },
  { value: 'number', label: 'Number', example: '1,234.5' },
  { value: 'integer', label: 'Whole number', example: '1,235' },
  { value: 'currency', label: 'Currency (S$)', example: 'S$1,234.50' },
  { value: 'percent', label: 'Percent', example: '96.0%' },
  { value: 'text', label: 'Plain text', example: 'as typed' },
]

const FILLS: { value: Fill; label: string }[] = [
  { value: 'none', label: 'No fill' },
  { value: 'accent', label: 'Ember' },
  { value: 'warn', label: 'Amber' },
  { value: 'ok', label: 'Green' },
  { value: 'agent', label: 'Teal' },
  { value: 'rec', label: 'Red' },
  { value: 'muted', label: 'Grey' },
]

export interface ToolbarProps {
  cell: SheetCell | undefined
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onStyle: (patch: Partial<SheetCell>) => void
  onQuick: (fn: QuickFn) => void
  onFill: (dir: FillDir) => void
  /** Everything waits while a formula is picking cells on another tab. */
  locked?: boolean
}

function TB({ label, active, onClick, children, disabled, className, refEl, expanded }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean; className?: string; refEl?: (el: HTMLButtonElement | null) => void; expanded?: boolean }) {
  return (
    <button
      ref={refEl}
      aria-label={label}
      title={label}
      aria-pressed={active}
      aria-expanded={expanded}
      disabled={disabled}
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      className={cx('grid h-9 min-w-9 shrink-0 place-items-center rounded-lg px-1.5 transition hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent', active && 'bg-accent-soft text-accent-ink hover:bg-accent-soft', className)}
    >
      {children}
    </button>
  )
}

const Divider = () => <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-line" />

export function Toolbar({ cell, canUndo, canRedo, onUndo, onRedo, onStyle, onQuick, onFill, locked }: ToolbarProps) {
  const [menu, setMenu] = useState<null | 'fmt' | 'fill' | 'sum' | 'align' | 'copy'>(null)
  const anchors = useRef<Record<string, HTMLButtonElement | null>>({})
  const align: Align = cell?.align ?? 'left'
  const fmt: Fmt = cell?.fmt ?? 'auto'
  const close = () => setMenu(null)
  const AlignIcon = align === 'center' ? AlignCenter : align === 'right' ? AlignRight : AlignLeft
  const fmtLabel = FORMATS.find(f => f.value === fmt)?.label ?? 'Automatic'

  return (
    <fieldset disabled={locked} className="contents">
    <div role="toolbar" aria-label="Formatting" aria-disabled={locked || undefined} className={cx('flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-surface px-2 transition-opacity [scrollbar-width:none] md:px-3', locked && 'opacity-60')}>
      <TB label="Undo (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}><Undo2 size={17} /></TB>
      <TB label="Redo (Ctrl+Shift+Z)" onClick={onRedo} disabled={!canRedo}><Redo2 size={17} /></TB>
      <Divider />
      <TB label="Bold (Ctrl+B)" active={!!cell?.b} onClick={() => onStyle({ b: !cell?.b })}><Bold size={17} /></TB>
      <TB label="Italic (Ctrl+I)" active={!!cell?.i} onClick={() => onStyle({ i: !cell?.i })}><Italic size={17} /></TB>
      {/* Desktop: three align buttons. Phone: one button with a menu. */}
      <span className="hidden items-center gap-0.5 md:flex">
        <TB label="Align left" active={align === 'left' && !!cell?.align} onClick={() => onStyle({ align: 'left' })}><AlignLeft size={17} /></TB>
        <TB label="Align centre" active={align === 'center'} onClick={() => onStyle({ align: 'center' })}><AlignCenter size={17} /></TB>
        <TB label="Align right" active={align === 'right'} onClick={() => onStyle({ align: 'right' })}><AlignRight size={17} /></TB>
      </span>
      <TB label="Align" className="md:hidden" expanded={menu === 'align'} refEl={el => { anchors.current.align = el }} onClick={() => setMenu(menu === 'align' ? null : 'align')}><AlignIcon size={17} /></TB>
      <Divider />
      <TB label={`Number format: ${fmtLabel}`} expanded={menu === 'fmt'} refEl={el => { anchors.current.fmt = el }} onClick={() => setMenu(menu === 'fmt' ? null : 'fmt')} className="gap-1 px-2 text-[13px] font-medium">
        <span className="flex items-center gap-1 whitespace-nowrap">
          <span className="tabular lg:hidden">{fmt === 'currency' ? 'S$' : fmt === 'percent' ? '%' : fmt === 'text' ? 'Abc' : fmt === 'number' ? '0.00' : fmt === 'integer' ? '0' : '123'}</span>
          <span className="hidden lg:inline">{fmtLabel}</span>
          <ChevronDown size={13} className="text-muted" />
        </span>
      </TB>
      <TB label="Fill colour" expanded={menu === 'fill'} refEl={el => { anchors.current.fill = el }} onClick={() => setMenu(menu === 'fill' ? null : 'fill')}>
        <span className="relative grid place-items-center">
          <PaintBucket size={17} />
          <span className={cx('absolute -bottom-1.5 h-1 w-4 rounded-full', cell?.fill ? FILL_CLASS[cell.fill] : 'bg-line')} aria-hidden />
        </span>
      </TB>
      <Divider />
      <TB label="Insert a function (Σ)" expanded={menu === 'sum'} refEl={el => { anchors.current.sum = el }} onClick={() => setMenu(menu === 'sum' ? null : 'sum')} className="gap-0.5 px-2">
        <span className="flex items-center gap-0.5"><Sigma size={17} /><ChevronDown size={13} className="text-muted" /></span>
      </TB>
      <TB label="Fill down or right" expanded={menu === 'copy'} refEl={el => { anchors.current.copy = el }} onClick={() => setMenu(menu === 'copy' ? null : 'copy')} className="gap-0.5 px-2">
        <span className="flex items-center gap-0.5"><ArrowDownToLine size={17} /><ChevronDown size={13} className="text-muted" /></span>
      </TB>

      <Popover label="Alignment" anchor={anchors.current.align ?? null} open={menu === 'align'} onClose={close}>
        {(['left', 'center', 'right'] as Align[]).map(a => (
          <MenuItem key={a} icon={a === 'left' ? <AlignLeft size={16} /> : a === 'center' ? <AlignCenter size={16} /> : <AlignRight size={16} />} onClick={() => { onStyle({ align: a }); close() }} hint={align === a ? '✓' : undefined}>
            {a === 'left' ? 'Left' : a === 'center' ? 'Centre' : 'Right'}
          </MenuItem>
        ))}
      </Popover>
      <Popover label="Number format" anchor={anchors.current.fmt ?? null} open={menu === 'fmt'} onClose={close}>
        {FORMATS.map(f => (
          <MenuItem key={f.value} onClick={() => { onStyle({ fmt: f.value === 'auto' ? undefined : f.value }); close() }} hint={f.example}>
            <span className={cx(fmt === f.value && 'font-semibold text-accent-ink')}>{f.label}</span>
          </MenuItem>
        ))}
      </Popover>
      <Popover label="Fill colour" anchor={anchors.current.fill ?? null} open={menu === 'fill'} onClose={close}>
        <div className="grid grid-cols-4 gap-1.5 p-1.5">
          {FILLS.map(f => {
            const on = (cell?.fill ?? 'none') === f.value
            return (
              <button
                key={f.value}
                role="menuitemradio"
                aria-checked={on}
                aria-label={f.label}
                title={f.label}
                onClick={() => { onStyle({ fill: f.value === 'none' ? undefined : f.value }); close() }}
                className={cx('grid size-10 place-items-center rounded-xl border-2 transition', on ? 'border-accent' : 'border-line hover:border-muted', f.value === 'none' ? 'bg-surface' : FILL_CLASS[f.value as NonNullable<SheetCell['fill']>])}
              >
                {f.value === 'none' && <span className="h-0.5 w-6 rotate-45 rounded bg-rec" aria-hidden />}
              </button>
            )
          })}
        </div>
      </Popover>
      <Popover label="Insert a function" anchor={anchors.current.sum ?? null} open={menu === 'sum'} onClose={close}>
        {([['SUM', 'Sum'], ['AVERAGE', 'Average'], ['MIN', 'Min'], ['MAX', 'Max'], ['COUNT', 'Count']] as [QuickFn, string][]).map(([fn, label]) => (
          <MenuItem key={fn} onClick={() => { onQuick(fn); close() }} hint={fn}>{label}</MenuItem>
        ))}
        <p className="px-3 pt-1 pb-1.5 text-[11px] text-muted">Uses the selected cells, or the numbers above the cell.</p>
      </Popover>
      <Popover label="Fill" anchor={anchors.current.copy ?? null} open={menu === 'copy'} onClose={close}>
        <MenuItem icon={<ArrowDownToLine size={16} />} onClick={() => { onFill('down'); close() }} hint="Ctrl+D">Fill down</MenuItem>
        <MenuItem icon={<ArrowRightToLine size={16} />} onClick={() => { onFill('right'); close() }} hint="Ctrl+R">Fill right</MenuItem>
        <p className="max-w-60 px-3 pt-1 pb-1.5 text-[11px] text-muted">Copies the top row (or left column) of the selection into the rest. References move with it; tab names stay.</p>
      </Popover>
    </div>
    </fieldset>
  )
}
