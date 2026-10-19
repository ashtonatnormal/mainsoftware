// The Search bar (T21; OD-04, R-34, BUILD-PLAN C1.7): built here, shown nowhere until C1.7 mounts it
// with search behind it. Its label is "Search", never "Search & Ask" (decision 8): asking arrives
// with its A-stage, in the AI slot beside the field, which renders nothing until then (D41).
//
// A search landmark around a form that never submits natively: onSubmit stops the browser's
// submission first (and the CSP's form-action 'none' would block it anyway), and noValidate keeps
// the browser's own bubble out (KM-14). The field is 16 px and 44 px tall (X7, SHL-28) and named
// "Search" by its label; on screen the Search button beside it says what the field is for (WCAG
// G167), never a placeholder alone. enterKeyHint shows "search" on a phone's keyboard.
import { Search } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { AiSlot } from '@/flags/ai-slots.tsx'
import { SHELL } from '@/strings/shell.ts'
import { Button } from '@/ui/Button.tsx'
import { CONTROL_CLASS } from '@/ui/Field.tsx'

export interface SearchBarProps {
  onSearch(query: string): void
}

export function SearchBar({ onSearch }: SearchBarProps) {
  const id = useId()
  const [query, setQuery] = useState('')
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = query.trim()
    if (trimmed !== '') onSearch(trimmed)
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: <search> is unsupported before Safari 17, and the pilot's floor is iOS 16.4
    <form role="search" method="post" noValidate onSubmit={submit} className="flex items-center gap-2">
      <label htmlFor={id} className="sr-only">
        {SHELL.search.label}
      </label>
      <input
        id={id}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        value={query}
        onChange={event => setQuery(event.target.value)}
        className={CONTROL_CLASS}
      />
      <Button type="submit" icon={Search} className="shrink-0">
        {SHELL.search.submit}
      </Button>
      <AiSlot name="search.ask" />
    </form>
  )
}
