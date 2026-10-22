// The DPO pages and their dialogs, rendered with react-dom/server in Node (C0.9 PD-26, PD-27;
// T21, D-03): the app's root over a router at /dpo/purposes or /dpo/transfers with the registers'
// answer in the person's Query cache, and each dialog and refusal on its own. What the markup holds
// (the h1, the links between the registers, the cards, names, held buttons, the fields each basis
// takes) is checked here; how it behaves in a browser is dpo.spec.ts's.

import { REAUTH_METHOD_MESSAGES } from '@hearth/shared'
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { App } from '@/app/App.tsx'
import { RuntimeContext } from '@/app/runtime-context.ts'
import { createLiveStore } from '@/live/live-status.ts'
import { createAppRouter } from '@/router/router.tsx'
import { createQueryClient } from '@/session/query-client.ts'
import type { SessionRuntime } from '@/session/runtime.ts'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { DPO } from '@/strings/dpo.ts'
import { PURPOSES_COPY } from '@/strings/dpo-purposes.ts'
import { PROVIDER_CHECKS, TRANSFERS_COPY } from '@/strings/dpo-transfers.ts'
import { PurposeDialog } from './PurposesScreen.tsx'
import { registersQuery } from './queries.ts'
import { ReadRefusal } from './RegisterPage.tsx'
import { ClearDialog, TransferDialog, WithdrawDialog } from './TransfersScreen.tsx'
import { COMPLETE_FACTS, registersForClient, TODAY } from './testing/registers.ts'

// Ashton, the Tembusu seed's Owner and DPO (db/seed/tembusu.sql).
const ASHTON = {
  personId: 'b0000000-0000-4000-8000-000000000001',
  name: 'Ashton Teo',
  timeZone: 'Asia/Singapore',
  capabilities: { registers: true },
}

const CLEARED = {
  clearedOn: '2026-10-02',
  clearedBy: 'Ashton Teo',
  clearedVia: 'app',
  revision: 2,
  withdrawnOn: null,
  withdrawnBy: null,
  withdrawReason: null,
} as const

const REGISTERS = registersForClient(
  { security_audit: { version: 2, basis: 'legitimate_interests', basisReference: 'DPO file', retention: '13 months' } },
  { twilio: { ...COMPLETE_FACTS, revision: 2, clearance: CLEARED } },
)

const purpose = (key: string) => {
  const row = REGISTERS.purposes.find(each => each.purpose === key)
  if (row === undefined) throw new Error(`no ${key} in the fixture`)
  return row
}
const transfer = (key: string) => {
  const row = REGISTERS.transfers.find(each => each.provider === key)
  if (row === undefined) throw new Error(`no ${key} in the fixture`)
  return row
}

function runtime(registers?: typeof REGISTERS): SessionRuntime {
  const queryClient = createQueryClient(() => {})
  queryClient.setQueryData(['session'], ASHTON)
  if (registers !== undefined) queryClient.setQueryData(registersQuery.queryKey, registers)
  return {
    info: ASHTON,
    queryClient,
    live: createLiveStore('live'),
    signOut: async () => 'ended',
    end: () => {},
  } as unknown as SessionRuntime
}

async function appAt(path: string, registers: typeof REGISTERS | null = REGISTERS): Promise<string> {
  const session = runtime(registers ?? undefined)
  const router = createAppRouter(
    { runtime: session, storage: undefined },
    createMemoryHistory({ initialEntries: [path] }),
  )
  await router.load()
  return renderToStaticMarkup(<App router={router} runtime={session} />).replace(/<script\b.*?<\/script>/gs, '')
}

// A piece rendered on its own, inside what it reads: the person's QueryClient and runtime, and a
// router.
function alone(node: ReactNode): string {
  const session = runtime(REGISTERS)
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ['/'] }) })
  return renderToStaticMarkup(
    <QueryClientProvider client={session.queryClient}>
      <RuntimeContext value={session}>
        <RouterContextProvider router={router}>{node}</RouterContextProvider>
      </RuntimeContext>
    </QueryClientProvider>,
  )
}

// The attributes of every element with this tag, in order (React's casing: autoComplete, inputMode).
function tags(markup: string, tag: string): Map<string, string>[] {
  return [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(
    match => new Map([...(match[1] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(a => [a[1] ?? '', a[2] ?? ''])),
  )
}

const decoded = (text: string) =>
  text.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&lt;', '<')

// The text of every element with this tag.
const textsOf = (markup: string, tag: string) =>
  [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, 'gs'))].map(match =>
    decoded((match[1] ?? '').replace(/<[^>]+>/g, '')),
  )

// What a reader meets: the text, and every aria-label, title and alt.
function readable(markup: string): string[] {
  const text = markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  const names = [...markup.matchAll(/\b(?:aria-label|title|alt)="([^"]*)"/g)].map(match => match[1] ?? '')
  return [...text, ...names].map(decoded)
}

// The buttons, by their accessible name (aria-label, else the text), with whether each is held.
const buttons = (markup: string) =>
  [...markup.matchAll(/<button\b([^>]*)>(.*?)<\/button>/gs)].map(match => {
    const attributes = match[1] ?? ''
    const name = attributes.match(/aria-label="([^"]*)"/)?.[1] ?? (match[2] ?? '').replace(/<[^>]+>/g, '')
    return {
      name: decoded(name),
      held: /aria-disabled="true"/.test(attributes),
      type: attributes.match(/type="(\w+)"/)?.[1],
    }
  })

const optionsOf = (markup: string, name: string) => {
  const start = markup.search(new RegExp(`<select[^>]*name="${name}"`))
  return textsOf(markup.slice(start, markup.indexOf('</select>', start)), 'option')
}

describe('C0.9 PD-26: the DPO pages (dpo/)', () => {
  it('DPP-05 PDPA-01 PD-07 PD-27: /dpo/purposes is the shell’s page titled Processing register, with the links between the registers (Purposes current), a card per non-AI purpose with its status and an Edit named for it, the pinned purposes saying Hearth keeps them, and the two lines under the list', async () => {
    const markup = await appAt('/dpo/purposes')
    expect(textsOf(markup, 'h1')).toEqual(['Processing register'])
    const registers = tags(markup, 'nav').filter(nav => nav.get('aria-label') === 'Registers')
    expect(registers).toHaveLength(1)
    const links = [...markup.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gs)]
      .filter(match => /href="\/dpo\//.test(match[1] ?? ''))
      .map(match => [match[1]?.match(/href="([^"]*)"/)?.[1], match[1]?.match(/aria-current="([^"]*)"/)?.[1]])
    expect(links).toEqual([
      ['/dpo/purposes', 'page'],
      ['/dpo/transfers', undefined],
    ])
    const cards = textsOf(markup, 'h2')
    expect(cards).toHaveLength(13)
    expect(cards[0]).toBe('Accounts and sign-in: the roster, phone numbers and one-time codes, devices, profiles')
    expect(cards).not.toContain('Transcribing sessions')
    expect(buttons(markup).filter(button => button.name.startsWith('Edit '))).toHaveLength(13)
    expect(buttons(markup).map(button => button.name)).toContain('Edit Security audit and monitoring')
    expect(markup.split(PURPOSES_COPY.pinned).length - 1).toBe(2)
    expect(readable(markup)).toEqual(
      expect.arrayContaining([PURPOSES_COPY.startsWhenNotified, PURPOSES_COPY.laterStages]),
    )
    expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
    // No tab of the navigation claims the page.
    expect(
      tags(markup, 'a').filter(link => link.get('aria-current') && !link.get('href')?.startsWith('/dpo/')),
    ).toEqual([])
  })

  it('DPP-05 PDPA-10 PD-13 T22 item 3: /dpo/transfers is titled Transfer register, with a card per non-AI provider; Clear for use is held while facts are missing, a cleared provider offers Withdraw clearance, and each says what checks it', async () => {
    const markup = await appAt('/dpo/transfers')
    expect(textsOf(markup, 'h1')).toEqual(['Transfer register'])
    expect(textsOf(markup, 'h2')).toEqual([
      'Amazon Web Services',
      'AWS text messages',
      'Twilio Verify',
      'LiveKit Cloud',
      'Apple Push Notification service',
      'Firebase Cloud Messaging',
      'Mozilla Push Service',
      'Windows Push Notification Services',
    ])
    const all = buttons(markup)
    expect(all.filter(button => button.name === TRANSFERS_COPY.withdraw)).toEqual([
      { name: TRANSFERS_COPY.withdraw, held: false, type: 'button' },
    ])
    const clears = all.filter(button => button.name === TRANSFERS_COPY.clearForUse)
    expect(clears).toHaveLength(7)
    expect(clears.every(button => button.held)).toBe(true)
    expect(markup).toContain(TRANSFERS_COPY.clearHeld)
    expect(readable(markup)).toEqual(expect.arrayContaining(['Cleared on Fri 2 Oct 2026 by Ashton Teo']))
    expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
  })

  it('DPP-05 T21 item 5: before the answer, the page says it is loading, in a status', async () => {
    const markup = await appAt('/dpo/purposes', null)
    expect(markup).toMatch(/<p role="status"[^>]*>Loading the register…<\/p>/)
    expect(textsOf(markup, 'h2')).toEqual([])
  })

  it('DPP-05 PD-11 PD-07: the purpose dialog offers only what can save: a pinned purpose its one status as text and no consent-type basis; one that needs a switch every status and no consent-type basis; a legitimate-interests entry its assessment field', () => {
    const accounts = alone(<PurposeDialog row={purpose('accounts')} onClose={() => {}} />)
    expect(textsOf(accounts, 'h2')[0]).toMatch(/^Edit Accounts and sign-in/)
    expect(tags(accounts, 'fieldset').length).toBe(1)
    expect(accounts).toContain('Status: </span>Active')
    expect(optionsOf(accounts, 'basis')).toEqual([
      'Not recorded',
      'Employment: managing the working relationship',
      'Legitimate interests',
      'Business improvement',
      'Another exception or legal requirement',
    ])

    const recording = alone(<PurposeDialog row={purpose('recording_meetings')} onClose={() => {}} />)
    expect(
      tags(recording, 'input')
        .filter(input => input.get('type') === 'radio')
        .map(input => input.get('value')),
    ).toEqual(['planned', 'active', 'retired'])
    expect(optionsOf(recording, 'basis')).not.toEqual(expect.arrayContaining(['Consent']))

    const audit = alone(<PurposeDialog row={purpose('security_audit')} onClose={() => {}} />)
    expect(textsOf(audit, 'label')).toEqual(
      expect.arrayContaining(['Where the legitimate interests assessment is kept', 'How long it’s kept']),
    )
    expect(textsOf(audit, 'label')).not.toContain('Opt-out window (days)')
    // Eight providers to choose from, none of the AI layer's; every control's text at 16 px.
    expect(tags(audit, 'input').filter(input => input.get('type') === 'checkbox')).toHaveLength(8)
    for (const control of [...tags(audit, 'textarea'), ...tags(audit, 'select')]) {
      expect(control.get('class')).toMatch(/\btext-base\b/)
    }
    // A complete entry: Save acts, and nothing is listed as blocking it.
    expect(buttons(audit).find(button => button.name === 'Save')).toMatchObject({ held: false, type: 'submit' })
    expect(audit).not.toContain(DPO.beforeSaving)
  })

  it('DPP-05 PD-05 PD-12: the transfer dialog of a cleared provider offers Save and keep cleared as its submit and a plain Save beside it; of one not cleared, Save alone, with what is still needed before clearing', () => {
    const twilio = transfer('twilio')
    const cleared = alone(<TransferDialog row={twilio} today={TODAY} onClose={() => {}} />)
    expect(buttons(cleared).filter(button => button.name !== 'Close')).toEqual([
      { name: 'Cancel', held: false, type: 'button' },
      { name: 'Save', held: false, type: 'button' },
      { name: 'Save and keep cleared', held: false, type: 'submit' },
    ])
    expect(cleared).toContain(TRANSFERS_COPY.nothingNeeded)
    expect(textsOf(cleared, 'label')).toEqual(
      expect.arrayContaining(['Countries it processes the data in', 'Review by']),
    )
    // The countries' names show as the field's hint.
    expect(cleared).toContain('Ireland, United States')

    const apple = transfer('apple_push')
    const empty = alone(<TransferDialog row={apple} today={TODAY} onClose={() => {}} />)
    expect(
      buttons(empty)
        .filter(button => button.name !== 'Close')
        .map(button => [button.name, button.type]),
    ).toEqual([
      ['Cancel', 'button'],
      ['Save', 'submit'],
    ])
    expect(empty).toContain(TRANSFERS_COPY.stillNeeded)
    expect(textsOf(empty, 'li')).toEqual(expect.arrayContaining(['What it’s used for', 'A review date']))
    for (const markup of [cleared, empty]) {
      expect(readable(markup).filter(text => aiCopyIn(text) !== undefined)).toEqual([])
    }
  })

  it('DPP-05 T22 item 3: the confirmations say what clearing records and what withdrawing stops, for Twilio Verify every sign-in code', () => {
    const twilio = transfer('twilio')
    const withdraw = alone(<WithdrawDialog row={twilio} today={TODAY} onClose={() => {}} />)
    expect(textsOf(withdraw, 'h2')).toEqual(['Withdraw Twilio Verify’s clearance?'])
    expect(withdraw).toContain('Nobody can get a sign-in code')
    expect(buttons(withdraw).map(button => button.name)).toEqual(['Close', 'Cancel', 'Withdraw clearance'])

    const aws = transfer('aws')
    const clear = alone(<ClearDialog row={aws} today={TODAY} onClose={() => {}} />)
    expect(textsOf(clear, 'h2')).toEqual(['Clear Amazon Web Services for use?'])
    expect(textsOf(clear, 'p')).toEqual([TRANSFERS_COPY.confirmClear.body, PROVIDER_CHECKS.aws.checkedBy])
  })

  it('DPP-05 PD-20 PD-30: a refused read shows the PIN step (a current-password PIN field, paste allowed), a new sign-in, or the DPO-only line', () => {
    const pin = alone(<ReadRefusal refusal={{ kind: 'pin' }} retry={() => {}} />)
    const field = tags(pin, 'input').find(input => input.get('name') === 'pin')
    expect(field?.get('autoComplete')).toBe('current-password')
    expect(field?.get('inputMode')).toBe('numeric')
    expect(textsOf(pin, 'label')).toEqual(['Your PIN'])
    expect(readable(pin)).toEqual(expect.arrayContaining([REAUTH_METHOD_MESSAGES.pin.method]))
    expect(buttons(pin).find(button => button.name === 'Confirm')).toMatchObject({ type: 'submit', held: false })

    const signIn = alone(<ReadRefusal refusal={{ kind: 'sign_in', text: 'Sign in again.' }} retry={() => {}} />)
    expect(buttons(signIn).map(button => button.name)).toEqual(['Sign out'])

    const forbidden = alone(<ReadRefusal refusal={{ kind: 'forbidden', text: DPO.forbidden }} retry={() => {}} />)
    expect(textsOf(forbidden, 'h2')).toEqual(['This page is for the Data Protection Officer.'])
  })
})
