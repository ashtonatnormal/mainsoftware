// The sign-in steps' markup, rendered with react-dom/server in Node (T20, T21; D-03, AUTH-DESIGN
// §10.5, auth-research-web §8.1): each step's h1, form, fields and buttons, with their names and
// attributes. How the steps lay out and behave in a browser is the e2e suite's (sign-in.spec.ts,
// a11y.spec.ts, nfr02.spec.ts).
import { MESSAGES } from '@hearth/shared'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { aiCopyIn } from '@/strings/ai-copy.ts'
import { SIGN_IN } from '@/strings/sign-in.ts'
import type { SignInController } from './controller.ts'
import { lockText } from './PinStep.tsx'
import { SignInScreen, SignInStep, stepTitle } from './SignInScreen.tsx'
import { createSignInRefs } from './StepFrame.tsx'
import { initialState, RESEND_WAIT_MS, type SignInState, type Step } from './sign-in-model.ts'

const T0 = Date.UTC(2026, 9, 19, 9, 0, 0)
// Fictional numbers from the Tembusu seed (db/seed/tembusu.sql): Marcus, and Priya (a PIN role).
const MARCUS = '+6580000003'
const PRIYA = '+6580000002'

const controller: SignInController = {
  snapshot: () => initialState(),
  subscribe: () => () => {},
  input: () => {},
  showPin: () => {},
  submit: () => {},
  resend: () => {},
  startAgain: () => {},
  start: () => {},
  stop: () => {},
}

const html = (element: ReactElement) => renderToStaticMarkup(element)

function at(step: Step, more: Partial<SignInState> = {}): string {
  const state: SignInState = { ...initialState(), step, ...more }
  return html(<SignInStep state={state} controller={controller} refs={createSignInRefs()} />)
}

const CODE: Extract<Step, { kind: 'code' }> = {
  kind: 'code',
  e164: MARCUS,
  codeLength: 6,
  validMinutes: 5,
  resend: { at: T0 + RESEND_WAIT_MS, ready: false, why: 'wait', reason: SIGN_IN.resendWait },
}
const OK_PIN = { state: 'ok', triesBeforeLock: 5, triesBeforeAdminLock: 10 } as const

// Every step, as the person can reach it.
const STEPS: Record<Step['kind'], string> = {
  phone: at({ kind: 'phone' }),
  code: at(CODE),
  set_pin: at({ kind: 'set_pin', e164: PRIYA }),
  enter_pin: at({ kind: 'enter_pin', e164: PRIYA, pin: OK_PIN }),
  pin_locked: at({ kind: 'pin_locked', e164: PRIYA, lock: { kind: 'reset' } }),
  signed_in: at({ kind: 'signed_in' }),
}

// The attributes of every element with this tag, in order (React's casing: autoComplete, noValidate).
function tags(markup: string, tag: string): Map<string, string>[] {
  return [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(
    match => new Map([...(match[1] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(a => [a[1] ?? '', a[2] ?? ''])),
  )
}

function one(markup: string, tag: string): Map<string, string> {
  const found = tags(markup, tag)
  expect(found, `one <${tag}>`).toHaveLength(1)
  return found[0] ?? new Map()
}

const classesOf = (element: Map<string, string>) => (element.get('class') ?? '').split(/\s+/)
const visibleInputs = (markup: string) => tags(markup, 'input').filter(input => !input.has('hidden'))
// The text of the element with this id.
const textOfId = (markup: string, id: string) =>
  markup
    .match(new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>(.*?)</(?:p|span)>`))?.[1]
    ?.replace(/<[^>]+>/g, '')
// Every text node, for the AI-copy check.
const textsOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(text => text.trim())
    .filter(Boolean)

describe('T20 T21: the sign-in steps’ markup', () => {
  it('X16 X6: every step renders exactly one h1, focusable and marked as the screen’s title, and its document title', () => {
    for (const [kind, markup] of Object.entries(STEPS) as [Step['kind'], string][]) {
      const h1 = one(markup, 'h1')
      expect(h1.get('tabindex'), kind).toBe('-1')
      expect(h1.has('data-screen-title'), kind).toBe(true)
      expect(markup).toContain(`>${SIGN_IN.steps[kind]}</h1>`)
    }
    expect(stepTitle('phone')).toBe('Sign in')
    expect(stepTitle('code')).toBe('Enter your code')
  })

  it('SHL-27 KM-14: every step with input is one form, method post and novalidate, with exactly one submit button; the locked and signed-in views have none', () => {
    for (const kind of ['phone', 'code', 'set_pin', 'enter_pin'] as const) {
      const form = one(STEPS[kind], 'form')
      expect(form.get('method'), kind).toBe('post')
      expect(form.has('noValidate'), kind).toBe(true)
      expect(
        tags(STEPS[kind], 'button').filter(button => button.get('type') === 'submit'),
        kind,
      ).toHaveLength(1)
    }
    for (const kind of ['pin_locked', 'signed_in'] as const) expect(tags(STEPS[kind], 'form'), kind).toEqual([])
  })

  it('SI-01 X7 WCAG 1.3.5 SHL-28: the phone field is type tel, autocomplete tel, inputmode tel, 16 px and 44 px, with its label and hint', () => {
    const markup = STEPS.phone
    const input = one(markup, 'input')
    expect(
      Object.fromEntries(['type', 'name', 'autoComplete', 'inputMode', 'enterKeyHint'].map(k => [k, input.get(k)])),
    ).toEqual({ type: 'tel', name: 'phone', autoComplete: 'tel', inputMode: 'tel', enterKeyHint: 'send' })
    expect(classesOf(input)).toEqual(expect.arrayContaining(['text-base', 'min-h-11']))
    expect(one(markup, 'label').get('for')).toBe(input.get('id'))
    expect(markup).toMatch(new RegExp(`<label[^>]*>${SIGN_IN.phoneLabel}</label>`))
    const hint = input.get('aria-describedby') ?? ''
    expect(textOfId(markup, hint)).toBe(SIGN_IN.phoneHint)
    expect(markup).toContain(`>${SIGN_IN.sendCode}</button>`)
  })

  it('WCAG 3.3.1: an error sets aria-invalid and joins aria-describedby after the hint; a notice sits in the form, focusable, with no live role', () => {
    const markup = at(
      { kind: 'phone' },
      { error: { field: 'phone', text: MESSAGES.invalid_phone }, notice: MESSAGES.attempt_expired },
    )
    const input = one(markup, 'input')
    expect(input.get('aria-invalid')).toBe('true')
    const [hint, error] = (input.get('aria-describedby') ?? '').split(' ')
    expect(textOfId(markup, hint ?? '')).toBe(SIGN_IN.phoneHint)
    expect(textOfId(markup, error ?? '')).toBe(MESSAGES.invalid_phone)
    const notice = tags(markup, 'p').find(p => p.get('tabindex') === '-1')
    expect(notice).toBeDefined()
    expect(notice?.has('role')).toBe(false)
    expect(markup).toContain(MESSAGES.attempt_expired)
    expect(markup.indexOf(MESSAGES.attempt_expired)).toBeGreaterThan(markup.indexOf('<form'))
  })

  it('PRD-53 SI-07 SHL-07: the code field asks for one-time-code autofill and the number pad, with no maxlength or pattern; its words claim no send', () => {
    const markup = STEPS.code
    const input = one(markup, 'input')
    expect(input.get('autoComplete')).toBe('one-time-code')
    expect(input.get('inputMode')).toBe('numeric')
    expect(input.get('name')).toBe('one-time-code')
    expect(input.get('type')).toBe('text')
    expect(input.has('maxLength') || input.has('maxlength')).toBe(false)
    expect(input.has('pattern')).toBe(false)
    expect(classesOf(input)).toEqual(expect.arrayContaining(['text-2xl', 'tabular-nums', 'min-h-11']))
    expect(markup).toMatch(/<label[^>]*>6-digit code<\/label>/)
    expect(markup).toContain(
      'If +65 8000 0003 is registered on Hearth, we&#x27;ll text it a 6-digit code. It can take a minute to arrive, and it works for 5 minutes.',
    )
    // Send a new code waits with its reason; Use a different number is there.
    const buttons = tags(markup, 'button')
    const resend = buttons.find((_, index) => markup.split('<button')[index + 1]?.includes(SIGN_IN.resend))
    expect(resend?.get('aria-disabled')).toBe('true')
    const reasonId = (resend?.get('aria-describedby') ?? '').split(' ').at(-1) ?? ''
    expect(markup).toMatch(new RegExp(`id="${reasonId}"[^>]*>${SIGN_IN.resendWait}<`))
    expect(markup).toContain(`>${SIGN_IN.differentNumber}</button>`)
  })

  it('SM-02 AUTH-DESIGN §10.2: a dead code disables the field and Sign in, and Send a new code, ready, is described by the message', () => {
    const markup = at({ ...CODE, resend: { ...CODE.resend, ready: true }, dead: MESSAGES.code_expired })
    expect(one(markup, 'input').has('disabled')).toBe(true)
    const submit = tags(markup, 'button').find(button => button.get('type') === 'submit')
    expect(submit?.get('aria-disabled')).toBe('true')
    const resendIndex = markup.split('<button').findIndex(part => part.includes(`${SIGN_IN.resend}</button>`))
    const resend = tags(markup, 'button')[resendIndex - 1]
    expect(resend?.has('aria-disabled')).toBe(false)
    const described = (resend?.get('aria-describedby') ?? '').split(' ')
    expect(described.map(id => textOfId(markup, id))).toContain(MESSAGES.code_expired)
  })

  it('auth-research-web §3.1: while a call is out the submit is aria-disabled with the busy text and shows a hidden spinner', () => {
    const markup = at(CODE, {
      pending: { id: 2, kind: 'verify_code' },
      nextId: 3,
      values: { phone: MARCUS, code: '123456', pin: '', pin2: '' },
    })
    const submit = tags(markup, 'button').find(button => button.get('type') === 'submit')
    expect(submit?.get('aria-disabled')).toBe('true')
    expect(markup).toMatch(new RegExp(`>${SIGN_IN.busy.checking}<`))
    const spinner = markup.match(/<button[^>]*type="submit"[^>]*>(<svg[^>]*>)/)?.[1] ?? ''
    expect(spinner).toMatch(/class="[^"]*animate-spin/)
    expect(spinner).toContain('aria-hidden="true"')
  })

  it('WCAG 3.3.8 SHL-49 AQ-02: Choose a PIN has two password fields for a new password, numeric, with no maxlength and no paste handler, a hidden username, and Show PIN', () => {
    const markup = STEPS.set_pin
    const fields = visibleInputs(markup).filter(input => input.get('role') !== 'switch')
    expect(fields).toHaveLength(2)
    for (const field of fields) {
      expect(field.get('type')).toBe('password')
      expect(field.get('autoComplete')).toBe('new-password')
      expect(field.get('inputMode')).toBe('numeric')
      expect(field.has('maxLength') || field.has('maxlength')).toBe(false)
    }
    expect(fields.map(field => field.get('name'))).toEqual(['new-pin', 'confirm-pin'])
    expect(markup).not.toMatch(/onpaste/i)
    const username = tags(markup, 'input').find(input => input.get('autoComplete') === 'username')
    expect(username?.get('value')).toBe(PRIYA)
    expect(username?.has('hidden')).toBe(true)
    expect(username?.has('readOnly')).toBe(true)
    const toggle = tags(markup, 'input').find(input => input.get('role') === 'switch')
    expect(toggle?.get('aria-checked')).toBe('false')
    expect(markup).toContain(`>${SIGN_IN.newPinHint}<`)
    // Shown: the fields are text.
    const shown = at({ kind: 'set_pin', e164: PRIYA }, { showPin: true })
    expect(
      visibleInputs(shown)
        .filter(input => input.get('role') !== 'switch')
        .map(input => input.get('type')),
    ).toEqual(['text', 'text'])
  })

  it('T14 item 9 ACC-06: Enter your PIN is one current-password field; after earlier failures its hint says the tries left; Forgotten your PIN? opens in a 44 px summary', () => {
    const markup = STEPS.enter_pin
    const field = visibleInputs(markup).filter(input => input.get('role') !== 'switch')
    expect(field).toHaveLength(1)
    expect(field[0]?.get('autoComplete')).toBe('current-password')
    expect(field[0]?.get('type')).toBe('password')
    expect(field[0]?.has('aria-describedby')).toBe(false)
    expect(markup).toMatch(/<summary[^>]*class="[^"]*min-h-11[^"]*"[^>]*>Forgotten your PIN\?<\/summary>/)
    const failed = at({
      kind: 'enter_pin',
      e164: PRIYA,
      pin: { state: 'ok', triesBeforeLock: 2, triesBeforeAdminLock: 7 },
    })
    expect(failed).toContain('>2 tries left before a 15-minute lock.<')
    // Once an error says it, the hint doesn't say it again.
    const erred = at(
      { kind: 'enter_pin', e164: PRIYA, pin: { state: 'ok', triesBeforeLock: 2, triesBeforeAdminLock: 7 } },
      { error: { field: 'pin', text: `${MESSAGES.pin_wrong} 2 tries left before a 15-minute lock.` } },
    )
    expect(erred.match(/tries left before/g)).toHaveLength(1)
  })

  it('SM-04 ACC-06: the locked view has no form, says who can end the lock or when it ends, and offers only Start again', () => {
    const reset = STEPS.pin_locked
    expect(tags(reset, 'input')).toEqual([])
    expect(tags(reset, 'button')).toHaveLength(1)
    expect(reset).toContain(`>${SIGN_IN.startAgain}</button>`)
    expect(reset).toContain(SIGN_IN.lockedReset.replace("'", '&#x27;'))
    const until = Date.UTC(2026, 9, 19, 7, 45)
    expect(lockText({ kind: 'timed', until }, 'Asia/Singapore')).toEqual({
      body: SIGN_IN.lockedTimed,
      after: "The lock ends at 3:45 pm. You'll need a new code after then.",
    })
    expect(lockText({ kind: 'timed' }, 'Asia/Singapore').after).toBe(SIGN_IN.lockEndsUnknown)
  })

  it('R-35 decision 8 OD-01 D46: no step shows AI copy or a passkey', () => {
    for (const [kind, markup] of Object.entries(STEPS)) {
      const found = textsOf(markup).filter(text => aiCopyIn(text) !== undefined)
      expect(found, kind).toEqual([])
      expect(markup, kind).not.toMatch(/passkey/i)
    }
  })

  it('SHM-09 D-01: the screen opens on the phone step, in its own main, with no left-reason line when none was kept', () => {
    const markup = html(<SignInScreen />)
    expect(tags(markup, 'main')).toHaveLength(1)
    expect(markup).toContain(`>${SIGN_IN.heading}</h1>`)
    expect(markup).not.toContain('role="status"')
    expect(at({ kind: 'phone' }, { left: SIGN_IN.signedOut })).toMatch(
      /<p role="status"[^>]*>You&#x27;ve been signed out\.<\/p>/,
    )
  })
})
