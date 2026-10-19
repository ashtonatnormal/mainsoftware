import { describe, expect, it } from 'vitest'
import { createDialogModel, type Focusable, type NativeDialog } from './dialog-model.ts'

// A stand-in for the browser. close() queues the element's `close` event as a task, as browsers do,
// so a case can deliver it after the effect has run again. Closing leaves focus where it was (the
// browser's own hand-back varies), so what a case sees is the model's.
class FakePage {
  focused: FakeElement | null = null
  private readonly tasks: (() => void)[] = []
  queue(task: () => void) {
    this.tasks.push(task)
  }
  // Runs the queued tasks, as the event loop does once the effect's run has returned.
  flush() {
    for (const task of this.tasks.splice(0)) task()
  }
}

class FakeElement implements Focusable {
  isConnected = true
  readonly name: string
  private readonly page: FakePage
  constructor(name: string, page: FakePage) {
    this.name = name
    this.page = page
  }
  focus() {
    this.page.focused = this
  }
}

class FakeDialog implements NativeDialog<FakeElement> {
  open = false
  onclose: (() => void) | null = null
  readonly closeButton: FakeElement
  private readonly page: FakePage
  constructor(page: FakePage) {
    this.page = page
    this.closeButton = new FakeElement('close button', page)
  }
  showModal() {
    if (this.open) throw new Error('InvalidStateError: already open')
    this.open = true
    this.closeButton.focus()
  }
  close() {
    if (!this.open) return
    this.open = false
    this.page.queue(() => this.onclose?.())
  }
  contains(other: FakeElement | null) {
    return other === this.closeButton
  }
}

// Dialog.tsx's wiring of a model, with a log of each close passed on to the caller.
function setUp() {
  const page = new FakePage()
  const model = createDialogModel(() => page.focused)
  const reported: string[] = []
  const element = () => {
    const dialog = new FakeDialog(page)
    dialog.onclose = () => {
      if (model.closedByBrowser(dialog)) reported.push('onClose')
    }
    return dialog
  }
  const opener = new FakeElement('opener', page)
  return { page, model, reported, element, opener }
}

describe('T21: the dialog model (dialog-model.ts)', () => {
  it('DG-01 K-45 SHL-45: the effect run again while open (StrictMode, Fast Refresh) keeps it open, and the close its cleanup queued is not passed on', () => {
    const { page, model, reported, element, opener } = setUp()
    const dialog = element()
    opener.focus()
    const first = model.show(dialog)
    first()
    const second = model.show(dialog)
    page.flush()
    expect(dialog.open).toBe(true)
    expect(reported).toEqual([])
    expect(page.focused).toBe(dialog.closeButton)
    second()
    model.end()
    page.flush()
    expect(page.focused).toBe(opener)
    expect(reported).toEqual([])
  })

  it('DG-02 K-45: an <Activity> hidden shuts it without telling the caller; shown again, it opens with the first opener kept', () => {
    const { page, model, reported, element, opener } = setUp()
    const dialog = element()
    opener.focus()
    const shown = model.show(dialog)
    shown()
    page.flush()
    // Hidden: shut, so the page isn't left inert behind a modal nobody sees, and focus is back out.
    expect(dialog.open).toBe(false)
    expect(page.focused).toBe(opener)
    expect(reported).toEqual([])
    // Shown again with focus somewhere else: the opening's opener is still the one it had.
    new FakeElement('elsewhere', page).focus()
    const again = model.show(dialog)
    expect(dialog.open).toBe(true)
    again()
    model.end()
    page.flush()
    expect(page.focused).toBe(opener)
    expect(reported).toEqual([])
  })

  it('DG-03 K-45 SHL-45: a close the browser makes itself (a cancel it won’t let be refused, Android’s back) is passed on once; an earlier opening’s element never is', () => {
    const { page, model, reported, element, opener } = setUp()
    const earlier = element()
    opener.focus()
    const closeEarlier = model.show(earlier)
    closeEarlier()
    model.end()
    const dialog = element()
    const cleanup = model.show(dialog)
    // The earlier element's queued close arrives while the new one is open.
    page.flush()
    expect(reported).toEqual([])
    expect(model.closedByBrowser(earlier)).toBe(false)
    // The browser shuts the open one: the caller is told, and sets `open` false.
    dialog.close()
    page.flush()
    expect(reported).toEqual(['onClose'])
    cleanup()
    model.end()
    page.flush()
    expect(reported).toEqual(['onClose'])
    expect(page.focused).toBe(opener)
  })

  it('DG-04 DRV-48: focus goes back to the opener unless closing put it somewhere on purpose; an opener that has left the page is not focused; each opening reads its own', () => {
    const { page, model, element, opener } = setUp()
    opener.focus()
    const first = model.show(element())
    // Closing moved focus to a field on purpose: it stays there.
    const field = new FakeElement('field', page)
    field.focus()
    first()
    model.end()
    expect(page.focused).toBe(field)

    // The next opening reads its own opener, not the last one's.
    const other = new FakeElement('other opener', page)
    other.focus()
    const second = model.show(element())
    second()
    model.end()
    expect(page.focused).toBe(other)

    // An opener that has left the page (a menu item) gets nothing; focus is left as the close left it.
    other.focus()
    const gone = element()
    const third = model.show(gone)
    other.isConnected = false
    third()
    model.end()
    expect(page.focused).toBe(gone.closeButton)

    // Opened with nothing focused: there is no opener, and a later run of the same opening doesn't
    // take the element focused by then for one.
    page.focused = null
    const dialog = element()
    const fourth = model.show(dialog)
    fourth()
    opener.focus()
    const fifth = model.show(dialog)
    fifth()
    model.end()
    expect(page.focused).toBe(dialog.closeButton)

    // A first run that finds focus already inside the element takes no opener from inside it: when
    // focus is lost by the close, nothing in the dialog is focused again.
    opener.focus()
    const stillOpen = element()
    stillOpen.showModal()
    const sixth = model.show(stillOpen)
    page.focused = null
    sixth()
    model.end()
    expect(page.focused).toBeNull()
  })
})
