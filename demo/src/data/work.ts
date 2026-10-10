import type { Actionable, AskAnswer, DigestItem, Doc, InsightRow, Memory, SuggestedTask, Task } from '../types'
import { at, minutesAgo } from '../time'

export const tasks: Task[] = [
  { id: 't_ot', title: 'Approve the Saturday overtime roster', assigneeIds: ['u_ashton'], due: 'Today 12:00 pm', dueSoon: true, status: 'todo', priority: 'high', team: 'Operations', source: { kind: 'meeting', label: 'Ops standup · Fri 9 Oct', route: { name: 'session', sessionId: 's_standup_fri' } } },
  { id: 't_movers', title: 'Decide on the movers vendor', assigneeIds: ['u_ashton'], due: 'Tue 13 Oct', status: 'todo', team: 'Operations', source: { kind: 'message', label: 'DM with Priya', route: { name: 'chats', conversationId: 'dm_priya' } } },
  { id: 't_review', title: 'Review the Q4 Launch Proposal', assigneeIds: ['u_ashton'], due: 'Wed 14 Oct', status: 'doing', team: 'Q4 launch', source: { kind: 'message', label: 'Q4 launch crew', route: { name: 'docs', docId: 'd_q4' } }, comments: 2 },
  { id: 't_board', title: 'Prepare the October board pack', assigneeIds: ['u_ashton', 'u_weiling'], due: 'Fri 23 Oct', status: 'todo', team: 'Leadership', source: { kind: 'manual', label: 'Added by you' } },
  { id: 't_sheet', title: 'Update the price sheet with the volume tier', assigneeIds: ['u_weiling'], due: 'Wed 14 Oct', status: 'doing', team: 'Finance', source: { kind: 'meeting', label: 'Q3 pricing review · Fri 9 Oct', route: { name: 'session', sessionId: 's_pricing' } } },
  { id: 't_brief', title: 'Brief the top 10 accounts on Q4 pricing', assigneeIds: ['u_ahmad'], due: 'Thu 15 Oct', status: 'todo', team: 'Sales', source: { kind: 'meeting', label: 'Q3 pricing review · Fri 9 Oct', route: { name: 'session', sessionId: 's_pricing' } } },
  { id: 't_vendor', title: 'Book the forklift vendor visit', assigneeIds: ['u_arjun'], due: 'Today', status: 'doing', team: 'Operations', source: { kind: 'message', label: '#ops-north-site', route: { name: 'chats', conversationId: 'c_ops' } } },
  { id: 't_checklist', title: 'Send the day-one checklist to Nadia', assigneeIds: ['u_huimin'], due: 'Today', status: 'done', team: 'People', source: { kind: 'manual', label: 'Added by Hui Min' } },
  { id: 't_safety', title: 'Re-read the Woodlands DC safety runbook', assigneeIds: ['u_ashton'], status: 'done', team: 'Operations', source: { kind: 'manual', label: 'Added by you' } },
]

export const suggestedTasks: SuggestedTask[] = [
  { id: 'st_board', title: 'Share a Q3 pricing summary with the board', ownerId: 'u_ashton', due: 'Fri 16 Oct', source: { kind: 'meeting', label: 'Action item · Q3 pricing review', route: { name: 'session', sessionId: 's_pricing' } } },
  { id: 'st_priya', title: 'Reply to Priya about the movers quote', ownerId: 'u_ashton', due: 'Tue 13 Oct', source: { kind: 'assistant', label: 'Suggested by your assistant from your DM with Priya', route: { name: 'chats', conversationId: 'dm_priya' } } },
]

export const actionables: Actionable[] = [
  {
    id: 'act_priya', kind: 'reply',
    title: 'Priya is waiting on the movers decision',
    detail: 'She asked on Fri: Kranji Movers at S$18,400 vs S$21,000 now. She needs an answer by Tue to give notice.',
    route: { name: 'chats', conversationId: 'dm_priya' },
    draft: {
      conversationId: 'dm_priya',
      text: 'Thanks Priya. Let’s go with Kranji Movers if they can match our current insurance cover. Can you confirm that with them on tomorrow’s call?',
      memoryId: 'mem1', // "You prefer short replies that end with a clear decision."
      withoutMemory: 'Hi Priya, thanks for getting a second quote. Kranji Movers at S$18,400 against S$21,000 for the same scope looks like a good saving. Do you know if they can match our current insurance cover? Could you check on tomorrow’s call, and we can decide once we know?',
    },
    sources: [{ label: 'DM with Priya · Fri 7:20 pm', kind: 'message', route: { name: 'chats', conversationId: 'dm_priya' } }],
  },
  {
    id: 'act_ot', kind: 'action-item',
    title: 'Approve the Saturday overtime roster by 12 pm',
    detail: 'Your action item from Friday’s Ops standup. Marcus sent the roster (11 people) and a voice note this morning.',
    route: { name: 'tasks' },
    draft: {
      conversationId: 'dm_marcus',
      text: 'Approved, Marcus. Go ahead and tell the crew. Thanks for sorting it out so quickly.',
      memoryId: 'mem1',
      withoutMemory: 'Hi Marcus, thanks for sending the Saturday roster and the voice note. I’m happy to approve the overtime for the 11 people on it. Could you let the crew know, and tell me if anything changes before Saturday?',
    },
    sources: [
      { label: 'Ops standup notes · Fri 9 Oct', kind: 'session', route: { name: 'session', sessionId: 's_standup_fri' } },
      { label: 'Voice note from Marcus · 7:40 am', kind: 'message', route: { name: 'chats', conversationId: 'dm_marcus' } },
    ],
  },
  {
    id: 'act_q4', kind: 'prep',
    title: 'Q4 launch review at 3:00 pm',
    detail: 'Prep brief ready: the updated proposal, last week’s pricing decisions, and 3 open items between attendees.',
    route: { name: 'calendar', eventId: 'e_q4' },
  },
  {
    id: 'act_doc', kind: 'review',
    title: 'Daniel asked you to review the Q4 Launch Proposal',
    detail: '2 comments are waiting for you. Due Wednesday.',
    route: { name: 'docs', docId: 'd_q4' },
  },
]

export const digest: DigestItem[] = [
  { id: 'dg_ops', conversationId: 'c_ops', count: 6, text: 'Container delayed to Tue 6 am. Forklift 3 is out of service; vendor visit being booked for today.' },
  { id: 'dg_sales', conversationId: 'c_sales', count: 3, text: 'Meridian Foods signed for 3 years. Rachel is drafting the price-change email for Wednesday.' },
  { id: 'dg_hr', conversationId: 'c_askhr', count: 2, text: 'HR Policy answered a leave carry-over question; Hui Min confirmed it.' },
  { id: 'dg_announce', conversationId: 'c_announce', count: 1, text: 'Nadia Yusof joined Customer Success today.' },
]

export const askAnswers: AskAnswer[] = [
  {
    id: 'ask_movers', keywords: ['mover', 'movers', 'vendor', 'kranji', 'quote'],
    question: 'Who owns the movers vendor decision and what’s the latest?',
    answer: 'Priya Nair owns it, and the decision is waiting on you [1]. On Friday she got a second quote: Kranji Movers at S$18,400 against S$21,000 from the current vendor, same scope [1]. She asked for a decision by Tuesday so she can give two weeks’ notice, and there’s a call with Kranji Movers on Tue at 10:00 am [2].',
    sources: [
      { label: 'DM with Priya · Fri 9 Oct', kind: 'message', route: { name: 'chats', conversationId: 'dm_priya' } },
      { label: 'Kranji Movers call · Tue 13 Oct', kind: 'event', route: { name: 'calendar', eventId: 'e_vendor' } },
    ],
  },
  {
    id: 'ask_pricing', keywords: ['pricing', 'price', 'prices', 'tier', 'q3', 'q4 pricing'],
    question: 'What did we decide about Q4 pricing?',
    answer: 'In Friday’s Q3 pricing review you decided to hold list prices for Q4 and add a 5% discount tier above 200 pallets a month [1]. Fuel surcharges stay out of customer emails until January [1]. Wei Ling is updating the price sheet by Wednesday [2], and Rachel is drafting the customer email [3].',
    sources: [
      { label: 'Q3 pricing review · Fri 9 Oct', kind: 'session', route: { name: 'session', sessionId: 's_pricing' } },
      { label: 'Task: Update the price sheet', kind: 'task', route: { name: 'tasks' } },
      { label: 'Rachel in #sales · today', kind: 'message', route: { name: 'chats', conversationId: 'c_sales' } },
    ],
  },
  {
    id: 'ask_leave', keywords: ['leave', 'carry', 'holiday', 'annual'],
    question: 'How many leave days can people carry over?',
    answer: 'From 1 Nov 2026, up to 5 unused days of annual leave carry over into the next year [1]. Anything above 5 days lapses on 31 Dec unless a manager approves an exception in writing [1]. Hui Min announced the change on Friday [2].',
    sources: [
      { label: 'Leave Policy · HR wiki', kind: 'doc', route: { name: 'docs', docId: 'd_leave' } },
      { label: 'Hui Min in #announcements', kind: 'message', route: { name: 'chats', conversationId: 'c_announce' } },
    ],
  },
  {
    id: 'ask_forklift', keywords: ['forklift', 'repair', 'maintenance'],
    question: 'What’s happening with forklift 3?',
    answer: 'Farah tagged forklift 3 out of service this morning after it started grinding again, so the site is on two forklifts and cold-room picks moved to the morning shift [1]. Priya asked Arjun to get the vendor in today [2], and Arjun has a task to book the visit [3].',
    sources: [
      { label: 'Farah’s voice note · 7:55 am', kind: 'message', route: { name: 'chats', conversationId: 'c_ops' } },
      { label: 'Priya in #ops-north-site · 8:02 am', kind: 'message', route: { name: 'chats', conversationId: 'c_ops' } },
      { label: 'Task: Book the forklift vendor visit', kind: 'task', route: { name: 'tasks' } },
    ],
  },
  {
    id: 'ask_restricted', keywords: ['performance', 'review of marcus', 'appraisal', 'salary', 'disciplinary'],
    question: 'What was said in Marcus’s performance review?',
    answer: 'I can’t see that. Performance conversations happen in a restricted room, and only the people who were there (and audited compliance access) can open them. If you were a participant, open the session from its page and ask me about it there.',
    sources: [],
  },
]

export const askFallback = 'I couldn’t find anything about that in the messages, meetings, docs and tasks you can open. Try different words, or ask a person in #ops-north-site or #ask-hr.'

export const askSuggestions = [
  'What did we decide about Q4 pricing?',
  'Who owns the movers vendor decision?',
  'What’s happening with forklift 3?',
  'How many leave days can people carry over?',
]

export const docs: Doc[] = [
  {
    id: 'd_q4', title: 'Q4 Launch Proposal', space: 'Q4 launch', ownerId: 'u_priya', editors: ['u_priya', 'u_ashton'], commenters: 'team', updatedAt: at('2026-10-09T15:28'), emoji: '🚀',
    presence: ['u_priya', 'u_daniel'],
    blocks: [
      { type: 'h1', text: 'Q4 Launch Proposal' },
      { type: 'p', text: 'We launch the Meridian Foods programme on 2 Nov with dedicated cold-room capacity at Woodlands DC and next-day delivery across the island.' },
      { type: 'h2', text: 'Timeline (v3)' },
      { type: 'li', text: 'Week 1 (2–6 Nov): cold-room racking and staff training' },
      { type: 'li', text: 'Week 2 (9–13 Nov): Meridian onboarding, first 300 pallets' },
      { type: 'li', text: 'Week 3 onward: full volume, about 1,200 pallets a month' },
      { type: 'h2', text: 'What we need' },
      { type: 'todo', text: 'Movers vendor confirmed for the racking move', done: false },
      { type: 'todo', text: 'Price sheet with the new volume tier', done: false },
      { type: 'todo', text: 'Two extra forklift operators on the night shift', done: true },
      { type: 'h2', text: 'Risks' },
      { type: 'p', text: 'Forklift capacity is the main risk. With one forklift out, picking slows by about 30%. We should line up a spare for the ramp-up.' },
      { type: 'quote', text: 'Decision needed at the 12 Oct review: go / no-go for 2 Nov.' },
    ],
    versions: [
      { id: 'v3', authorId: 'u_daniel', ts: at('2026-10-09T15:28'), summary: 'Timeline v3 and the forklift risk', added: ['Week 2 (9–13 Nov): Meridian onboarding, first 300 pallets', 'Forklift capacity is the main risk.'], removed: ['Week 2 (9–13 Nov): staff training continues'] },
      { id: 'v2', authorId: 'u_priya', ts: at('2026-10-07T11:02'), summary: 'Added “What we need”', added: ['Movers vendor confirmed for the racking move', 'Price sheet with the new volume tier'] },
      { id: 'v1', authorId: 'u_priya', ts: at('2026-10-05T09:40'), summary: 'First draft' },
    ],
    comments: [
      { id: 'cm1', authorId: 'u_daniel', ts: at('2026-10-09T15:31'), anchor: 'first 300 pallets', text: 'Ashton, is 300 realistic for week 2 with one forklift out?', replies: [{ authorId: 'u_priya', text: 'Only if the vendor fixes forklift 3 this week.', ts: at('2026-10-09T16:02') }] },
      { id: 'cm2', authorId: 'u_ahmad', ts: at('2026-10-09T17:50'), anchor: 'next-day delivery across the island', text: 'Meridian asked whether Sentosa is included. Can we confirm?' },
    ],
  },
  {
    id: 'd_leave', title: 'Leave Policy', space: 'HR wiki', ownerId: 'u_huimin', editors: ['u_huimin'], commenters: 'org', updatedAt: at('2026-10-09T16:55'), emoji: '🌴', presence: [],
    blocks: [
      { type: 'h1', text: 'Leave Policy' },
      { type: 'p', text: 'This policy applies to all permanent staff from 1 Nov 2026.' },
      { type: 'h2', text: 'Annual leave' },
      { type: 'li', text: '14 days a year, plus 1 day for every 2 years of service, up to 21 days.' },
      { type: 'h2', text: 'Carry-over' },
      { type: 'li', text: 'You can carry over up to 5 unused days into the next year.' },
      { type: 'li', text: 'Days above 5 lapse on 31 Dec unless your manager approves an exception in writing.' },
      { type: 'h2', text: 'How to apply' },
      { type: 'p', text: 'Add a leave event in Calendar and tag your manager. Leave shows on your team calendar automatically.' },
    ],
    versions: [
      { id: 'lv2', authorId: 'u_huimin', ts: at('2026-10-09T16:55'), summary: 'Carry-over capped at 5 days', added: ['You can carry over up to 5 unused days into the next year.'], removed: ['You can carry over up to 10 unused days into the next year.'] },
      { id: 'lv1', authorId: 'u_huimin', ts: at('2025-12-01T10:00'), summary: '2026 policy' },
    ],
    comments: [],
  },
  {
    id: 'd_runbook', title: 'Woodlands DC safety runbook', space: 'Ops wiki', ownerId: 'u_marcus', editors: ['u_marcus', 'u_priya', 'u_farah'], commenters: 'org', updatedAt: at('2026-09-28T14:20'), emoji: '🦺', presence: [],
    blocks: [
      { type: 'h1', text: 'Woodlands DC safety runbook' },
      { type: 'h2', text: 'Forklifts' },
      { type: 'li', text: 'Tag a forklift out of service at the first sign of a mechanical fault and post in #ops-north-site.' },
      { type: 'li', text: 'Only certified operators drive forklifts. Certificates are checked every quarter.' },
      { type: 'h2', text: 'Cold room' },
      { type: 'li', text: 'Maximum 20 minutes inside at a time; always work in pairs.' },
    ],
    versions: [{ id: 'rv1', authorId: 'u_marcus', ts: at('2026-09-28T14:20'), summary: 'Cold-room pairs rule' }],
    comments: [],
  },
  {
    id: 'd_checklist', title: 'Day-one checklist', space: 'People', ownerId: 'u_huimin', editors: ['u_huimin'], commenters: 'org', updatedAt: minutesAgo(50), emoji: '✅', presence: ['u_nadia'],
    blocks: [
      { type: 'h1', text: 'Day-one checklist' },
      { type: 'todo', text: 'Sign in to Hearth with your phone number and set your PIN', done: true },
      { type: 'todo', text: 'Read the privacy and recording notice', done: true },
      { type: 'todo', text: 'Add Hearth to your home screen and turn on notifications', done: false },
      { type: 'todo', text: 'Say hi in #welcome', done: false },
    ],
    versions: [{ id: 'cv1', authorId: 'u_huimin', ts: minutesAgo(50), summary: 'Updated for Hearth' }],
    comments: [],
  },
]

export const memories: Memory[] = [
  { id: 'mem1', text: 'You prefer short replies that end with a clear decision.', learnedFrom: 'Your messages over the last month' },
  { id: 'mem2', text: 'You’re working on the Q4 launch with Priya, Daniel and Ahmad.', learnedFrom: 'Q4 launch crew group' },
  { id: 'mem3', text: 'You’re Tembusu Logistics’ Data Protection Officer.', learnedFrom: 'You told me on 10 Oct' },
  { id: 'mem4', text: 'Your working hours are 8:30 am to 6 pm, Monday to Friday.', learnedFrom: 'Your profile' },
]

// People insights (ADM-14) for 5–9 Oct. Counts and durations only; no AI scoring.
export const insights: InsightRow[] = [
  { personId: 'u_priya', messages: 214, reactions: 96, talkMin: 186, roomMin: 642, meetings: 14, tasksDone: 11 },
  { personId: 'u_marcus', messages: 158, reactions: 41, talkMin: 233, roomMin: 701, meetings: 9, tasksDone: 8 },
  { personId: 'u_farah', messages: 97, reactions: 63, talkMin: 121, roomMin: 512, meetings: 7, tasksDone: 13 },
  { personId: 'u_ahmad', messages: 176, reactions: 88, talkMin: 204, roomMin: 388, meetings: 16, tasksDone: 6 },
  { personId: 'u_rachel', messages: 131, reactions: 120, talkMin: 142, roomMin: 296, meetings: 12, tasksDone: 9 },
  { personId: 'u_weiling', messages: 64, reactions: 22, talkMin: 58, roomMin: 140, meetings: 8, tasksDone: 10 },
  { personId: 'u_daniel', messages: 112, reactions: 74, talkMin: 97, roomMin: 455, meetings: 6, tasksDone: 7 },
  { personId: 'u_huimin', messages: 143, reactions: 101, talkMin: 110, roomMin: 230, meetings: 11, tasksDone: 12 },
  { personId: 'u_arjun', messages: 88, reactions: 19, talkMin: 46, roomMin: 120, meetings: 4, tasksDone: 15 },
  { personId: 'u_kelvin', messages: 23, reactions: 12, talkMin: 31, roomMin: 160, meetings: 2, tasksDone: 4 },
  { personId: 'u_ashton', messages: 190, reactions: 77, talkMin: 165, roomMin: 360, meetings: 18, tasksDone: 9 },
]
