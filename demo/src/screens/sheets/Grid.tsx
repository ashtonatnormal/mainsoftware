// The cell grid for Sheets: sticky column letters and row numbers, frozen rows,
// selection and collaborator outlines, in-place editing and column resizing.
// All state lives in the editor (Sheets.tsx); this only draws and reports.
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { Plus } from 'lucide-react'
import type { PersonId, SheetCell, SheetTab } from '../../types'
import { personById } from '../../data/people'
import { cx, personShort } from '../../ui'
import { addrOf, colName, formatValue, isError, type Pos, type Range, type Value } from './formula'

export const FILL_CLASS: Record<NonNullable<SheetCell['fill']>, string> = {
  accent: 'bg-accent-soft',
  agent: 'bg-agent-soft',
  ok: 'bg-ok-soft',
  warn: 'bg-warn-soft',
  rec: 'bg-rec-soft',
  muted: 'bg-surface-2',
}

export const DEFAULT_COL_W = 100
export const ROW_HEAD_W = 44

export const personColour = (id: PersonId) => `oklch(0.58 0.12 ${personById[id]?.hue ?? 200})`

export interface EditState { value: string; mode: 'type' | 'inplace' | 'bar' }

const edgeShadow = (top: boolean, right: boolean, bottom: boolean, left: boolean, colour: string, w = 2) =>
  [top && `inset 0 ${w}px 0 ${colour}`, right && `inset -${w}px 0 0 ${colour}`, bottom && `inset 0 -${w}px 0 ${colour}`, left && `inset ${w}px 0 0 ${colour}`].filter(Boolean).join(', ') || undefined

export interface GridProps {
  tab: SheetTab
  values: Map<string, Value>
  range: Range
  active: Pos
  edit: EditState | null
  readOnly: boolean
  rowH: number
  headH: number
  widths: Record<string, number>
  cursors: Record<PersonId, string>
  highlight?: (addr: string, v: Value) => 'warn' | undefined
  gridRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLInputElement | null>
  onGridKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void
  onCellPointerDown: (p: Pos, e: ReactPointerEvent) => void
  onCellPointerEnter: (p: Pos) => void
  onCellTap: (p: Pos) => void
  onCellDoubleClick: (p: Pos) => void
  onHeaderSelect: (kind: 'row' | 'col', index: number, extend: boolean) => void
  onEditChange: (v: string) => void
  onEditKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  onEditBlur: () => void
  onResize: (col: string, w: number, done: boolean) => void
  onAddRows: () => void
  footer?: ReactNode
}

export function Grid(props: GridProps) {
  const { tab, values, range, active, edit, readOnly, rowH, headH, widths, cursors, highlight, gridRef, inputRef } = props
  const frozen = Math.min(tab.frozenRows ?? 0, tab.rows)
  const colW = (c: number) => widths[colName(c)] ?? tab.colWidths?.[colName(c)] ?? DEFAULT_COL_W
  const cols = Array.from({ length: tab.cols }, (_, c) => c)
  const rows = Array.from({ length: tab.rows }, (_, r) => r)
  const totalW = ROW_HEAD_W + cols.reduce((s, c) => s + colW(c), 0)
  const single = range.r0 === range.r1 && range.c0 === range.c1
  const lastPointer = useRef<string>('mouse')

  // Collaborator outlines by address.
  const others = new Map<string, PersonId[]>()
  for (const [pid, a] of Object.entries(cursors)) others.set(a, [...(others.get(a) ?? []), pid])

  const resizeStart = (e: ReactPointerEvent<HTMLSpanElement>, c: number) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX, startW = colW(c), name = colName(c)
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => props.onResize(name, Math.max(40, Math.round(startW + ev.clientX - startX)), false)
    const up = (ev: PointerEvent) => {
      props.onResize(name, Math.max(40, Math.round(startW + ev.clientX - startX)), true)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={gridRef}
      tabIndex={0}
      role="grid"
      aria-label={`${tab.name} cells`}
      aria-rowcount={tab.rows}
      aria-colcount={tab.cols}
      aria-readonly={readOnly}
      onKeyDown={props.onGridKeyDown}
      className="relative h-full min-h-0 overflow-auto overscroll-contain bg-surface outline-none focus-visible:outline-none"
      style={{ touchAction: 'pan-x pan-y' }}
    >
      <table className="border-separate border-spacing-0 text-[13px]" style={{ width: totalW, tableLayout: 'fixed' }}>
        <colgroup>
          <col style={{ width: ROW_HEAD_W }} />
          {cols.map(c => <col key={c} style={{ width: colW(c) }} />)}
        </colgroup>
        <thead>
          <tr style={{ height: headH }}>
            <th className="sticky top-0 left-0 z-30 border-r border-b border-line bg-surface-2" aria-label="Select all">
              <button className="size-full" aria-label="Select all cells" onClick={() => { props.onHeaderSelect('row', 0, false); props.onHeaderSelect('row', tab.rows - 1, true) }} />
            </th>
            {cols.map(c => {
              const on = c >= range.c0 && c <= range.c1
              return (
                <th key={c} scope="col" className={cx('sticky top-0 z-20 border-r border-b border-line p-0 text-[11px] font-semibold', on ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-muted')}>
                  <button className="size-full" aria-label={`Select column ${colName(c)}`} onClick={e => props.onHeaderSelect('col', c, e.shiftKey)}>{colName(c)}</button>
                  {!readOnly && (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize column ${colName(c)}`}
                      onPointerDown={e => resizeStart(e, c)}
                      className="absolute top-0 -right-1 z-10 hidden h-full w-2 cursor-col-resize hover:bg-accent/40 md:block"
                    />
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const isFrozen = r < frozen
            const stickTop: CSSProperties | undefined = isFrozen ? { position: 'sticky', top: headH + r * rowH } : undefined
            const rowOn = r >= range.r0 && r <= range.r1
            return (
              <tr key={r} style={{ height: rowH }}>
                <th
                  scope="row"
                  style={stickTop}
                  className={cx('sticky left-0 border-r border-b border-line p-0 text-[11px] font-semibold tabular', isFrozen ? 'z-[25]' : 'z-10', rowOn ? 'bg-accent-soft text-accent-ink' : 'bg-surface-2 text-muted', isFrozen && r === frozen - 1 && 'border-b-2 border-b-muted/40')}
                >
                  <button className="size-full" aria-label={`Select row ${r + 1}`} onClick={e => props.onHeaderSelect('row', r, e.shiftKey)}>{r + 1}</button>
                </th>
                {cols.map(c => {
                  const addr = addrOf({ r, c })
                  const cell = tab.cells[addr]
                  const v = values.get(addr) ?? null
                  const isActive = r === active.r && c === active.c
                  const inRange = rowOn && c >= range.c0 && c <= range.c1
                  const editing = isActive && edit && edit.mode !== 'bar'
                  const live = isActive && edit?.mode === 'bar'
                  const text = live ? edit.value : formatValue(v, cell?.fmt)
                  const err = !live && isError(v)
                  const hl = highlight?.(addr, v)
                  const align = cell?.align ?? (live ? 'left' : err || typeof v === 'boolean' ? 'center' : typeof v === 'number' && cell?.fmt !== 'text' ? 'right' : 'left')
                  const who = others.get(addr)
                  return (
                    <td
                      key={c}
                      data-addr={addr}
                      role="gridcell"
                      aria-selected={inRange}
                      onPointerDown={e => { lastPointer.current = e.pointerType; if (e.pointerType === 'mouse') props.onCellPointerDown({ r, c }, e) }}
                      onPointerEnter={e => { if (e.pointerType === 'mouse' && e.buttons === 1) props.onCellPointerEnter({ r, c }) }}
                      onClick={() => { if (lastPointer.current !== 'mouse') props.onCellTap({ r, c }) }}
                      onDoubleClick={() => props.onCellDoubleClick({ r, c })}
                      style={{ ...stickTop, scrollMarginTop: headH + frozen * rowH, scrollMarginLeft: ROW_HEAD_W }}
                      className={cx(
                        'relative border-r border-b border-line p-0 select-none',
                        isFrozen && 'z-[5]',
                        isFrozen && r === frozen - 1 && 'border-b-2 border-b-muted/40',
                        hl ? FILL_CLASS[hl] : cell?.fill ? FILL_CLASS[cell.fill] : 'bg-surface',
                        (editing || who) && 'z-[6]',
                      )}
                    >
                      <div
                        className={cx(
                          'overflow-hidden px-2 whitespace-nowrap text-ellipsis',
                          cell?.b && 'font-semibold',
                          cell?.i && 'italic',
                          err && 'text-rec font-semibold',
                          hl === 'warn' && 'text-warn font-semibold',
                          align === 'right' ? 'text-right tabular' : align === 'center' ? 'text-center' : 'text-left',
                        )}
                        style={{ lineHeight: `${rowH - 1}px` }}
                        title={err ? errorHelp((v as { error: string }).error) : undefined}
                      >
                        {text}
                      </div>
                      {inRange && !single && !isActive && <span aria-hidden className="pointer-events-none absolute inset-0 bg-accent/10" />}
                      {inRange && !single && (
                        <span aria-hidden className="pointer-events-none absolute inset-0" style={{ boxShadow: edgeShadow(r === range.r0, c === range.c1, r === range.r1, c === range.c0, 'var(--accent)') }} />
                      )}
                      {isActive && <span aria-hidden className="pointer-events-none absolute inset-0 z-[1]" style={{ boxShadow: edgeShadow(true, true, true, true, 'var(--accent)') }} />}
                      {who && !isActive && (
                        <>
                          <span aria-hidden className="pointer-events-none absolute inset-0" style={{ boxShadow: edgeShadow(true, true, true, true, personColour(who[0])) }} />
                          <span
                            className={cx('pointer-events-none absolute left-0 z-[2] rounded-sm px-1 text-[10px] leading-4 font-semibold whitespace-nowrap text-white', r === 0 ? 'top-full' : '-top-4')}
                            style={{ background: personColour(who[0]) }}
                          >
                            {who.map(personShort).join(', ')}
                          </span>
                        </>
                      )}
                      {editing && (
                        <input
                          ref={inputRef}
                          autoFocus
                          aria-label={`Edit ${addr}`}
                          id="sheet-cell-input"
                          value={edit.value}
                          onChange={e => props.onEditChange(e.target.value)}
                          onKeyDown={props.onEditKeyDown}
                          onBlur={props.onEditBlur}
                          spellCheck={false}
                          autoComplete="off"
                          enterKeyHint="done"
                          className="absolute top-0 left-0 z-[3] h-full rounded-none bg-surface px-2 text-base text-fg outline-none md:text-[13px]"
                          style={{ minWidth: '100%', width: `max(100%, ${edit.value.length + 3}ch)`, boxShadow: edgeShadow(true, true, true, true, 'var(--accent)') }}
                        />
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      {!readOnly && (
        <div className="sticky left-0 flex items-center gap-3 px-3 py-3" style={{ width: 'min(100%, 100vw)' }}>
          <button onClick={props.onAddRows} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-[13px] font-medium hover:bg-line">
            <Plus size={14} aria-hidden /> Add 20 rows
          </button>
          <span className="text-xs text-muted tabular">{tab.rows} rows · {tab.cols} columns</span>
        </div>
      )}
      {props.footer}
    </div>
  )
}

export function errorHelp(code: string): string {
  switch (code) {
    case '#DIV/0!': return 'Divides by zero or by an empty cell.'
    case '#REF!': return 'Refers to a cell outside this tab.'
    case '#NAME?': return 'Uses a function or name this sheet doesn’t know.'
    case '#VALUE!': return 'Does maths on text, or a range where one value is needed.'
    case '#CYCLE!': return 'Refers back to itself, directly or through other cells.'
    case '#ERROR!': return 'The formula can’t be read. Check brackets, quotes and commas.'
    default: return ''
  }
}
