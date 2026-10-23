// A privacy notice version's body, as people read it (C0.9 PD-33, PD-46, PD-47; TECH-SPEC T22
// item 22): the exact words they acknowledge, stored as plain text in a fixed line format
// (packages/shared notice.ts NOTICE_LINE), drawn here as headings, paragraphs and lists. Every
// word is React text, never HTML (WS-07), so nothing in a body can become markup: the generator
// never lets the DPO's free text or the org's name start a line, and this reader makes a line a
// heading or an item only by its marker at the very start.
//
// The format, line by line:
//   '## '   a section heading
//   '### '  an entry inside a section: a purpose or a provider
//   '- '    an item; consecutive items are one list
//   blank   ends a list; otherwise only spacing
//   other   a paragraph
// A marker with nothing after it is no heading or item: its line is a paragraph as written, so no
// text is ever dropped. The headings sit at `level` (h2 on /notice, under its h1; h3 in Settings,
// under the card's h2) and the entries one below.
import { NOTICE_LINE } from '@hearth/shared'

export type NoticeBlock =
  | { readonly kind: 'section'; readonly text: string }
  | { readonly kind: 'entry'; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }

// The marker a line starts with and the text after it; entry is tested before section, since
// '### ' starts with '##'.
function marked(line: string, marker: string): string | undefined {
  if (!line.startsWith(marker)) return undefined
  const text = line.slice(marker.length)
  return text.trim() === '' ? undefined : text
}

export function parseNotice(body: string): NoticeBlock[] {
  const blocks: NoticeBlock[] = []
  let list: string[] | undefined
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === '') {
      list = undefined
      continue
    }
    const item = marked(line, NOTICE_LINE.item)
    if (item !== undefined) {
      if (list === undefined) {
        list = []
        blocks.push({ kind: 'list', items: list })
      }
      list.push(item)
      continue
    }
    list = undefined
    const entry = marked(line, NOTICE_LINE.entry)
    const section = entry === undefined ? marked(line, NOTICE_LINE.section) : undefined
    if (entry !== undefined) blocks.push({ kind: 'entry', text: entry })
    else if (section !== undefined) blocks.push({ kind: 'section', text: section })
    else blocks.push({ kind: 'paragraph', text: line })
  }
  return blocks
}

export interface NoticeBodyProps {
  body: string
  // The sections' heading level; the entries' is one below.
  level?: 2 | 3
}

export function NoticeBody({ body, level = 2 }: NoticeBodyProps) {
  return (
    <div className="flex flex-col gap-3 break-words">
      {parseNotice(body).map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a version's body never changes (PD-33), so its blocks never reorder, and two of them can hold the same words
        <Block key={index} block={block} level={level} />
      ))}
    </div>
  )
}

function Block({ block, level }: { block: NoticeBlock; level: 2 | 3 }) {
  const Section = level === 2 ? 'h2' : 'h3'
  const Entry = level === 2 ? 'h3' : 'h4'
  switch (block.kind) {
    case 'section':
      return <Section className="pt-3 font-display text-xl font-semibold first:pt-0">{block.text}</Section>
    case 'entry':
      return <Entry className="pt-1 font-semibold">{block.text}</Entry>
    case 'paragraph':
      return <p>{block.text}</p>
    case 'list':
      return (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {block.items.map((item, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: as the blocks: the items never reorder, and two can read the same
            <li key={at}>{item}</li>
          ))}
        </ul>
      )
  }
}
