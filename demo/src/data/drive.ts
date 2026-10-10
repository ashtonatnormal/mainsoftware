// Drive seed data (FILE-01..08, DOC-08, DOC-12, DOC-13): folders, uploaded
// files, sheets and slide decks for Tembusu Logistics. Docs themselves live in
// data/work.ts; each doc names its folder with folderId.
import type { Deck, Doc, DocBlock, DocTemplateId, DriveUpload, Folder, Sheet, SheetCell, SheetTab } from '../types'
import { ME } from './people'
import { at, minutesAgo } from '../time'

// ── Folders ──────────────────────────────────────────────────────────────────
// Team folders sit at the top level and are open to a whole team or the org.
export const folders: Folder[] = [
  { id: 'f_q4', title: 'Q4 launch', ownerId: 'u_priya', folderId: null, team: 'Q4 launch crew', access: 'team', color: 'ember', updatedAt: at('2026-10-09T15:28'), description: 'Everything for the Meridian Foods launch on 2 Nov.' },
  { id: 'f_ops', title: 'Ops wiki', ownerId: 'u_priya', folderId: null, team: 'Operations', access: 'org', color: 'teal', updatedAt: at('2026-10-10T18:05'), description: 'Runbooks, rosters and site guides for Woodlands DC.' },
  { id: 'f_hr', title: 'HR wiki', ownerId: 'u_huimin', folderId: null, team: 'People', access: 'org', color: 'rose', updatedAt: at('2026-10-09T16:55'), description: 'Policies and benefits. Everyone can read; People edits.' },
  { id: 'f_people', title: 'People', ownerId: 'u_huimin', folderId: null, team: 'People', access: 'org', color: 'amber', updatedAt: minutesAgo(50), description: 'Onboarding, all-hands and team pages.' },
  { id: 'f_it', title: 'IT wiki', ownerId: 'u_arjun', folderId: null, team: 'IT', access: 'org', color: 'slate', updatedAt: at('2026-09-15T10:00'), description: 'How-tos for Hearth, devices and accounts. Everyone can read; IT edits.' },
  { id: 'f_q4_contract', title: 'Contract and pricing', ownerId: 'u_ahmad', folderId: 'f_q4', updatedAt: at('2026-09-28T11:40') },
  // Ashton's own folders (My Drive)
  { id: 'f_board', title: 'Board pack · October', ownerId: ME, folderId: null, access: 'restricted', color: 'slate', updatedAt: at('2026-10-11T21:10') },
  { id: 'f_vendor', title: 'Vendor quotes', ownerId: ME, folderId: null, access: 'restricted', sharedWith: [{ personId: 'u_priya', role: 'editor' }], color: 'green', updatedAt: at('2026-10-09T19:12') },
]

// ── Uploaded files ───────────────────────────────────────────────────────────
export const uploads: DriveUpload[] = [
  {
    id: 'up_ot', kind: 'pdf', title: 'OT roster – Sat 17 Oct.pdf', ownerId: 'u_marcus', folderId: null, fromConversationId: 'c_ops', access: 'team',
    size: '84 KB', pages: 2, updatedAt: at('2026-10-12T08:20'), lastOpenedAt: at('2026-10-12T08:31'),
    previewText: 'Woodlands DC · Saturday overtime roster · 17 October 2026. Unloading crew, 7:00 am – 3:00 pm: Raj Kumar, Lim Wei Jie, Siti Aminah, Tan Boon Huat, Muhammad Faizal, Ng Li Ting. Cold room, 8:00 am – 2:00 pm: Arif Hassan, Chen Jia Hui, Suresh Pillai. Checkers: Lee Kok Wai, Nur Atiqah. 11 people, 82 hours. Approval needed by 12 pm Monday.',
  },
  {
    id: 'up_forklift', kind: 'image', title: 'Forklift 3 – hydraulic leak.jpg', ownerId: 'u_farah', folderId: null, fromConversationId: 'c_ops', access: 'team',
    size: '2.1 MB', hue: 28, updatedAt: at('2026-10-12T07:52'),
    previewText: 'Photo: forklift 3 at bay 4 with oil pooling under the mast.',
  },
  {
    id: 'up_kranji', kind: 'pdf', title: 'Kranji Movers – quote.pdf', ownerId: 'u_priya', folderId: 'f_vendor',
    size: '212 KB', pages: 3, updatedAt: at('2026-10-09T19:12'), lastOpenedAt: at('2026-10-09T19:40'),
    previewText: 'Kranji Movers Pte Ltd · Quotation Q-2291 · Racking relocation, Woodlands DC cold room. Scope: dismantle, move and reinstall 14 bays over 3 days, 2–4 Nov. Price: S$18,400 before GST. Insurance: goods-in-transit cover up to S$500,000. Weekend work at no extra charge. Valid until 16 Oct.',
  },
  {
    id: 'up_swift', kind: 'pdf', title: 'SwiftMove quote.pdf', ownerId: 'u_priya', folderId: 'f_vendor',
    size: '280 KB', pages: 2, updatedAt: at('2026-10-08T17:30'),
    previewText: 'SwiftMove Logistics · Quote SM-0817 · Racking relocation, Woodlands DC. 14 bays over 2 days, 2–3 Nov. Price: S$21,000 before GST, plus S$1,200 weekend surcharge. Insurance: cover up to S$1,000,000.',
  },
  {
    id: 'up_layout', kind: 'image', title: 'Cold-room layout v3.png', ownerId: 'u_daniel', folderId: 'f_q4',
    size: '1.4 MB', hue: 190, updatedAt: at('2026-10-08T14:02'),
    previewText: 'Floor plan: cold room at Woodlands DC with 14 racking bays, two dock doors and the new Meridian staging lane.',
  },
  {
    id: 'up_msa', kind: 'pdf', title: 'Meridian Foods MSA (signed).pdf', ownerId: 'u_ahmad', folderId: 'f_q4_contract',
    size: '1.2 MB', pages: 14, updatedAt: at('2026-09-28T11:40'),
    previewText: 'Master Services Agreement between Tembusu Logistics Pte Ltd and Meridian Foods Pte Ltd. Term: 2 years from 2 Nov 2026. Services: chilled warehousing at Woodlands DC and next-day island-wide delivery. Volume: about 1,200 pallets a month from week 3. Pricing: Schedule B.',
  },
  {
    id: 'up_safety', kind: 'video', title: 'Forklift safety refresher.mp4', ownerId: 'u_marcus', folderId: 'f_ops',
    size: '48 MB', durationSec: 312, hue: 160, updatedAt: at('2026-09-21T10:15'),
    previewText: 'Video, 5 min: pre-shift forklift checks, load limits and pedestrian zones at Woodlands DC.',
  },
  {
    id: 'up_q3', kind: 'pdf', title: 'Q3 results summary.pdf', ownerId: ME, folderId: 'f_board',
    size: '640 KB', pages: 6, updatedAt: at('2026-10-11T21:10'), lastOpenedAt: at('2026-10-11T21:10'),
    previewText: 'Q3 2026 results. Revenue S$4.8M (+6% on Q2). On-time deliveries 98.6%. Warehouse utilisation 81%. New contracts: Meridian Foods (from 2 Nov). Headcount 412.',
  },
]

// ── Sheets ───────────────────────────────────────────────────────────────────
/** Builds a tab from rows of raw values (row 1 first). Strings starting "=" are formulas. */
function tab(id: string, name: string, rows: (string | number | null)[][], opts: { cols?: number; rows?: number; style?: Record<string, Partial<SheetCell>>; widths?: Record<string, number>; frozenRows?: number } = {}): SheetTab {
  const cells: Record<string, SheetCell> = {}
  rows.forEach((r, ri) => r.forEach((v, ci) => {
    if (v === null || v === '') return
    cells[`${String.fromCharCode(65 + ci)}${ri + 1}`] = { v: String(v) }
  }))
  for (const [addr, st] of Object.entries(opts.style ?? {})) cells[addr] = { v: cells[addr]?.v ?? '', ...st }
  return { id, name, cells, cols: opts.cols ?? 12, rows: opts.rows ?? 40, colWidths: opts.widths, frozenRows: opts.frozenRows }
}

const bold = (addrs: string[], extra: Partial<SheetCell> = {}) => Object.fromEntries(addrs.map(a => [a, { b: true, ...extra }]))
const fmt = (col: string, from: number, to: number, f: SheetCell['fmt']) => Object.fromEntries(Array.from({ length: to - from + 1 }, (_, i) => [`${col}${from + i}`, { fmt: f }]))

const roster: [string, string, string, number, number][] = [
  ['Raj Kumar', 'Forklift driver', 'Unloading', 8, 18],
  ['Lim Wei Jie', 'Loader', 'Unloading', 8, 15],
  ['Siti Aminah', 'Loader', 'Unloading', 8, 15],
  ['Tan Boon Huat', 'Forklift driver', 'Unloading', 8, 18],
  ['Muhammad Faizal', 'Loader', 'Unloading', 8, 15],
  ['Ng Li Ting', 'Picker', 'Unloading', 8, 14],
  ['Arif Hassan', 'Picker', 'Cold room', 6, 15],
  ['Chen Jia Hui', 'Picker', 'Cold room', 6, 15],
  ['Suresh Pillai', 'Forklift driver', 'Cold room', 6, 18],
  ['Lee Kok Wai', 'Checker', 'Unloading', 8, 16],
  ['Nur Atiqah', 'Checker', 'Cold room', 8, 16],
]

const weeks: [string, string, number, number][] = [
  ['Week 1', '2 Nov', 0, 640],
  ['Week 2', '9 Nov', 300, 655],
  ['Week 3', '16 Nov', 280, 660],
  ['Week 4', '23 Nov', 290, 650],
  ['Week 5', '30 Nov', 300, 670],
  ['Week 6', '7 Dec', 310, 690],
  ['Week 7', '14 Dec', 320, 720],
  ['Week 8', '21 Dec', 330, 760],
]

export const sheets: Sheet[] = [
  {
    id: 'sh_ot', title: 'Saturday OT roster · 17 Oct', ownerId: 'u_marcus', folderId: 'f_ops', editors: ['u_marcus', 'u_priya', ME], commenters: 'team',
    updatedAt: at('2026-10-12T08:18'), updatedBy: 'u_marcus', lastOpenedAt: at('2026-10-12T08:33'), presence: ['u_marcus'], cursors: { u_marcus: 'D6' },
    tabs: [
      tab('t_roster', 'Roster', [
        ['Name', 'Role', 'Shift', 'Hours', 'Rate (S$/h)', 'OT pay (1.5×)'],
        ...roster.map(([n, r, s, h, rate], i) => [n, r, s, h, rate, `=D${i + 2}*E${i + 2}*1.5`]),
        [],
        ['Total', null, null, '=SUM(D2:D12)', null, '=SUM(F2:F12)'],
        ['Budget', null, null, null, null, 2200],
        ['Left in budget', null, null, null, null, '=F15-F14'],
        ['Average rate', null, null, null, '=AVERAGE(E2:E12)', null],
      ], {
        cols: 8, rows: 30, frozenRows: 1,
        widths: { A: 160, B: 130, C: 100, D: 70, E: 100, F: 120 },
        style: {
          ...bold(['A1', 'B1', 'C1', 'D1', 'E1', 'F1'], { fill: 'muted' }),
          ...bold(['A14', 'D14', 'F14']), ...bold(['A15', 'A16', 'A17']),
          ...fmt('E', 2, 12, 'currency'), ...fmt('F', 2, 16, 'currency'), E17: { b: false, fmt: 'currency' },
          F14: { b: true, fmt: 'currency', fill: 'accent' }, F16: { b: true, fmt: 'currency', fill: 'ok' },
        },
      }),
      tab('t_notes', 'Notes', [
        ['Notes from Marcus'],
        ['Container from Pasir Panjang is now Tue 6 am, so the unloading crew moves to Saturday.'],
        ['Cold-room picks stay on the morning shift until forklift 3 is fixed.'],
        ['OT is paid at 1.5× the base rate. Approval needed from Ashton by 12 pm Monday.'],
      ], { cols: 4, rows: 20, widths: { A: 520 }, style: bold(['A1']) }),
    ],
  },
  {
    id: 'sh_forecast', title: 'Q4 pallet forecast', ownerId: 'u_weiling', folderId: 'f_q4', editors: ['u_weiling', 'u_priya', ME], commenters: 'team',
    updatedAt: at('2026-10-10T11:20'), updatedBy: 'u_weiling', presence: ['u_weiling'], cursors: { u_weiling: 'G4' }, starred: true,
    tabs: [
      tab('t_weekly', 'Weekly', [
        ['Week', 'Starts', 'Meridian pallets', 'Existing pallets', 'Total', 'Cold-room capacity', 'Utilisation'],
        ...weeks.map(([w, s, m, e], i) => [w, s, m, e, `=C${i + 2}+D${i + 2}`, 1000, `=E${i + 2}/F${i + 2}`]),
        [],
        ['Total', null, '=SUM(C2:C9)', '=SUM(D2:D9)', '=SUM(E2:E9)', null, null],
        ['Average', null, '=AVERAGE(C2:C9)', '=AVERAGE(D2:D9)', '=AVERAGE(E2:E9)', null, '=AVERAGE(G2:G9)'],
        ['Peak week', null, null, null, '=MAX(E2:E9)', null, '=MAX(G2:G9)'],
      ], {
        cols: 10, rows: 30, frozenRows: 1,
        widths: { A: 90, B: 80, C: 140, D: 140, E: 90, F: 150, G: 110 },
        style: {
          ...bold(['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1'], { fill: 'muted' }),
          ...bold(['A11', 'A12', 'A13']),
          ...fmt('C', 2, 13, 'integer'), ...fmt('D', 2, 13, 'integer'), ...fmt('E', 2, 13, 'integer'), ...fmt('F', 2, 9, 'integer'), ...fmt('G', 2, 13, 'percent'),
          E13: { b: true, fmt: 'integer', fill: 'warn' }, G13: { b: true, fmt: 'percent', fill: 'warn' },
        },
      }),
      tab('t_assume', 'Assumptions', [
        ['Assumption', 'Value', 'Source'],
        ['Meridian volume from week 3', '1,200 a month', 'Meridian Foods MSA, Schedule B'],
        ['Cold-room capacity', '1,000 pallets a week', 'Ops wiki · site guide'],
        ['Week 1 is racking and training', 'No Meridian pallets', 'Q4 Launch Proposal'],
      ], { cols: 5, rows: 20, widths: { A: 230, B: 170, C: 240 }, style: bold(['A1', 'B1', 'C1'], { fill: 'muted' }) }),
    ],
  },
  {
    id: 'sh_movers', title: 'Movers quote comparison', ownerId: ME, folderId: 'f_vendor', editors: [ME, 'u_priya'], commenters: 'none',
    updatedAt: at('2026-10-09T20:02'), updatedBy: ME, lastOpenedAt: at('2026-10-09T20:02'), presence: [],
    tabs: [
      tab('t_cmp', 'Comparison', [
        ['', 'Kranji Movers', 'SwiftMove'],
        ['Base price (S$)', 18400, 21000],
        ['Weekend surcharge (S$)', 0, 1200],
        ['Total (S$)', '=B2+B3', '=C2+C3'],
        ['Insurance cover (S$)', 500000, 1000000],
        ['Days on site', 3, 2],
        [],
        ['Saving with Kranji (S$)', '=C4-B4', null],
        ['Saving with Kranji (%)', '=B8/C4', null],
      ], {
        cols: 6, rows: 20,
        widths: { A: 200, B: 140, C: 140 },
        style: {
          ...bold(['B1', 'C1'], { fill: 'muted', align: 'right' }), ...bold(['A4', 'B4', 'C4']), ...bold(['A8', 'A9']),
          ...fmt('B', 2, 5, 'currency'), ...fmt('C', 2, 5, 'currency'), B4: { b: true, fmt: 'currency' }, C4: { b: true, fmt: 'currency' },
          B8: { b: true, fmt: 'currency', fill: 'ok' }, B9: { fmt: 'percent', fill: 'ok' },
        },
      }),
    ],
  },
]

// ── Slide decks ──────────────────────────────────────────────────────────────
export const decks: Deck[] = [
  {
    id: 'dk_q4', title: 'Q4 launch review', ownerId: 'u_priya', folderId: 'f_q4', editors: ['u_priya', 'u_daniel', ME], commenters: 'team', theme: 'ember',
    updatedAt: at('2026-10-11T22:14'), updatedBy: 'u_daniel', presence: ['u_daniel'],
    slides: [
      { id: 'sl1', layout: 'title', title: 'Meridian Foods launch', subtitle: 'Q4 launch review · Mon 12 Oct', notes: 'Five minutes on status, then the three decisions.' },
      { id: 'sl2', layout: 'bullets', title: 'Where we are', bullets: ['Contract signed 28 Sep, live from 2 Nov', 'Cold-room racking booked for 2–6 Nov', 'Price sheet with the 5% volume tier due Wed', 'Ops crew trained on the new staging lane'] },
      { id: 'sl3', layout: 'big-number', title: 'Volume from week 3', stat: '1,200', statLabel: 'pallets a month for Meridian, on top of about 2,700 we already move', notes: 'Peak utilisation in the forecast is 109% in week 8. That is the number to discuss.' },
      { id: 'sl4', layout: 'two-column', title: 'Risks and owners', left: { heading: 'Risks', bullets: ['Forklift 3 out of service', 'Movers vendor not confirmed', 'Container delays at Pasir Panjang'] }, right: { heading: 'Owners', bullets: ['Arjun · vendor in today', 'Ashton · decide by Tue', 'Marcus · Tuesday crew'] } },
      { id: 'sl5', layout: 'bullets', title: 'Decisions today', bullets: ['Approve Kranji Movers if their insurance matches ours', 'Hire a spare forklift from 26 Oct to 30 Nov', 'Go or no-go for 2 Nov'] },
      { id: 'sl6', layout: 'quote', title: 'Meridian lines up with week 2.', subtitle: 'Priya, Q4 launch crew' },
    ],
  },
  {
    id: 'dk_allhands', title: 'All-hands · October', ownerId: 'u_huimin', folderId: 'f_people', editors: ['u_huimin', ME], commenters: 'org', theme: 'teal', access: 'org',
    updatedAt: at('2026-10-10T17:45'), updatedBy: 'u_huimin', presence: [],
    slides: [
      { id: 'sa1', layout: 'title', title: 'October all-hands', subtitle: 'Wed 14 Oct · 5:00 pm · Lounge and on Hearth' },
      { id: 'sa2', layout: 'big-number', title: 'Q3 in one number', stat: '98.6%', statLabel: 'of deliveries on time, our best quarter yet' },
      { id: 'sa3', layout: 'bullets', title: 'New leave policy from 1 Nov', bullets: ['18 days of annual leave for everyone, up from 14', 'Unused leave carries over up to 5 days', 'Ask HR Policy in #ask-hr for anything else'] },
      { id: 'sa4', layout: 'image', title: 'Welcome, Nadia', subtitle: 'Customer Success · joined Mon 12 Oct', imageHue: 230 },
      { id: 'sa5', layout: 'section', title: 'Questions', subtitle: 'Ask here or post in #announcements' },
    ],
  },
]

// ── Doc templates (DOC-08) ────────────────────────────────────────────────────
export const docTemplates: { id: DocTemplateId; name: string; blurb: string; emoji: string; blocks: (title: string, dayLabel: string) => DocBlock[] }[] = [
  { id: 'blank', name: 'Blank document', blurb: 'Start from an empty page', emoji: '📄', blocks: title => [{ type: 'h1', text: title }, { type: 'p', text: '' }] },
  {
    id: 'meeting-notes', name: 'Meeting notes', blurb: 'Agenda, decisions and action items', emoji: '🗒️',
    blocks: (title, day) => [
      { type: 'h1', text: title }, { type: 'p', text: `${day} · Attendees: ` },
      { type: 'h2', text: 'Agenda' }, { type: 'li', text: '' },
      { type: 'h2', text: 'Decisions' }, { type: 'li', text: '' },
      { type: 'h2', text: 'Action items' }, { type: 'todo', text: '', done: false },
    ],
  },
  {
    id: 'project-brief', name: 'Project brief', blurb: 'Goal, scope, timeline and owners', emoji: '🧭',
    blocks: title => [
      { type: 'h1', text: title }, { type: 'h2', text: 'Goal' }, { type: 'p', text: '' },
      { type: 'h2', text: 'Scope' }, { type: 'li', text: 'In: ' }, { type: 'li', text: 'Out: ' },
      { type: 'h2', text: 'Timeline' }, { type: 'li', text: '' },
      { type: 'h2', text: 'Owners' }, { type: 'li', text: '' },
      { type: 'h2', text: 'Open questions' }, { type: 'todo', text: '', done: false },
    ],
  },
  {
    id: 'policy', name: 'Policy page', blurb: 'Purpose, who it covers and the rules', emoji: '📘',
    blocks: (title, day) => [
      { type: 'h1', text: title }, { type: 'quote', text: `Effective from ${day}. Owner: ` },
      { type: 'h2', text: 'Purpose' }, { type: 'p', text: '' },
      { type: 'h2', text: 'Who this covers' }, { type: 'p', text: '' },
      { type: 'h2', text: 'The policy' }, { type: 'li', text: '' },
      { type: 'h2', text: 'Questions' }, { type: 'p', text: 'Ask in #ask-hr.' },
    ],
  },
  {
    id: 'onboarding', name: 'Onboarding guide', blurb: 'First-week checklist for a new joiner', emoji: '👋',
    blocks: title => [
      { type: 'h1', text: title }, { type: 'p', text: 'Welcome to Tembusu Logistics. Here is your first week.' },
      { type: 'h2', text: 'Day one' }, { type: 'todo', text: 'Sign in to Hearth with your phone number', done: false }, { type: 'todo', text: 'Say hello in #welcome', done: false },
      { type: 'h2', text: 'This week' }, { type: 'todo', text: 'Meet your buddy', done: false }, { type: 'todo', text: 'Read the safety runbook', done: false },
      { type: 'h2', text: 'People to know' }, { type: 'li', text: '' },
    ],
  },
]

// ── Docs that live in Ashton's own folders ───────────────────────────────────
export const myDocs: Doc[] = [
  {
    id: 'd_board', title: 'October board update (draft)', space: 'Board pack · October', folderId: 'f_board', access: 'restricted', ownerId: ME, editors: [ME], commenters: 'none',
    updatedAt: at('2026-10-11T21:30'), updatedBy: ME, lastOpenedAt: at('2026-10-11T21:30'), emoji: '📊', presence: [],
    blocks: [
      { type: 'h1', text: 'October board update (draft)' },
      { type: 'p', text: 'Q3 closed ahead of plan: revenue S$4.8M, 98.6% on-time deliveries and 81% warehouse utilisation.' },
      { type: 'h2', text: 'For the board' },
      { type: 'li', text: 'Meridian Foods goes live on 2 Nov, about 1,200 pallets a month from week 3' },
      { type: 'li', text: 'Cold-room capacity is tight in December; options in the Q4 pallet forecast' },
      { type: 'h2', text: 'Still to do' },
      { type: 'todo', text: 'Add the Q3 results summary', done: true },
      { type: 'todo', text: 'Confirm the movers vendor', done: false },
    ],
    versions: [{ id: 'vb1', authorId: ME, ts: at('2026-10-11T21:30'), summary: 'Created from Project brief' }],
    comments: [],
  },
]
