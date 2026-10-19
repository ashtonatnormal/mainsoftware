// The kit's markup, rendered with react-dom/server in Node: no DOM, no jsdom, no Testing Library
// (D-03). What a component renders (roles, names, ids, attributes, classes) is checked here; what
// it does once mounted (focus, the native dialog, menu keys in a browser) is the e2e suite's.
import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router'
import { Bell, Inbox, LogOut, Settings } from 'lucide-react'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { usePrefersReducedMotion } from '@/lib/media.ts'
import { createQueryClient } from '@/session/query-client.ts'
import { SearchBar } from '@/shell/SearchBar.tsx'
import type { SignInController } from '@/sign-in/controller.ts'
import { SignInStep } from '@/sign-in/SignInScreen.tsx'
import { createSignInRefs } from '@/sign-in/StepFrame.tsx'
import { initialState, type Step } from '@/sign-in/sign-in-model.ts'
import { Avatar, initialsOf } from './Avatar.tsx'
import { AVATAR_BG, avatarHue } from './avatar-hue.ts'
import { Button, IconButton } from './Button.tsx'
import { CodeField } from './CodeField.tsx'
import { Dialog } from './Dialog.tsx'
import { EmptyState } from './EmptyState.tsx'
import { CONTROL_CLASS, DIGITS_CONTROL_CLASS, Field } from './Field.tsx'
import { Menu } from './Menu.tsx'
import { PinField, PinUsername, ShowPin } from './PinField.tsx'
import { ScreenHeader } from './ScreenHeader.tsx'
import { Segmented } from './Segmented.tsx'
import { Select } from './Select.tsx'
import { SkipLink } from './SkipLink.tsx'
import { Switch } from './Switch.tsx'

const html = (element: ReactElement) => renderToStaticMarkup(element)

// Under a QueryClient with no flags answer, as a component holding an AI slot renders before the
// first one (every slot off).
const withQuery = (element: ReactElement) =>
  html(<QueryClientProvider client={createQueryClient(() => {})}>{element}</QueryClientProvider>)

// The attributes of every element with this tag, in order, so a case reads what one element has.
function tags(markup: string, tag: string): Map<string, string>[] {
  return [...markup.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map(
    match => new Map([...(match[1] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)].map(a => [a[1] ?? '', a[2] ?? ''])),
  )
}

const one = (markup: string, tag: string) => {
  const found = tags(markup, tag)
  expect(found, `one <${tag}> in ${markup}`).toHaveLength(1)
  return found[0] ?? new Map<string, string>()
}

const classesOf = (element: Map<string, string>) => (element.get('class') ?? '').split(/\s+/)

// The markup of an element with this id, by its own tag, up to its closing tag (no nesting needed).
const textOfId = (markup: string, id: string) =>
  markup.match(new RegExp(`id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([^<]*)<`))?.[1]

const MIN_44 = ['min-h-11', 'min-w-11']

describe('T21: the kit’s markup', () => {
  it('KM-01 SHL-47: Button defaults to type=button; submit is kept', () => {
    expect(one(html(<Button>Save</Button>), 'button').get('type')).toBe('button')
    expect(one(html(<Button type="submit">Send code</Button>), 'button').get('type')).toBe('submit')
    expect(one(html(<IconButton label="Close" icon={<Bell />} />), 'button').get('type')).toBe('button')
  })

  it('KM-02 X7: Button, IconButton, Field controls, Switch rows and Segmented labels carry the 44 px minimum classes', () => {
    for (const size of ['md', 'lg'] as const) {
      const button = one(html(<Button size={size}>Go</Button>), 'button')
      for (const name of MIN_44) expect(classesOf(button), size).toContain(name)
    }
    expect(classesOf(one(html(<IconButton label="Close" icon={<Bell />} />), 'button'))).toContain('size-11')
    expect(CONTROL_CLASS.split(' ')).toEqual(expect.arrayContaining(['min-h-11', 'text-base', 'border-line-strong']))
    const select = one(
      html(<Select label="Zone" options={[{ value: 'sg', label: 'Singapore' }]} value="sg" onChange={() => {}} />),
      'select',
    )
    expect(classesOf(select)).toEqual(expect.arrayContaining(['min-h-11', 'text-base']))
    const switchRow = tags(html(<Switch label="Sounds" checked={false} onChange={() => {}} />), 'div')[0]
    expect(classesOf(switchRow ?? new Map())).toContain('min-h-11')
    const segments = tags(
      html(
        <Segmented
          label="Show"
          value="all"
          options={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: 'Mine' },
          ]}
          onChange={() => {}}
        />,
      ),
      'label',
    )
    expect(segments).toHaveLength(2)
    for (const label of segments) for (const name of MIN_44) expect(classesOf(label)).toContain(name)
    // The Skip link becomes a 44 px pill when focused. Its ring is the base accent ring, which
    // sits outside the pill on the page ground, so the link sets no outline colour of its own.
    const skip = classesOf(one(html(<SkipLink />), 'a'))
    expect(skip).toContain('focus:min-h-11')
    expect(skip.filter(name => /outline/.test(name))).toEqual([])
  })

  it('KM-03 SHL-47: IconButton is named by label, icon hidden, aria-pressed only when given', () => {
    const plain = html(<IconButton label="Notifications" icon={<Bell />} />)
    const button = one(plain, 'button')
    expect(button.get('aria-label')).toBe('Notifications')
    expect(button.has('aria-pressed')).toBe(false)
    expect(button.has('title')).toBe(false)
    expect(plain).toMatch(/<span aria-hidden="true"[^>]*><svg/)
    expect(one(html(<IconButton label="Mute" icon={<Bell />} pressed />), 'button').get('aria-pressed')).toBe('true')
    expect(one(html(<IconButton label="Mute" icon={<Bell />} pressed={false} />), 'button').get('aria-pressed')).toBe(
      'false',
    )
  })

  it('KM-04 SHL-41 QA-01: Avatar is role=img named, or aria-hidden when decorative, with the AVATAR_BG class for its id and text-avatar-fg', () => {
    const id = '0b6f6c1e-5d1a-4c55-9e43-2f5d5d0b2a10'
    const avatar = tags(html(<Avatar personId={id} name="Wei Ling Tan" />), 'span')[0] ?? new Map<string, string>()
    expect(avatar.get('role')).toBe('img')
    expect(avatar.get('aria-label')).toBe('Wei Ling Tan')
    expect(classesOf(avatar)).toEqual(expect.arrayContaining([AVATAR_BG[avatarHue(id)], 'text-avatar-fg']))
    expect(html(<Avatar personId={id} name="Wei Ling Tan" />)).toContain('>WL<')
    const decorative = tags(html(<Avatar personId={id} name="Wei Ling Tan" decorative />), 'span')[0]
    expect(decorative?.get('aria-hidden')).toBe('true')
    expect(decorative?.has('role')).toBe(false)
    expect(decorative?.has('aria-label')).toBe(false)
    expect([initialsOf('marcus'), initialsOf('  Priya  Raman Nair '), initialsOf('')]).toEqual(['M', 'PR', ''])
  })

  it('KM-05 X16 SHL-43: ScreenHeader renders exactly one h1 with tabindex -1, sr-only on request', () => {
    const shown = one(
      html(<ScreenHeader title="Chats" actions={<IconButton label="Account" icon={<Bell />} />} />),
      'h1',
    )
    expect(shown.get('tabindex')).toBe('-1')
    expect(shown.has('data-screen-title')).toBe(true)
    expect(classesOf(shown)).not.toContain('sr-only')
    const hidden = one(html(<ScreenHeader title="Conversation" srOnlyTitle />), 'h1')
    expect(classesOf(hidden)).toContain('sr-only')
    expect(hidden.get('tabindex')).toBe('-1')

    // Back needs the router; it is a 44 px IconButton named by its label.
    const router = createRouter({
      routeTree: createRootRoute(),
      history: createMemoryHistory({ initialEntries: ['/chats'] }),
    })
    const withBack = html(
      <RouterContextProvider router={router}>
        <ScreenHeader title="Drive" back={{ label: 'Back to More', fallback: '/more' }} />
      </RouterContextProvider>,
    )
    one(withBack, 'h1')
    const back = one(withBack, 'button')
    expect(back.get('aria-label')).toBe('Back to More')
    expect(classesOf(back)).toContain('size-11')
  })

  it('KM-06 X7 SHL-28 WCAG 3.3.1: Field wires label, hint and error (aria-describedby, aria-invalid)', () => {
    const markup = html(
      <Field label="Mobile number" hint="Start with +" error="Enter a mobile number.">
        {control => <input type="tel" className={CONTROL_CLASS} {...control} />}
      </Field>,
    )
    const label = one(markup, 'label')
    const input = one(markup, 'input')
    expect(label.get('for')).toBe(input.get('id'))
    const [hintId, errorId] = (input.get('aria-describedby') ?? '').split(' ')
    expect(textOfId(markup, hintId ?? '')).toBe('Start with +')
    expect(markup).toContain(`id="${errorId}"`)
    expect(markup).toContain('Enter a mobile number.')
    expect(input.get('aria-invalid')).toBe('true')
    // The error is text with an icon in the danger ink, not colour alone.
    expect(markup).toMatch(new RegExp(`id="${errorId}" class="[^"]*text-rec[^"]*"><svg[^>]*aria-hidden="true"`))

    const calm = one(
      html(<Field label="Name">{control => <input className={CONTROL_CLASS} {...control} />}</Field>),
      'input',
    )
    expect(calm.has('aria-describedby')).toBe(false)
    expect(calm.has('aria-invalid')).toBe(false)
  })

  it('KM-07 X10 SHL-40: Segmented is a fieldset with a legend and named native radios, the value checked', () => {
    const markup = html(
      <Segmented
        label="Show"
        value="mine"
        options={[
          { value: 'all', label: 'All' },
          { value: 'mine', label: 'Mine' },
        ]}
        onChange={() => {}}
      />,
    )
    one(markup, 'fieldset')
    expect(markup).toMatch(/<legend class="sr-only">Show<\/legend>/)
    const radios = tags(markup, 'input')
    expect(radios.map(radio => radio.get('type'))).toEqual(['radio', 'radio'])
    expect(new Set(radios.map(radio => radio.get('name'))).size).toBe(1)
    expect(radios.map(radio => radio.has('checked'))).toEqual([false, true])
    expect(markup).not.toContain('role="tab')
    // Each radio sits in its label, so the label names it; the chosen one also carries a check.
    expect(markup).toMatch(/<label[^>]*><input[^>]*value="all"[^>]*\/><span>All<\/span><\/label>/)
    expect(markup).toMatch(/<label[^>]*><input[^>]*value="mine"[^>]*\/><svg[^>]*aria-hidden="true"/)
  })

  it('KM-08 SHL-37: Switch is a checkbox with role switch, aria-checked matching checked, and a line-strong track; the on track and the knob carry the classes forced colours draw (TK-12)', () => {
    for (const checked of [false, true]) {
      const markup = html(
        <Switch label="Sounds" description="When a message arrives" checked={checked} onChange={() => {}} />,
      )
      const input = one(markup, 'input')
      expect(input.get('type')).toBe('checkbox')
      expect(input.get('role')).toBe('switch')
      expect(input.get('aria-checked')).toBe(String(checked))
      expect(input.has('checked')).toBe(checked)
      expect(textOfId(markup, input.get('aria-labelledby') ?? '')).toBe('Sounds')
      expect(textOfId(markup, input.get('aria-describedby') ?? '')).toBe('When a message arrives')
      expect(markup).toMatch(
        checked ? /switch-track[^"]*border-accent bg-accent/ : /switch-track[^"]*border-line-strong/,
      )
      const [track, knob] = tags(markup, 'span').filter(span =>
        /\bswitch-(?:track|knob)\b/.test(span.get('class') ?? ''),
      )
      expect(classesOf(track ?? new Map())).toContain('switch-track')
      expect(classesOf(track ?? new Map()).includes('switch-on')).toBe(checked)
      expect(classesOf(knob ?? new Map())).toContain('switch-knob')
    }
  })

  it('KM-09 X10: the Menu trigger has aria-haspopup=menu, aria-expanded=false and aria-controls; an open Menu is a div role=menu of button role=menuitem', () => {
    const markup = html(
      <Menu
        label="Account"
        items={[
          {
            id: 'settings',
            label: 'Settings',
            icon: Settings,
            onSelect: () => {},
            disabledReason: 'Settings come later.',
          },
          { id: 'sign-out', label: 'Sign out', icon: LogOut, onSelect: () => {} },
        ]}
        trigger={props => <IconButton {...props} label="Account, Marcus" icon={<Bell />} />}
      />,
    )
    const [trigger, ...items] = tags(markup, 'button')
    expect(trigger?.get('aria-haspopup')).toBe('menu')
    expect(trigger?.get('aria-expanded')).toBe('false')
    const popup = tags(markup, 'div').find(div => div.get('role') === 'menu')
    expect(popup?.get('id')).toBe(trigger?.get('aria-controls'))
    expect(popup?.get('aria-label')).toBe('Account')
    // Closed, the popup is hidden; its children are menu items and nothing else.
    expect(popup?.has('hidden')).toBe(true)
    expect(items.map(item => [item.get('type'), item.get('role')])).toEqual([
      ['button', 'menuitem'],
      ['button', 'menuitem'],
    ])
    expect(markup).toMatch(/role="menu"[^>]*>(?:<button[^>]*role="menuitem"[^>]*>.*?<\/button>)+<\/div>/)
    // Roving tabIndex: nothing is in the tab order until the menu opens on an item.
    expect(items.map(item => item.get('tabindex'))).toEqual(['-1', '-1'])
    // The disabled item keeps focus and says why; the other has no description.
    expect(items[0]?.get('aria-disabled')).toBe('true')
    expect(textOfId(markup, items[0]?.get('aria-describedby') ?? '')).toBe('Settings come later.')
    expect(items[1]?.has('aria-disabled')).toBe(false)
    expect(items.every(item => !item.has('disabled'))).toBe(true)
  })

  it('KM-10 SHL-25: Dialog renders a dialog element labelled by its title', () => {
    expect(
      html(
        <Dialog open={false} onClose={() => {}} title="Devices">
          Nothing
        </Dialog>,
      ),
    ).toBe('')
    const markup = html(
      <Dialog open onClose={() => {}} title="Devices" footer={<Button>Done</Button>}>
        <p>Your devices</p>
      </Dialog>,
    )
    const dialog = one(markup, 'dialog')
    const titleId = dialog.get('aria-labelledby') ?? ''
    expect(markup).toMatch(new RegExp(`<h2 id="${titleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>Devices</h2>`))
    // Not open in markup: showModal() opens it once mounted, so the browser makes it modal.
    expect(dialog.has('open')).toBe(false)
    const close = tags(markup, 'button').find(button => button.get('aria-label') === 'Close')
    expect(classesOf(close ?? new Map())).toContain('size-11')
  })

  it('KM-11 X9: disabledReason renders aria-disabled and a described reason, never disabled; an inert button takes muted ink on the control ground and no hover or press class', () => {
    for (const markup of [
      html(
        <Button disabled disabledReason="You can get a new code 30 seconds after the last one.">
          Send a new code
        </Button>,
      ),
      html(
        <IconButton
          label="Delete"
          icon={<Bell />}
          disabledReason="You can get a new code 30 seconds after the last one."
        />,
      ),
    ]) {
      const button = one(markup, 'button')
      expect(button.get('aria-disabled')).toBe('true')
      expect(button.has('disabled')).toBe(false)
      expect(textOfId(markup, button.get('aria-describedby') ?? '')).toBe(
        'You can get a new code 30 seconds after the last one.',
      )
    }
    // Held back by a reason or disabled, a button of any variant paints the same inert pair, and
    // nothing under the pointer or a press changes it.
    for (const markup of [
      html(
        <Button variant="primary" disabledReason="Wait.">
          Send
        </Button>,
      ),
      html(
        <Button variant="danger" disabled>
          Leave
        </Button>,
      ),
      html(<IconButton label="Mute" icon={<Bell />} pressed variant="primary" disabledReason="Wait." />),
    ]) {
      const classes = classesOf(one(markup, 'button'))
      expect(classes).toEqual(expect.arrayContaining(['bg-surface-2', 'text-muted']))
      expect(classes.filter(name => /^(?:hover|active):|^bg-(?:accent|rec)|brightness/.test(name))).toEqual([])
    }
    const live = classesOf(one(html(<Button variant="primary">Send</Button>), 'button'))
    expect(live).toEqual(expect.arrayContaining(['bg-accent', 'hover:bg-accent-ink']))

    const free = one(html(<Button aria-describedby="other">Send</Button>), 'button')
    expect(free.get('aria-describedby')).toBe('other')
    expect(free.has('aria-disabled')).toBe(false)
    // A reason adds to a description already given, after it.
    const both = one(
      html(
        <Button aria-describedby="other" disabledReason="Wait.">
          Send
        </Button>,
      ),
      'button',
    )
    expect((both.get('aria-describedby') ?? '').split(' ')[0]).toBe('other')
    // A Switch held back says why the same way.
    const held = one(html(<Switch label="Sounds" checked onChange={() => {}} disabledReason="Not yet." />), 'input')
    expect(held.get('aria-disabled')).toBe('true')
    expect(held.has('disabled')).toBe(false)
  })

  it('KM-12: EmptyState’s title is an h2', () => {
    const markup = html(<EmptyState icon={Inbox} title="No chats yet" body="Chats you’re in show here." />)
    expect(markup).toMatch(/<h2[^>]*>No chats yet<\/h2>/)
    expect(markup).not.toContain('<h1')
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/)
  })

  it("KM-13 R-34 OD-04 decision 8: SearchBar is a search form whose field is type search, 16 px and named 'Search' by its label, with a Search button and no Ask", () => {
    const markup = withQuery(<SearchBar onSearch={() => {}} />)
    const form = one(markup, 'form')
    expect(form.get('role')).toBe('search')
    const input = one(markup, 'input')
    expect(input.get('type')).toBe('search')
    // react-dom/server keeps React's casing (enterKeyHint, noValidate); HTML reads attributes in any case.
    expect(input.get('enterKeyHint')).toBe('search')
    expect(classesOf(input)).toEqual(expect.arrayContaining(['text-base', 'min-h-11']))
    const label = one(markup, 'label')
    expect(label.get('for')).toBe(input.get('id'))
    expect(markup).toMatch(/<label[^>]*>Search<\/label>/)
    const button = one(markup, 'button')
    expect(button.get('type')).toBe('submit')
    expect(markup).toMatch(/<button[^>]*>.*Search<\/button>/s)
    expect(markup).not.toMatch(/\bask\b|search &amp; ask/i)
  })

  it('KM-14 SHL-27 WCAG 3.3.1: every form rendered carries novalidate and method post: SearchBar, and the sign-in steps (phone, code, PIN set and enter)', () => {
    const noop = () => {}
    const controller: SignInController = {
      snapshot: initialState,
      subscribe: () => noop,
      input: noop,
      showPin: noop,
      submit: noop,
      resend: noop,
      startAgain: noop,
      start: noop,
      stop: noop,
    }
    const step = (value: Step) =>
      html(<SignInStep state={{ ...initialState(), step: value }} controller={controller} refs={createSignInRefs()} />)
    const pin = { state: 'ok', triesBeforeLock: 5, triesBeforeAdminLock: 10 } as const
    const rendered = [
      withQuery(<SearchBar onSearch={() => {}} />),
      step({ kind: 'phone' }),
      step({
        kind: 'code',
        e164: '+6580000003',
        codeLength: 6,
        validMinutes: 5,
        resend: { at: 0, ready: true, why: 'wait', reason: '' },
      }),
      step({ kind: 'set_pin', e164: '+6580000002' }),
      step({ kind: 'enter_pin', e164: '+6580000002', pin }),
    ]
    for (const markup of rendered) {
      const forms = tags(markup, 'form')
      expect(forms).toHaveLength(1)
      for (const form of forms) {
        expect(form.has('noValidate')).toBe(true)
        expect(form.get('method')).toBe('post')
      }
    }
  })

  it('KM-15 AUTH-DESIGN §10.1 §10.4 PRD-53 X7: CodeField is one labelled text input for a one-time code on the number pad, 24 px figures and 44 px tall, with no maxlength or pattern', () => {
    const markup = html(<CodeField label="6-digit code" length={6} value="123" onChange={() => {}} />)
    const input = one(markup, 'input')
    expect(input.get('type')).toBe('text')
    expect(input.get('autoComplete')).toBe('one-time-code')
    expect(input.get('inputMode')).toBe('numeric')
    expect(input.get('spellCheck')).toBe('false')
    expect(input.get('value')).toBe('123')
    for (const absent of ['maxLength', 'maxlength', 'pattern']) expect(input.has(absent), absent).toBe(false)
    expect(one(markup, 'label').get('for')).toBe(input.get('id'))
    expect(DIGITS_CONTROL_CLASS.split(' ')).toEqual(expect.arrayContaining(['min-h-11', 'text-2xl', 'tabular-nums']))
    expect(DIGITS_CONTROL_CLASS.split(' ')).not.toContain('text-base')
    expect(classesOf(input)).toEqual(DIGITS_CONTROL_CLASS.split(' '))
    const disabled = one(html(<CodeField label="Code" length={6} value="" onChange={() => {}} disabled />), 'input')
    expect(disabled.has('disabled')).toBe(true)
  })

  it('KM-16 WCAG 3.3.8 SHL-49 AUTH-DESIGN §10.4: PinField is a numeric password field with the autocomplete it is given and no maxlength; ShowPin is a Switch; PinUsername is hidden', () => {
    const field = (shown: boolean) =>
      html(
        <PinField
          label="PIN"
          value=""
          onChange={() => {}}
          autoComplete="current-password"
          name="pin"
          shown={shown}
          error="That PIN isn't right."
        />,
      )
    const input = one(field(false), 'input')
    expect(input.get('type')).toBe('password')
    expect(input.get('autoComplete')).toBe('current-password')
    expect(input.get('inputMode')).toBe('numeric')
    expect(input.get('aria-invalid')).toBe('true')
    for (const absent of ['maxLength', 'maxlength']) expect(input.has(absent), absent).toBe(false)
    // No handler blocks paste or copy: markup never shows one, so WS-13 reads the source
    // (scripts/guards/web-source.test.ts).
    expect(one(field(true), 'input').get('type')).toBe('text')
    const toggle = one(html(<ShowPin shown onChange={() => {}} />), 'input')
    expect(toggle.get('role')).toBe('switch')
    expect(toggle.get('aria-checked')).toBe('true')
    const username = one(html(<PinUsername number="+6580000002" />), 'input')
    expect(Object.fromEntries(username)).toMatchObject({
      type: 'text',
      autoComplete: 'username',
      value: '+6580000002',
      hidden: '',
      readOnly: '',
    })
  })

  it('SHL-16: the media-query hooks read false where there is no window, so markup renders', () => {
    function Motion() {
      return <p>{usePrefersReducedMotion() ? 'reduced' : 'full'}</p>
    }
    expect(html(<Motion />)).toBe('<p>full</p>')
  })
})
