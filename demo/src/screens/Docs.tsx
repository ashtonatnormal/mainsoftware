// Docs (DOC-01..11, J6, D16, D19): a Google Docs-style editor that lives in the
// Drive. Editors switch between Editing and Viewing; every block is editable,
// with keyboard flow, a "/" menu and Markdown shortcuts, and text within a line
// can be bold, italic, underlined or struck through. Saves are debounced to
// the store and each visit you change adds a "You edited" version. Viewing keeps
// anchored comments, live presence, version history with restore, and AI help
// that only suggests. Without a docId, the docs route shows the Drive.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ALargeSmall, ArrowLeft, Bold, Check, ClipboardCopy, CloudCheck, CloudUpload, Copy, Ellipsis, Eye, FileQuestion, History, Info, Italic, Lock, MessageSquarePlus, MessageSquareText, Pencil, Redo2, Sparkles, Star, Strikethrough, Trash2, Underline, Undo2 } from 'lucide-react'
import type { Doc, Folder, Route } from '../types'
import { newId, useStore, type State } from '../store'
import { ME, personById } from '../data/people'
import { docs as seedDocs } from '../data/work'
import { myDocs } from '../data/drive'
import { canEdit as canEditItem, folderPath, isTrashed, teamFolderOf } from '../drive'
import { AvatarStack, Button, cx, EmptyState, IconButton, Segmented, Sheet } from '../ui'
import { ShareDialog } from '../ui/share'
import { KindIcon } from './drive/art'
import { FileCrumbs, ShareButton } from './drive/header'
import DriveScreen from './Drive'
import Editor, { applyType, typeIcons } from './docs/Editor'
import { BlankStart, useAssist, type AssistKind } from './docs/Assist'
import { Comments, DetailsSheet, PermissionsSheet, stamp, Versions } from './docs/Panels'
import { Menu, useKeyboardInset, useMedia, type MenuItem } from './docs/ui'
import { blockOrder, byName, canComment, cap, editorIds, fullName, nameList, openLine, permissionLine, toBlocks, toMarkdown, typeLabels, UNTITLED, type BlockType } from './docs/model'
import { useDocDraft, type DocDraft } from './docs/useDocDraft'
import { useInline } from './docs/useInline'
import { markLabels, MARKS, type Mark } from './docs/runs'

const markIcons: Record<Mark, typeof Bold> = { b: Bold, i: Italic, u: Underline, s: Strikethrough }
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const markKeys: Record<Mark, string> = isMac ? { b: '⌘B', i: '⌘I', u: '⌘U', s: '⌘⇧X' } : { b: 'Ctrl+B', i: 'Ctrl+I', u: 'Ctrl+U', s: 'Ctrl+Shift+X' }

export default function DocsScreen() {
  const { state } = useStore()
  const docId = state.route.name === 'docs' ? state.route.docId : undefined
  if (!docId) return <DriveScreen />
  const doc = state.docs.find(d => d.id === docId)
  return doc ? <DocView key={doc.id} doc={doc} /> : <MissingDoc />
}

function MissingDoc() {
  const { state, back, navigate } = useStore()
  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-14 items-center gap-2 border-b border-line bg-surface px-2 py-2 sm:px-4">
        <IconButton label="Back" onClick={() => (state.history.length ? back() : navigate({ name: 'drive' }))}><ArrowLeft size={20} /></IconButton>
        <h1 className="font-display text-lg font-semibold">Doc not found</h1>
      </header>
      <EmptyState icon={<FileQuestion size={28} />} title="This doc isn’t here any more" body="It may have been deleted from the trash, or you may no longer have access." action={<Button variant="primary" onClick={() => navigate({ name: 'drive' })}>Go to Drive</Button>} />
    </div>
  )
}

// Per-visit choices that should survive leaving and coming back while the page is open.
const modes = new Map<string, 'edit' | 'view'>()
const requested = new Set<string>()
const SEED_IDS = new Set([...seedDocs, ...myDocs].map(d => d.id))

type Panel = 'comments' | 'history'

/** Where a copy goes: next to the original if you can add files to that folder (you can edit
 *  it, it sits under one of your folders, or it's your team's folder), otherwise My Drive.
 *  The Drive's own Make a copy follows the same rule. */
function copyDestination(state: State, doc: Doc): Folder | null {
  const f = doc.folderId ? state.folders.find(x => x.id === doc.folderId) : undefined
  if (!f || isTrashed(state.folders, f)) return null
  if (canEditItem(f) || folderPath(state.folders, f.id)[0]?.ownerId === ME) return f
  const team = teamFolderOf(state.folders, f)?.team
  const inTeam = !!team && (personById[ME]?.team === team || state.conversations.some(c => c.name === team && c.members.includes(ME)))
  return inTeam ? f : null
}

function DocView({ doc }: { doc: Doc }) {
  const store = useStore()
  const { state, navigate, back, toast, toggleStar, patchItem } = store
  const desktop = useMedia('(min-width: 768px)')
  const wide = useMedia('(min-width: 1024px)')
  const inset = useKeyboardInset()
  const draft = useDocDraft(doc)
  const trashed = isTrashed(state.folders, doc)
  const editable = canEditItem(doc) && !trashed
  const commentable = canComment(doc, editable) && !trashed
  const canTrash = (doc.ownerId === ME || canEditItem(doc)) && !trashed
  const fresh = !SEED_IDS.has(doc.id) && doc.ownerId === ME && doc.versions.length <= 1
  const [mode, setModeState] = useState<'edit' | 'view'>(() => modes.get(doc.id) ?? (doc.ownerId === ME ? 'edit' : 'view'))
  const editing = editable && mode === 'edit'
  const [panel, setPanel] = useState<Panel>('comments')
  const [sheet, setSheet] = useState<Panel | null>(null)
  const [focusComment, setFocusComment] = useState<string | null>(null)
  const [newAnchor, setNewAnchor] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ key: string; text: string } | null>(null)
  const [menu, setMenu] = useState<'more' | 'assist-toolbar' | 'assist-footer' | 'assist-bar' | null>(null)
  const [dialog, setDialog] = useState<'share' | 'perm' | 'details' | 'trash' | null>(null)
  const [markdown, setMarkdown] = useState<string | null>(null)
  const assist = useAssist({ doc, draft, editable, title: draft.title.trim() || UNTITLED })
  // Bold, italic, underline and strikethrough for the line you're in (the caret's style, and toggling it).
  const inline = useInline(draft, editing)
  // Phones show block types or text styles in the bottom bar; selecting text brings up the styles.
  const [phoneBar, setPhoneBar] = useState<'blocks' | 'marks'>('blocks')
  const ranged = !!inline.state?.range
  useEffect(() => {
    if (ranged) setPhoneBar('marks')
  }, [ranged])

  const setMode = (m: 'edit' | 'view') => {
    modes.set(doc.id, m)
    setModeState(m)
  }
  // Switching to Editing puts the caret at the end of the first line you can see, as Docs does.
  const scrollRef = useRef<HTMLDivElement>(null)
  const switchMode = (m: 'edit' | 'view') => {
    if (m === 'view' || editing) { setMode(m); return }
    const area = scrollRef.current
    const top = area?.getBoundingClientRect().top ?? 0
    const seen = [...(area?.querySelectorAll<HTMLElement>('[data-block-key]') ?? [])].find(el => el.getBoundingClientRect().bottom > top + 24)
    setMode('edit')
    const key = seen?.getAttribute('data-block-key')
    if (key) draft.focus({ key, caret: 'end' })
  }

  // Opening a doc counts as opening it in the Drive (Recent).
  useEffect(() => {
    patchItem(doc.id, { lastOpenedAt: store.state.clock })
    // A new doc opens with the caret in its first empty block.
    if (fresh && editable && mode === 'edit') {
      const first = openLine(draft.itemsRef.current)
      if (first) draft.focus({ key: first.key, caret: 'end' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ctrl/Cmd+S out of habit: save now instead of opening the browser's "Save page".
  const saveNow = useRef(() => {})
  saveNow.current = () => {
    draft.patchDoc({})
    toast('Saved to Drive. Docs save as you type.')
  }
  useEffect(() => {
    if (!editable) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveNow.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editable])

  const title = draft.title.trim() || UNTITLED
  const path = folderPath(state.folders, doc.folderId)
  const home: Route = path.length ? { name: 'drive', folderId: path[path.length - 1].id } : { name: 'drive', view: doc.ownerId === ME ? 'my' : 'shared' }
  const openComments = doc.comments.filter(c => !c.resolved)
  const here = doc.presence.filter(id => id !== ME)
  const cursorBy = here[0]
  // A collaborator's simulated caret sits at the end of the last paragraph or list item.
  // It stays on that block while you type, and finds a new one if the block goes.
  const cursorAt = useRef<string | undefined>(undefined)
  if (cursorBy && !draft.items.some(i => i.key === cursorAt.current)) {
    const items = draft.items
    cursorAt.current = undefined
    for (let i = items.length - 1; i >= 0; i--) if ((items[i].block.type === 'p' || items[i].block.type === 'li') && items[i].block.text) { cursorAt.current = items[i].key; break }
  }
  const cursorKey = cursorAt.current

  const goBack = () => (state.history.length ? back() : navigate(home))
  const showPanel = (p: Panel) => (wide ? setPanel(p) : setSheet(p))
  const showComment = (id: string, passive?: boolean) => {
    setFocusComment(id)
    if (wide) setPanel('comments')
    else if (!passive) setSheet('comments')
  }
  const startComment = (anchor: string) => {
    setNewAnchor(anchor)
    setFocusComment(null)
    showPanel('comments')
  }

  const copyMarkdown = () => {
    const md = toMarkdown(title, toBlocks(draft.itemsRef.current))
    const ok = () => toast('Copied as Markdown. PDF and Word export aren’t in the demo yet.')
    try {
      navigator.clipboard.writeText(md).then(ok, () => setMarkdown(md))
    } catch {
      setMarkdown(md)
    }
  }

  const copyTo = copyDestination(state, doc)
  const makeCopy = () => {
    const clock = state.clock
    const copyTitle = `Copy of ${title}`
    const folder = copyTo
    const folderId = folder?.id ?? null
    const id = store.createDoc({ folderId, title: copyTitle, open: false })
    store.updateDoc({
      id, title: copyTitle, space: folder?.title ?? 'My Drive', folderId, ownerId: ME, editors: [ME], commenters: 'none',
      updatedAt: clock, updatedBy: ME, lastOpenedAt: clock, presence: [], emoji: draft.emoji,
      blocks: toBlocks(draft.itemsRef.current), comments: [],
      versions: [{ id: newId('v'), authorId: ME, ts: clock, summary: `Copied from “${title}”` }],
    })
    toast(`Made “${copyTitle}” in ${folder?.title ?? 'My Drive'}`, { label: 'Open', route: { name: 'docs', docId: id } })
  }

  const moveToTrash = () => {
    draft.leave()
    store.trashItem(doc.id)
    // Back to the Drive you came from; otherwise to the doc's folder, replacing the doc in
    // history so Back doesn't reopen what you just trashed.
    if (state.history[state.history.length - 1]?.name === 'drive') back()
    else navigate(home, { replace: true })
    toast(`Moved “${title}” to trash`, { label: 'View trash', route: { name: 'drive', view: 'trash' } })
  }

  // In the trash itself, or inside a folder that is. Restoring brings back whichever it is.
  const trashedFolders = path.filter(f => f.trashed)
  const inFolder = !doc.trashed && trashedFolders.length > 0
  const canRestore = (doc.trashed ? doc.ownerId === ME || canEditItem(doc) : true) && trashedFolders.every(f => f.ownerId === ME || canEditItem(f))
  const restore = () => {
    if (doc.trashed) store.restoreItem(doc.id)
    for (const f of trashedFolders) store.restoreItem(f.id)
    toast(trashedFolders.length ? `Restored “${trashedFolders[0].title}” from trash` : 'Restored from trash')
  }

  const moreItems: MenuItem[] = [
    { id: 'copy', label: 'Make a copy', note: `Saved in ${copyTo?.title ?? 'My Drive'}`, icon: <Copy size={17} />, onSelect: makeCopy },
    { id: 'history', label: 'Version history', note: `${doc.versions.length} ${doc.versions.length === 1 ? 'version' : 'versions'}`, icon: <History size={17} />, onSelect: () => showPanel('history') },
    { id: 'md', label: 'Copy as Markdown', note: 'PDF and Word export come later', icon: <ClipboardCopy size={17} />, onSelect: copyMarkdown },
    { id: 'details', label: 'Details', icon: <Info size={17} />, onSelect: () => setDialog('details') },
    {
      id: 'trash', label: 'Move to trash', divider: true, danger: true, icon: <Trash2 size={17} />, disabled: !canTrash, onSelect: () => setDialog('trash'),
      note: trashed ? 'Already in the trash' : canTrash ? 'You can restore it from Trash for 30 days' : `Only ${nameList(editorIds(doc))} can move this to trash`,
    },
  ]

  // The block types apply to the line with the caret, so they wait until you've clicked into one.
  const activeType = draft.items.find(i => i.key === active)?.block.type
  const setType = (t: BlockType) => applyType(draft, active, t)
  const typeHint = (t: BlockType) => (activeType ? typeLabels[t] : `${typeLabels[t]} (click a line first)`)
  const markHint = (m: Mark) => (inline.state ? `${markLabels[m]} (${markKeys[m]})` : `${markLabels[m]} (click a line first)`)
  const markButton = (m: Mark, phone: boolean) => {
    const Icon = markIcons[m]
    const on = !!inline.state?.marks[m]
    return (
      <button
        key={m}
        aria-pressed={on}
        aria-label={markLabels[m]}
        title={markHint(m)}
        disabled={!inline.state}
        onMouseDown={e => e.preventDefault()}
        onClick={() => inline.toggle(m)}
        className={phone
          ? cx('grid h-9 max-w-10 min-w-7 flex-1 place-items-center rounded-full transition disabled:opacity-40', on ? 'bg-accent-soft text-accent-ink' : 'hover:bg-surface-2')
          : cx('grid size-8 shrink-0 place-items-center rounded-lg transition disabled:opacity-40 disabled:hover:bg-transparent', on ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-surface-2 hover:text-fg')}
      >
        <Icon size={phone ? 19 : 16} strokeWidth={on ? 2.6 : 2} aria-hidden />
      </button>
    )
  }
  const at = editing ? active ?? undefined : undefined
  const slashActions = assist.items().filter(i => !i.disabled).map(i => ({ id: `ai-${i.id}`, label: i.label, hint: '', icon: i.icon, run: (key: string) => assist.run(i.id as AssistKind, key) }))

  const panelBody = (p: Panel) =>
    p === 'comments' ? (
      <Comments doc={doc} draft={draft} focus={focusComment} canComment={commentable} newAnchor={newAnchor} onDoneNew={() => setNewAnchor(null)} offReason={trashed ? 'Restore this doc from the trash to comment.' : undefined} />
    ) : (
      <Versions doc={doc} draft={draft} editable={editable} lockedReason={trashed ? 'Take this doc out of the trash to go back to a version.' : undefined} />
    )

  const blankNow = editable && assist.blank && !assist.busy

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <DocHeader
        doc={doc} draft={draft} desktop={desktop} wide={wide} editable={editable} editing={editing} title={title} path={path} here={here}
        onBack={goBack} onMode={switchMode} onShare={() => setDialog('share')} onComments={() => setSheet('comments')} onHistory={() => setSheet('history')} openComments={openComments.length}
        moreOpen={menu === 'more'} onMore={() => setMenu(menu === 'more' ? null : 'more')} moreMenu={<Menu open={menu === 'more'} onClose={() => setMenu(null)} items={moreItems} title="More" popover={desktop} />}
        trashed={trashed}
      />

      {editing && desktop && (
        <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5 sm:px-4" role="toolbar" aria-label="Formatting">
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
            <IconButton label="Undo" title="Undo (Ctrl+Z)" className="size-8 text-muted hover:text-fg disabled:opacity-40" disabled={!draft.canUndo()} onMouseDown={e => e.preventDefault()} onClick={draft.undo}><Undo2 size={16} /></IconButton>
            <IconButton label="Redo" title="Redo (Ctrl+Shift+Z)" className="size-8 text-muted hover:text-fg disabled:opacity-40" disabled={!draft.canRedo()} onMouseDown={e => e.preventDefault()} onClick={draft.redo}><Redo2 size={16} /></IconButton>
            <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden />
            {blockOrder.map(t => {
              const Icon = typeIcons[t]
              return (
                <button
                  key={t}
                  aria-pressed={activeType === t}
                  title={typeHint(t)}
                  aria-label={typeLabels[t]}
                  disabled={!activeType}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setType(t)}
                  className={cx('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium transition disabled:opacity-40 disabled:hover:bg-transparent', activeType === t ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-surface-2 hover:text-fg')}
                >
                  <Icon size={16} aria-hidden /><span className="hidden xl:inline">{typeLabels[t]}</span>
                </button>
              )
            })}
            <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden />
            <div role="group" aria-label="Text style" className="flex shrink-0 items-center gap-0.5">{MARKS.map(m => markButton(m, false))}</div>
            <span className="mx-1.5 h-5 w-px shrink-0 bg-line" aria-hidden />
            <button
              onMouseDown={e => e.preventDefault()}
              disabled={!selection}
              onClick={() => selection && startComment(selection.text)}
              title={selection ? `Comment on “${selection.text}”` : 'Select text to comment on it'}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-muted transition hover:bg-surface-2 hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <MessageSquarePlus size={16} aria-hidden /><span className="hidden lg:inline">Comment</span>
            </button>
          </div>
          <div className="relative shrink-0">
            <Button size="sm" variant="agent" icon={<Sparkles size={14} />} onMouseDown={e => e.preventDefault()} onClick={() => setMenu(menu === 'assist-toolbar' ? null : 'assist-toolbar')} aria-expanded={menu === 'assist-toolbar'}>Help me write</Button>
            <Menu open={menu === 'assist-toolbar'} onClose={() => setMenu(null)} items={assist.items(at)} title="Help me write" popover />
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
          <div className={cx('mx-auto w-full max-w-[68ch] px-5 pt-5 sm:px-8 sm:pt-8', editable && !editing && !desktop ? 'pb-28' : 'pb-16')}>
            {trashed && (
              <div className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl bg-rec-soft px-4 py-3 text-sm">
                <Trash2 size={16} className="shrink-0 text-rec" aria-hidden />
                <span className="min-w-0 flex-1 basis-56">
                  {inFolder ? `This doc is in “${trashedFolders[0].title}”, which is in the trash.` : 'This doc is in the trash.'}
                  {canRestore ? ` Restore ${inFolder ? 'the folder' : 'it'} to edit or comment.` : ` Only ${inFolder ? byName(trashedFolders[0].ownerId) : nameList(editorIds(doc))} can restore it.`}
                </span>
                {canRestore && <Button size="sm" variant="secondary" icon={<Undo2 size={14} />} onClick={restore}>{inFolder ? 'Restore folder' : 'Restore'}</Button>}
              </div>
            )}
            <MetaBar doc={doc} editable={editable} trashed={trashed} commentable={commentable} here={here} onPermissions={() => setDialog('perm')} untouched={!SEED_IDS.has(doc.id) && doc.versions.length === 1 && !draft.savedOnce && !draft.saving} />
            <Editor
              doc={doc}
              draft={draft}
              mode={editing ? 'edit' : 'view'}
              editable={editable}
              commentable={commentable}
              cursor={cursorBy && cursorKey ? { key: cursorKey, personId: cursorBy } : undefined}
              focusComment={focusComment}
              onAnchor={showComment}
              onActive={setActive}
              onSelectText={setSelection}
              onComment={startComment}
              inline={inline}
              slashActions={slashActions}
              afterTitle={assist.slot('top')}
              afterBlock={assist.afterBlock()}
              end={
                <>
                  {assist.slot('body')}
                  {assist.endSlot()}
                  {blankNow ? (
                    <BlankStart draft={draft} onApplied={() => setMode('edit')} onMeeting={() => assist.run('meeting')} />
                  ) : !assist.busy && !trashed && (
                    <div className="mt-12 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-5 font-sans">
                      <div className="relative">
                        <Button variant="agent" icon={<Sparkles size={15} />} onClick={() => (editable ? setMenu(menu === 'assist-footer' ? null : 'assist-footer') : assist.run('summary'))} aria-expanded={menu === 'assist-footer'}>
                          {editable ? 'Help me write' : 'Summarise this doc'}
                        </Button>
                        <Menu open={menu === 'assist-footer'} onClose={() => setMenu(null)} items={assist.items()} title="Help me write" popover={desktop} align="left" side="above" />
                      </div>
                      <p className="min-w-0 flex-1 basis-56 text-xs text-muted">
                        {editable ? 'Drafts and summaries from what you can open. Nothing goes in until you insert it.' : 'A short summary built from this doc’s own text, to read or copy.'}
                      </p>
                    </div>
                  )}
                </>
              }
            />
          </div>
        </div>
        {wide && (
          <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface" aria-label="Comments and history">
            <div className="border-b border-line px-4 py-3">
              <Segmented value={panel} onChange={setPanel} options={[{ value: 'comments', label: `Comments · ${openComments.length}` }, { value: 'history', label: 'Version history' }]} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{panelBody(panel)}</div>
          </aside>
        )}
      </div>

      {!desktop && editing && (
        <div className="flex items-center gap-1 border-t border-line bg-surface px-1.5 py-1.5" style={{ marginBottom: inset }} role="toolbar" aria-label="Formatting">
          {/* The buttons share the width, so the bar fits from 320 px up without hiding Done. */}
          <div className="flex min-w-0 flex-1 items-center">
            <button
              aria-label="Text style"
              aria-pressed={phoneBar === 'marks'}
              title={phoneBar === 'marks' ? 'Back to block types' : 'Bold, italic, underline, strikethrough'}
              onMouseDown={e => e.preventDefault()}
              onClick={() => setPhoneBar(phoneBar === 'marks' ? 'blocks' : 'marks')}
              className={cx('grid h-9 max-w-10 min-w-7 flex-1 place-items-center rounded-full transition', phoneBar === 'marks' ? 'bg-accent-soft text-accent-ink' : 'hover:bg-surface-2')}
            >
              <ALargeSmall size={20} aria-hidden />
            </button>
            <span className="mx-0.5 h-6 w-px shrink-0 bg-line" aria-hidden />
            {phoneBar === 'marks' ? MARKS.map(m => markButton(m, true)) : blockOrder.map(t => {
              const Icon = typeIcons[t]
              return (
                <button
                  key={t}
                  aria-label={typeLabels[t]}
                  title={typeHint(t)}
                  aria-pressed={activeType === t}
                  disabled={!activeType}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => setType(t)}
                  // Below 400 px "Text" makes way so the others stay 40 px wide: tapping a pressed type turns the line back into text.
                  className={cx('grid h-9 max-w-10 min-w-7 flex-1 place-items-center rounded-full transition disabled:opacity-40', activeType === t ? 'bg-surface-2 text-accent-ink' : 'hover:bg-surface-2', t === 'p' && 'max-[399px]:hidden')}
                >
                  <Icon size={19} aria-hidden />
                </button>
              )
            })}
            <span className={cx('mx-0.5 h-6 w-px shrink-0 bg-line', phoneBar === 'marks' && 'ml-auto')} aria-hidden />
            <button aria-label="Help me write" title="Help me write" onMouseDown={e => e.preventDefault()} onClick={() => setMenu('assist-bar')} className="grid h-9 max-w-10 min-w-7 flex-1 place-items-center rounded-full text-agent transition hover:bg-surface-2">
              <Sparkles size={19} aria-hidden />
            </button>
          </div>
          <Button size="sm" variant="primary" icon={<Check size={15} />} className="shrink-0 max-[359px]:px-2.5" onClick={() => { (document.activeElement as HTMLElement | null)?.blur(); setMode('view') }}>
            <span className="max-[359px]:sr-only">Done</span>
          </Button>
          <Menu open={menu === 'assist-bar'} onClose={() => setMenu(null)} items={assist.items(at)} title="Help me write" popover={false} />
        </div>
      )}
      {!desktop && editable && !editing && (
        <button
          onClick={() => switchMode('edit')}
          className="absolute right-4 bottom-5 z-20 inline-flex h-14 items-center gap-2 rounded-full bg-accent pr-5 pl-4 font-semibold text-accent-fg shadow-card transition active:brightness-95"
        >
          <Pencil size={19} aria-hidden /> Edit
        </button>
      )}

      {!wide && (
        <Sheet open={sheet !== null} onClose={() => { setSheet(null); setNewAnchor(null) }} title={sheet === 'history' ? 'Version history' : `Comments · ${openComments.length}`}>
          {sheet && panelBody(sheet)}
        </Sheet>
      )}
      {assist.pickerSheet}
      <ShareDialog itemId={doc.id} open={dialog === 'share'} onClose={() => setDialog(null)} />
      <PermissionsSheet open={dialog === 'perm'} onClose={() => setDialog(null)} doc={doc} onShare={() => setDialog('share')} />
      <DetailsSheet open={dialog === 'details'} onClose={() => setDialog(null)} doc={doc} draft={draft} />
      <Sheet
        open={dialog === 'trash'}
        onClose={() => setDialog(null)}
        title="Move to trash?"
        footer={<><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button variant="danger" icon={<Trash2 size={15} />} onClick={() => { setDialog(null); moveToTrash() }}>Move to trash</Button></>}
      >
        <p className="text-sm">“{title}” moves to Trash in Drive. Anyone it’s shared with loses access until it’s restored. Items in the trash are deleted after 30 days.</p>
      </Sheet>
      <Sheet open={markdown !== null} onClose={() => setMarkdown(null)} title="Copy as Markdown">
        <p className="mb-2 text-sm text-muted">Your browser didn’t allow copying from here. Select the text below and copy it.</p>
        <label htmlFor="md-out" className="sr-only">Markdown</label>
        <textarea id="md-out" readOnly value={markdown ?? ''} rows={12} onFocus={e => e.currentTarget.select()} className="w-full resize-none rounded-xl bg-surface-2 p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-accent" />
      </Sheet>
    </div>
  )
}

// ── Header ──────────────────────────────────────────────────────────────────
function DocHeader(p: {
  doc: Doc; draft: DocDraft; desktop: boolean; wide: boolean; editable: boolean; editing: boolean; title: string; path: { id: string; title: string }[]; here: string[]
  onBack: () => void; onMode: (m: 'edit' | 'view') => void; onShare: () => void; onComments: () => void; onHistory: () => void; openComments: number
  moreOpen: boolean; onMore: () => void; moreMenu: ReactNode; trashed: boolean
}) {
  const { doc, draft, desktop, editable, editing, here } = p
  const { toggleStar } = useStore()
  const titleRef = useRef<HTMLInputElement>(null)
  const saveState = p.trashed ? (
    <span className="inline-flex min-w-0 items-center gap-1 text-rec"><Trash2 size={12} className="shrink-0" aria-hidden /><span className="truncate">In trash</span></span>
  ) : !editable ? (
    <span className="inline-flex min-w-0 items-center gap-1"><Eye size={12} className="shrink-0" aria-hidden /><span className="truncate">View only</span></span>
  ) : draft.saving ? (
    <span className="inline-flex min-w-0 items-center gap-1" aria-live="polite"><CloudUpload size={13} className="anim-pulse shrink-0" aria-hidden /><span className="truncate">Saving…</span></span>
  ) : (
    <span className="inline-flex min-w-0 items-center gap-1" aria-live="polite"><CloudCheck size={13} className="shrink-0" aria-hidden /><span className="truncate">Saved to Drive</span></span>
  )
  const titleEl = editable ? (
    <>
      <label htmlFor="doc-title" className="sr-only">Doc title</label>
      <input
        id="doc-title"
        ref={titleRef}
        value={draft.title}
        placeholder={UNTITLED}
        size={Math.max(10, draft.title.length + 1)}
        onChange={e => draft.setTitle(e.target.value, e.target.selectionEnd ?? undefined)}
        onKeyDown={e => {
          if (e.key !== 'Enter' && e.key !== 'Escape') return
          e.preventDefault()
          // Enter carries on into the doc, like Google Docs; Escape just leaves the title.
          const items = draft.itemsRef.current
          const next = e.key === 'Enter' && editing ? (items[0]?.block.type === 'h1' ? items[1] : items[0]) : undefined
          if (next) draft.focus({ key: next.key, caret: 0 })
          else titleRef.current?.blur()
        }}
        className={cx('-ml-1.5 max-w-full min-w-0 truncate rounded-md bg-transparent px-1.5 font-display leading-tight font-semibold outline-none [field-sizing:content] placeholder:text-muted hover:bg-surface-2 focus:bg-surface-2 focus:ring-2 focus:ring-accent', desktop ? 'text-lg' : 'w-full text-[17px]')}
      />
    </>
  ) : (
    <h1 className={cx('truncate font-display font-semibold', desktop ? 'text-lg' : 'text-[17px]')}>{p.title}</h1>
  )
  const crumbLine = <FileCrumbs item={doc} compact={!desktop} trailing={saveState} />
  const star = (
    <IconButton label={doc.starred ? 'Remove from Starred' : 'Add to Starred'} aria-pressed={!!doc.starred} onClick={() => toggleStar(doc.id)}>
      <Star size={19} className={doc.starred ? 'fill-current text-warn' : 'text-muted'} />
    </IconButton>
  )
  const comments = (
    <IconButton label={`Comments (${p.openComments})`} onClick={p.onComments} className="relative">
      <MessageSquareText size={20} />
      {p.openComments > 0 && <span className="absolute top-1 right-1 grid size-4 place-items-center rounded-full bg-accent text-[10px] font-bold text-accent-fg">{p.openComments}</span>}
    </IconButton>
  )
  const more = (
    <div className="relative">
      <IconButton label="More" aria-expanded={p.moreOpen} active={p.moreOpen} onClick={p.onMore}><Ellipsis size={20} /></IconButton>
      {p.moreMenu}
    </div>
  )

  if (!desktop) {
    return (
      <header className="flex min-h-14 items-center gap-0.5 border-b border-line bg-surface px-2 py-1.5">
        <IconButton label="Back" onClick={p.onBack}><ArrowLeft size={20} /></IconButton>
        <div className="min-w-0 flex-1 pl-0.5">
          {titleEl}
          {crumbLine}
        </div>
        {star}
        <ShareButton itemId={doc.id} onClick={p.onShare} compact />
        {comments}
        {more}
      </header>
    )
  }
  return (
    <header className="flex min-h-14 items-center gap-2 border-b border-line bg-surface px-2 py-1.5 sm:px-3">
      <IconButton label="Back" onClick={p.onBack}><ArrowLeft size={20} /></IconButton>
      <KindIcon kind="doc" size="md" className="hidden sm:grid" />
      <div className="min-w-0 flex-1">
        {titleEl}
        {crumbLine}
      </div>
      {here.length > 0 && (
        <span className="hidden items-center gap-2 lg:flex" title={`${cap(nameList(here))} ${here.length === 1 ? 'is' : 'are'} here`}>
          <AvatarStack ids={here} max={3} size="sm" />
        </span>
      )}
      {editable && (
        <Segmented
          value={editing ? 'edit' : 'view'}
          onChange={p.onMode}
          options={[
            { value: 'edit', label: <span className="inline-flex items-center gap-1.5" title="Editing"><Pencil size={13} aria-hidden /><span className="sr-only lg:not-sr-only">Editing</span></span> },
            { value: 'view', label: <span className="inline-flex items-center gap-1.5" title="Viewing"><Eye size={13} aria-hidden /><span className="sr-only lg:not-sr-only">Viewing</span></span> },
          ]}
        />
      )}
      {!p.wide && comments}
      {!p.wide && <IconButton label="Version history" onClick={p.onHistory}><History size={20} /></IconButton>}
      {star}
      <ShareButton itemId={doc.id} onClick={p.onShare} />
      {more}
    </header>
  )
}

// ── Presence, permissions and who last edited ──────────────────────────────
function MetaBar({ doc, editable, trashed, commentable, here, onPermissions, untouched }: { doc: Doc; editable: boolean; trashed: boolean; commentable: boolean; here: string[]; onPermissions: () => void; untouched: boolean }) {
  const { toast } = useStore()
  const [asked, setAsked] = useState(requested.has(doc.id))
  const editedBy = doc.updatedBy ?? doc.versions[0]?.authorId ?? doc.ownerId
  const presence = here.length > 0 && (
    <span className="flex items-center gap-2">
      <AvatarStack ids={here} max={3} size="xs" />
      <span><span className="text-fg">{cap(nameList(here))}</span> {here.length === 1 ? 'is' : 'are'} here</span>
    </span>
  )
  const edited = <span>{untouched ? 'Created' : 'Edited'} {stamp(doc.updatedAt)} by {byName(editedBy)}</span>
  if (!editable && !trashed) {
    const owner = fullName(doc.ownerId)
    return (
      <div className="mb-6 flex flex-col gap-3 border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-surface px-3.5 py-2.5">
          <Eye size={16} className="shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1 basis-48">
            <button onClick={onPermissions} className="-my-2.5 py-2.5 text-left text-sm font-medium hover:underline">View only · {cap(nameList(editorIds(doc)))} can edit</button>
            <p className="text-xs text-muted">{commentable ? 'You can read and comment.' : 'You can read this doc.'}</p>
          </div>
          <Button
            size="sm"
            variant={asked ? 'ghost' : 'secondary'}
            disabled={asked}
            icon={asked ? <Check size={14} /> : <Pencil size={14} />}
            onClick={() => {
              requested.add(doc.id)
              setAsked(true)
              toast(`Edit access requested from ${owner}`)
            }}
          >
            {asked ? 'Edit access requested' : 'Request edit access'}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted">{presence}{edited}</div>
      </div>
    )
  }
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-4 text-xs text-muted">
      {presence}
      <button onClick={onPermissions} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-2 font-medium text-fg transition hover:bg-line sm:py-1">
        {editable ? <Pencil size={12} className="shrink-0" aria-hidden /> : <Lock size={12} className="shrink-0" aria-hidden />}
        <span className="truncate">{permissionLine(doc)}</span>
      </button>
      {edited}
    </div>
  )
}
