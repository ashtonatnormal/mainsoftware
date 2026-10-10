import type { CalendarEvent, Room, Session } from '../types'
import { at, minutesAgo } from '../time'

export const rooms: Room[] = [
  { id: 'r_ops', name: 'Ops standup', conversationId: 'c_ops', isPublic: true, participants: ['u_priya', 'u_marcus', 'u_farah'], sessionStartedAt: at('2026-10-12T08:30'), speakingId: 'u_priya' },
  { id: 'r_design', name: 'Design', conversationId: 'c_design', isPublic: true, participants: ['u_daniel', 'u_rachel'], sessionStartedAt: minutesAgo(4), speakingId: 'u_daniel', screenShareBy: 'u_daniel' },
  { id: 'r_lounge', name: 'Lounge', isPublic: true, participants: ['u_kelvin'] },
  { id: 'r_sales', name: 'Sales floor', conversationId: 'c_sales', isPublic: true, participants: [] },
  { id: 'r_people', name: 'People 1:1s', isPublic: false, restricted: true, participants: [] },
  { id: 'r_q4', name: 'Q4 launch review', isPublic: false, participants: [] },
]

export const sessions: Session[] = [
  {
    id: 's_pricing',
    title: 'Q3 pricing review',
    roomId: 'r_sales',
    conversationId: 'c_sales',
    meetingId: 'e_pricing',
    startedAt: at('2026-10-09T16:00'),
    durationSec: 34 * 60 + 12,
    participants: ['u_ashton', 'u_weiling', 'u_ahmad', 'u_rachel'],
    viewedBy: [
      { personId: 'u_weiling', at: at('2026-10-09T17:10') },
      { personId: 'u_ahmad', at: at('2026-10-09T18:02') },
      { personId: 'u_rachel', at: at('2026-10-12T08:12') },
    ],
    transcript: [
      { speakerId: 'u_ashton', startSec: 4, endSec: 19, text: 'Okay, let’s start. The question for today is whether we move list prices for Q4 or hold them.' },
      { speakerId: 'u_weiling', startSec: 21, endSec: 58, text: 'Margins are down about one and a half points since July, mostly fuel and the new cold-room lease. If we hold, we need volume to make it back.' },
      { speakerId: 'u_ahmad', startSec: 60, endSec: 96, text: 'Meridian is about to sign, twelve hundred pallets a month. If we raise prices now we put that at risk, and two other accounts are shopping around.' },
      { speakerId: 'u_rachel', startSec: 98, endSec: 131, text: 'Customers keep asking about volume discounts. A tier above two hundred pallets a month would land well with the mid-size accounts.' },
      { speakerId: 'u_weiling', startSec: 134, endSec: 171, text: 'A five percent tier above two hundred pallets still works if utilisation goes above eighty percent. I ran it on last quarter’s numbers.' },
      { speakerId: 'u_ashton', startSec: 174, endSec: 196, text: 'So hold list prices for Q4, and introduce the five percent tier above two hundred pallets a month. Any objections?' },
      { speakerId: 'u_ahmad', startSec: 198, endSec: 205, text: 'None from sales.' },
      { speakerId: 'u_weiling', startSec: 207, endSec: 226, text: 'Agreed. I’ll update the price sheet with the tier by Wednesday.' },
      { speakerId: 'u_ahmad', startSec: 229, endSec: 252, text: 'I’ll brief our top ten accounts this week before the email goes out.' },
      { speakerId: 'u_rachel', startSec: 255, endSec: 276, text: 'And I’ll draft the customer email. Should we mention fuel surcharges?' },
      { speakerId: 'u_ashton', startSec: 279, endSec: 305, text: 'Let’s leave fuel surcharges out for now and revisit in January. Can someone own sharing a summary with the board?' },
      { speakerId: 'u_weiling', startSec: 307, endSec: 318, text: 'Probably best coming from you, Ashton.' },
      { speakerId: 'u_ashton', startSec: 320, endSec: 333, text: 'Fair. I’ll send it by Friday.' },
      { speakerId: 'u_rachel', startSec: 336, endSec: 349, text: 'Boleh, I’ll loop in the account managers too.', nonEnglish: false },
    ],
    notes: {
      summary: 'The team reviewed Q4 pricing against falling margins and the pending Meridian Foods contract, and agreed to hold list prices while adding a volume tier.',
      decisions: [
        'Hold list prices for Q4.',
        'Introduce a 5% discount tier above 200 pallets a month.',
        'Leave fuel surcharges out of customer communication until January.',
      ],
      actionItems: [
        { id: 'ai_p1', text: 'Update the price sheet with the new volume tier', ownerId: 'u_weiling', due: 'Wed 14 Oct', passageIndex: 7 },
        { id: 'ai_p2', text: 'Brief the top 10 accounts before the email goes out', ownerId: 'u_ahmad', due: 'Thu 15 Oct', passageIndex: 8 },
        { id: 'ai_p3', text: 'Draft the price-change email to customers', ownerId: 'u_rachel', due: 'Wed 14 Oct', passageIndex: 9 },
        { id: 'ai_p4', text: 'Share a Q3 pricing summary with the board', ownerId: 'u_ashton', due: 'Fri 16 Oct', passageIndex: 12 },
      ],
      openQuestions: ['Revisit fuel surcharges in January?'],
    },
  },
  {
    id: 's_standup_fri',
    title: 'Ops standup',
    roomId: 'r_ops',
    conversationId: 'c_ops',
    startedAt: at('2026-10-09T09:30'),
    durationSec: 12 * 60 + 40,
    participants: ['u_priya', 'u_marcus', 'u_farah', 'u_ashton'],
    viewedBy: [{ personId: 'u_marcus', at: at('2026-10-09T10:05') }],
    transcript: [
      { speakerId: 'u_priya', startSec: 3, endSec: 20, text: 'Morning. Quick one today: inbound, the weekend, and the forklift situation.' },
      { speakerId: 'u_marcus', startSec: 22, endSec: 61, text: 'Inbound is on plan. If the Pasir Panjang container slips again we’ll need overtime on Saturday for unloading.' },
      { speakerId: 'u_farah', startSec: 63, endSec: 90, text: 'Forklift 3 was noisy again yesterday. I’ll keep an eye on it and tag it out if it gets worse.' },
      { speakerId: 'u_ashton', startSec: 93, endSec: 118, text: 'If we need Saturday overtime, send me the roster and I’ll approve it on Monday morning.' },
      { speakerId: 'u_priya', startSec: 120, endSec: 141, text: 'And I’m chasing a second quote for the movers contract. Should have it tonight.' },
    ],
    notes: {
      summary: 'Inbound is on plan. Saturday overtime may be needed if the Pasir Panjang container slips again, and forklift 3 is being watched.',
      decisions: ['Saturday overtime goes ahead if the container slips; Ashton approves the roster Monday morning.'],
      actionItems: [
        { id: 'ai_s1', text: 'Send the Saturday overtime roster to Ashton if needed', ownerId: 'u_marcus', due: 'Sun 11 Oct', passageIndex: 1 },
        { id: 'ai_s2', text: 'Approve the Saturday overtime roster', ownerId: 'u_ashton', due: 'Today 12:00 pm', passageIndex: 3 },
        { id: 'ai_s3', text: 'Get a second quote for the movers contract', ownerId: 'u_priya', due: 'Fri 9 Oct', passageIndex: 4 },
      ],
      openQuestions: [],
    },
  },
  {
    id: 's_design_short',
    title: 'Design room',
    roomId: 'r_design',
    conversationId: 'c_design',
    startedAt: at('2026-10-09T15:07'),
    durationSec: 3 * 60 + 5,
    participants: ['u_daniel', 'u_rachel'],
    viewedBy: [],
    transcript: [
      { speakerId: 'u_daniel', startSec: 2, endSec: 14, text: 'Hey, have you got a minute for the colour of the delivery status chips?' },
      { speakerId: 'u_rachel', startSec: 15, endSec: 40, text: 'Sure. Customers mostly care whether it’s late, so make late the loud one and keep the rest calm.' },
      { speakerId: 'u_daniel', startSec: 42, endSec: 55, text: 'Makes sense, I’ll try that. Thanks!' },
    ],
  },
]

/** Script for the live Ops standup the demo user can join (J2/J3). Leaving creates this session. */
export const opsStandupScript = {
  lines: [
    { speakerId: 'u_priya', text: 'Okay, Ashton’s joined. We were on the forklift.' },
    { speakerId: 'u_farah', text: 'Forklift 3 is tagged out. We’re on two, so I moved cold-room picks to the morning.' },
    { speakerId: 'u_marcus', text: 'The vendor can come at 2 pm, but the repair quote might be over two thousand.' },
    { speakerId: 'u_priya', text: 'Ashton, can you sign off the repair if it’s over two thousand?' },
    { speakerId: 'u_ashton', text: 'Yes, send it to me as soon as you have it.' },
    { speakerId: 'u_marcus', text: 'And I’ll tell the unloading crew about Saturday once the roster is approved.' },
    { speakerId: 'u_farah', text: 'I’ll re-slot Tuesday’s unloading for the container.' },
  ],
  notes: {
    summary: 'Forklift 3 is out of service and the vendor visits at 2 pm. Cold-room picks moved to mornings. Saturday overtime goes ahead once Ashton approves the roster.',
    decisions: ['Repairs over S$2,000 on forklift 3 need Ashton’s sign-off.', 'Cold-room picks move to the morning shift while forklift 3 is out.'],
    actionItems: [
      { id: 'ai_m1', text: 'Sign off the forklift 3 repair quote if it’s over S$2,000', ownerId: 'u_ashton', due: 'Today' },
      { id: 'ai_m2', text: 'Tell the unloading crew about Saturday overtime', ownerId: 'u_marcus', due: 'Today' },
      { id: 'ai_m3', text: 'Re-slot Tuesday’s unloading for the delayed container', ownerId: 'u_farah', due: 'Tue 13 Oct' },
    ],
    openQuestions: ['Do we need a spare forklift for the Meridian ramp-up?'],
  },
}

export const events: CalendarEvent[] = [
  { id: 'e_pricing', title: 'Q3 pricing review', start: at('2026-10-09T16:00'), end: at('2026-10-09T16:45'), attendees: ['u_ashton', 'u_weiling', 'u_ahmad', 'u_rachel'], roomId: 'r_sales', agenda: ['Margins since July', 'Q4 list prices', 'Volume tier'], rsvp: 'yes', sessionId: 's_pricing' },
  { id: 'e_standup', title: 'Ops standup', start: at('2026-10-12T08:30'), end: at('2026-10-12T08:45'), attendees: ['u_ashton', 'u_priya', 'u_marcus', 'u_farah'], roomId: 'r_ops', agenda: ['Inbound', 'Forklift 3', 'Weekend cover'], rsvp: 'yes' },
  { id: 'e_priya', title: '1:1 Priya', start: at('2026-10-12T11:00'), end: at('2026-10-12T11:30'), attendees: ['u_ashton', 'u_priya'], agenda: ['Movers vendor decision', 'Meridian ramp-up staffing'], rsvp: 'yes' },
  {
    id: 'e_q4', title: 'Q4 launch review', start: at('2026-10-12T15:00'), end: at('2026-10-12T16:00'), attendees: ['u_ashton', 'u_priya', 'u_daniel', 'u_ahmad', 'u_weiling'], roomId: 'r_q4', rsvp: 'yes',
    agenda: ['Timeline v3 walkthrough (Daniel)', 'Meridian onboarding in week 2 (Ahmad)', 'Budget and the volume tier (Wei Ling)', 'Go / no-go for 2 Nov'],
    prep: {
      related: [
        { label: 'Q4 Launch Proposal (updated Fri)', kind: 'doc', route: { name: 'docs', docId: 'd_q4' } },
        { label: 'Q4 launch review deck (Daniel, Sun)', kind: 'slides', route: { name: 'slides', deckId: 'dk_q4' } },
        { label: 'Q4 pallet forecast · peaks at 109% in week 8', kind: 'sheet', route: { name: 'sheets', sheetId: 'sh_forecast' } },
        { label: 'Q4 launch crew: “Meridian lines up with week 2”', kind: 'message', route: { name: 'chats', conversationId: 'g_q4' } },
        { label: 'Q3 pricing review notes', kind: 'session', route: { name: 'session', sessionId: 's_pricing' } },
      ],
      openItems: ['Movers vendor decision (you, due Tue)', 'Price sheet with the volume tier (Wei Ling, due Wed)', 'Your review of the Q4 Launch Proposal (due Wed)'],
      lastNotes: 'Last time (Q3 pricing review): list prices held for Q4, 5% tier above 200 pallets/month, fuel surcharges deferred to January.',
    },
  },
  { id: 'e_vendor', title: 'Kranji Movers call', start: at('2026-10-13T10:00'), end: at('2026-10-13T10:30'), attendees: ['u_ashton', 'u_priya'], agenda: ['Insurance cover', 'Start date'], rsvp: 'pending' },
  { id: 'e_allhands', title: 'All-hands', start: at('2026-10-14T17:00'), end: at('2026-10-14T17:45'), attendees: ['u_ashton', 'u_priya', 'u_huimin', 'u_marcus', 'u_farah', 'u_weiling', 'u_ahmad', 'u_rachel', 'u_daniel', 'u_arjun', 'u_kelvin', 'u_nadia'], agenda: ['Meridian Foods', 'New leave policy', 'Welcome Nadia'], rsvp: 'yes' },
  { id: 'e_leave', title: 'Daniel on leave', start: at('2026-10-16T00:00'), end: at('2026-10-16T23:59'), attendees: ['u_daniel'], agenda: [], rsvp: 'yes', kind: 'leave' },
]
