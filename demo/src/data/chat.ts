import type { Conversation, Message } from '../types'
import { at, minutesAgo } from '../time'

export const conversations: Conversation[] = [
  { id: 'c_assistant', kind: 'assistant', name: 'Assistant', members: ['u_ashton', 'as_me'], pinned: true, unread: 0, lastActivity: at('2026-10-12T07:30') },
  { id: 'c_ops', kind: 'channel', name: 'ops-north-site', topic: 'Woodlands DC day-to-day. Standup 8:30 am in the room.', members: ['u_ashton', 'u_priya', 'u_marcus', 'u_farah', 'u_arjun', 'u_kelvin'], roomId: 'r_ops', unread: 6, mentions: 1, participation: 'suggest', lastActivity: minutesAgo(12) },
  { id: 'dm_priya', kind: 'dm', name: 'Priya Nair', members: ['u_ashton', 'u_priya'], unread: 1, lastActivity: at('2026-10-09T19:20') },
  { id: 'dm_marcus', kind: 'dm', name: 'Marcus Ong', members: ['u_ashton', 'u_marcus'], unread: 1, lastActivity: minutesAgo(62) },
  { id: 'c_askhr', kind: 'channel', name: 'ask-hr', topic: 'Questions about leave, benefits and policies. HR Policy answers here.', members: ['u_ashton', 'u_huimin', 'u_farah', 'u_marcus', 'u_nadia', 'u_priya'], unread: 2, participation: 'suggest', lastActivity: minutesAgo(35) },
  { id: 'c_sales', kind: 'channel', name: 'sales', topic: 'Deals, pricing and customer updates', members: ['u_ashton', 'u_ahmad', 'u_rachel', 'u_weiling'], roomId: 'r_sales', unread: 3, participation: 'mention', lastActivity: minutesAgo(27) },
  { id: 'c_announce', kind: 'channel', name: 'announcements', topic: 'Company-wide news. Everyone is a member.', members: ['u_ashton', 'u_huimin', 'u_priya', 'u_marcus', 'u_farah', 'u_weiling', 'u_ahmad', 'u_rachel', 'u_daniel', 'u_arjun', 'u_kelvin', 'u_nadia'], unread: 1, participation: 'off', lastActivity: minutesAgo(42) },
  { id: 'c_design', kind: 'channel', name: 'design', topic: 'Product and brand design. Drop into the room any time.', members: ['u_ashton', 'u_daniel', 'u_rachel', 'u_priya'], roomId: 'r_design', unread: 0, participation: 'mention', lastActivity: minutesAgo(4) },
  { id: 'g_q4', kind: 'group', name: 'Q4 launch crew', members: ['u_ashton', 'u_priya', 'u_daniel', 'u_ahmad'], unread: 0, lastActivity: at('2026-10-09T17:45') },
  { id: 'c_leadership', kind: 'channel', name: 'leadership', private: true, topic: 'Leadership team. Weekly Digest posts here every Monday.', members: ['u_ashton', 'u_priya', 'u_weiling', 'u_ahmad', 'u_huimin', 'a_digest'], unread: 0, participation: 'active', lastActivity: at('2026-10-12T07:00') },
  { id: 'c_welcome', kind: 'channel', name: 'welcome', topic: 'Say hello to new joiners', members: ['u_ashton', 'u_huimin', 'u_nadia', 'u_priya', 'u_daniel', 'a_onboard'], unread: 0, participation: 'mention', lastActivity: minutesAgo(40) },
  { id: 'ag_it', kind: 'agent', name: 'IT Helpdesk', members: ['u_ashton', 'a_it'], unread: 0, lastActivity: at('2026-10-08T16:12') },
  { id: 'c_it', kind: 'channel', name: 'it-help', topic: 'Laptops, printers, accounts. IT Helpdesk answers here.', members: ['u_ashton', 'u_arjun', 'u_marcus', 'u_farah', 'a_it'], unread: 0, participation: 'suggest', lastActivity: at('2026-10-09T10:05') },
]

const WAVE_A = [0.2, 0.5, 0.8, 0.6, 0.3, 0.7, 0.9, 0.5, 0.4, 0.6, 0.8, 0.3, 0.2, 0.5, 0.7, 0.9, 0.6, 0.4, 0.3, 0.6, 0.8, 0.5, 0.3, 0.2, 0.4, 0.7, 0.5, 0.3, 0.6, 0.4]
const WAVE_B = [0.3, 0.4, 0.7, 0.9, 0.6, 0.4, 0.5, 0.8, 0.6, 0.3, 0.2, 0.4, 0.6, 0.9, 0.7, 0.5, 0.3, 0.5, 0.7, 0.4, 0.3, 0.6, 0.8, 0.5, 0.2, 0.3, 0.5, 0.4, 0.2, 0.3]

export const messages: Message[] = [
  // ── #ops-north-site ─────────────────────────────────────────────
  { id: 'm_ops_1', conversationId: 'c_ops', authorId: 'u_ashton', kind: 'notes', sessionId: 's_standup_fri', ts: at('2026-10-09T09:44') },
  { id: 'm_ops_2', conversationId: 'c_ops', authorId: 'u_marcus', kind: 'text', ts: at('2026-10-11T21:10'), text: 'Heads up: the container from Pasir Panjang is delayed to Tue 6 am. Moving the Monday unloading crew to Tuesday.', reactions: [{ emoji: '👍', by: ['u_priya', 'u_farah'] }] },
  { id: 'm_ops_3', conversationId: 'c_ops', authorId: 'u_farah', kind: 'voice', ts: at('2026-10-12T07:55'), voice: { durationSec: 31, waveform: WAVE_A, transcript: "Morning all. Forklift 3 is making that grinding noise again so I've tagged it out of service. We're on two forklifts until it's fixed. I've moved the cold-room picks to the morning shift." } },
  { id: 'm_ops_4', conversationId: 'c_ops', authorId: 'u_priya', kind: 'text', ts: at('2026-10-12T08:02'), text: 'Thanks Farah. @Arjun can we get the vendor in today? Two forklifts is tight with the Meridian volumes starting.', threadCount: 3, threadPreview: ['u_arjun', 'u_marcus'] },
  { id: 'm_ops_5', conversationId: 'c_ops', authorId: 'u_marcus', kind: 'file', ts: at('2026-10-12T08:20'), text: 'Saturday overtime roster is in. 11 people, mostly the unloading crew because of the container delay. Needs @Ashton’s OK by 12 pm please 🙏', file: { name: 'OT roster – Sat 17 Oct.pdf', size: '84 KB', type: 'pdf' } },
  { id: 'm_ops_6', conversationId: 'c_ops', authorId: 'u_priya', kind: 'system', ts: at('2026-10-12T08:30'), text: 'Priya, Marcus and Farah are in the Ops standup room · recording' },

  // ── DM Priya ────────────────────────────────────────────────────
  { id: 'm_pr_1', conversationId: 'dm_priya', authorId: 'u_ashton', kind: 'text', ts: at('2026-10-09T11:02'), text: 'Sure, send me both quotes when you have them.', readBy: ['u_priya'] },
  { id: 'm_pr_2', conversationId: 'dm_priya', authorId: 'u_priya', kind: 'file', ts: at('2026-10-09T19:18'), text: 'Second quote is in.', file: { name: 'Kranji Movers – quote.pdf', size: '212 KB', type: 'pdf' } },
  { id: 'm_pr_3', conversationId: 'dm_priya', authorId: 'u_priya', kind: 'text', ts: at('2026-10-09T19:20'), text: 'Kranji Movers come in at S$18,400 against S$21,000 from our current vendor, same scope. Can we decide by Tuesday? I need to give the current vendor two weeks’ notice.' },

  // ── DM Marcus (voice note from the warehouse floor) ─────────────
  { id: 'm_mo_1', conversationId: 'dm_marcus', authorId: 'u_ashton', kind: 'text', ts: at('2026-10-08T17:30'), text: 'Thanks for covering the late shift yesterday, Marcus.', readBy: ['u_marcus'], reactions: [{ emoji: '🙏', by: ['u_marcus'] }] },
  { id: 'm_mo_2', conversationId: 'dm_marcus', authorId: 'u_marcus', kind: 'voice', ts: at('2026-10-12T07:40'), voice: { durationSec: 42, waveform: WAVE_B, transcript: "Hi Ashton, quick one from site. The Saturday OT roster is ready, eleven people, mostly the unloading crew because of the container delay. Can you approve before noon so I can tell them today? Thanks." } },

  // ── #ask-hr (HR Policy suggest card, J5) ────────────────────────
  { id: 'm_hr_1', conversationId: 'c_askhr', authorId: 'u_farah', kind: 'text', ts: at('2026-10-12T08:05'), text: 'Hi all, how many leave days can I carry over into next year?' },
  {
    id: 'm_hr_2', conversationId: 'c_askhr', authorId: 'a_hr', kind: 'suggest', ts: at('2026-10-12T08:05'),
    suggestion: {
      agentId: 'a_hr',
      teaser: 'HR Policy has an answer from the Leave Policy page',
      answer: 'From 1 Nov 2026 you can carry over up to 5 unused days of annual leave into next year [1]. Anything above 5 days lapses on 31 Dec unless your manager approves an exception in writing [1]. The change was announced on Fri [2].',
      sources: [
        { label: 'Leave Policy · HR wiki', kind: 'doc', route: { name: 'docs', docId: 'd_leave' } },
        { label: 'Hui Min in #announcements', kind: 'message', route: { name: 'chats', conversationId: 'c_announce' } },
      ],
    },
  },
  { id: 'm_hr_3', conversationId: 'c_askhr', authorId: 'u_huimin', kind: 'text', ts: at('2026-10-12T08:07'), text: 'That’s right 👆 Farah, ping me if you need an exception for the year-end peak.', reactions: [{ emoji: '🙏', by: ['u_farah'] }] },

  // ── #sales ──────────────────────────────────────────────────────
  { id: 'm_sa_1', conversationId: 'c_sales', authorId: 'u_ashton', kind: 'notes', sessionId: 's_pricing', ts: at('2026-10-09T16:38') },
  { id: 'm_sa_2', conversationId: 'c_sales', authorId: 'u_ahmad', kind: 'text', ts: at('2026-10-09T18:30'), text: 'Signed! Meridian Foods, 3-year contract, about 1,200 pallets a month starting 2 Nov 🎉', reactions: [{ emoji: '🎉', by: ['u_ashton', 'u_rachel', 'u_weiling', 'u_priya', 'u_daniel'] }, { emoji: '🔥', by: ['u_rachel'] }], threadCount: 5, threadPreview: ['u_rachel', 'u_ashton'] },
  { id: 'm_sa_3', conversationId: 'c_sales', authorId: 'u_rachel', kind: 'text', ts: at('2026-10-12T08:15'), text: 'Drafting the price-change email to our top 10 accounts. I’ll share it here by Wednesday for comments.' },

  // ── #announcements ──────────────────────────────────────────────
  { id: 'm_an_1', conversationId: 'c_announce', authorId: 'u_huimin', kind: 'text', ts: at('2026-10-09T17:00'), text: 'Reminder: the new leave policy starts on 1 Nov. Carry-over is now capped at 5 days. Full details are on the Leave Policy page in the HR wiki.', reactions: [{ emoji: '👍', by: ['u_priya', 'u_ahmad', 'u_marcus'] }] },
  { id: 'm_an_2', conversationId: 'c_announce', authorId: 'u_huimin', kind: 'text', ts: at('2026-10-12T08:00'), text: 'Please welcome Nadia Yusof, who joins Customer Success today! 👋 Say hi in #welcome.', reactions: [{ emoji: '👋', by: ['u_ashton', 'u_priya', 'u_daniel', 'u_rachel'] }] },

  // ── #design ─────────────────────────────────────────────────────
  { id: 'm_de_1', conversationId: 'c_design', authorId: 'u_daniel', kind: 'system', ts: at('2026-10-09T15:10'), text: 'Daniel and Rachel talked for 3 min in the Design room · transcript saved, no notes (short session)' },
  { id: 'm_de_2', conversationId: 'c_design', authorId: 'u_daniel', kind: 'text', ts: at('2026-10-12T08:31'), text: 'New delivery-tracking screens for Meridian are up. I’m in the room sharing my screen if anyone wants a look.' },
  { id: 'm_de_3', conversationId: 'c_design', authorId: 'u_rachel', kind: 'system', ts: at('2026-10-12T08:38'), text: 'Daniel and Rachel are in the Design room · recording' },

  // ── Q4 launch crew ──────────────────────────────────────────────
  { id: 'm_q4_1', conversationId: 'g_q4', authorId: 'u_daniel', kind: 'text', ts: at('2026-10-09T15:30'), text: 'Updated the Q4 Launch Proposal with the new timeline. Ashton, could you review before Wednesday?' },
  { id: 'm_q4_2', conversationId: 'g_q4', authorId: 'u_ahmad', kind: 'text', ts: at('2026-10-09T17:45'), text: 'Looks good from Sales. Meridian onboarding lines up with week 2 of the plan.' },

  // ── #leadership (Weekly Digest agent) ───────────────────────────
  { id: 'm_le_1', conversationId: 'c_leadership', authorId: 'a_digest', kind: 'text', ts: at('2026-10-12T07:00'), text: 'Weekly digest · 5–9 Oct\n• Sales closed Meridian Foods, 3 years, ~1,200 pallets/month from 2 Nov.\n• Q3 pricing review: list prices held for Q4; new 5% tier above 200 pallets/month.\n• Ops: container delay moved unloading to Tue; forklift 3 out of service.\n• People: new leave policy from 1 Nov; 1 new joiner today.\nOpen decisions: movers vendor (Priya, due Tue).' },

  // ── #welcome ────────────────────────────────────────────────────
  { id: 'm_we_1', conversationId: 'c_welcome', authorId: 'u_nadia', kind: 'system', ts: at('2026-10-12T07:58'), text: 'Nadia Yusof joined Hearth' },
  { id: 'm_we_2', conversationId: 'c_welcome', authorId: 'u_huimin', kind: 'text', ts: at('2026-10-12T08:02'), text: 'Welcome, Nadia! Message Onboarding Buddy any time you’re looking for a person, a place, or how something works.', reactions: [{ emoji: '❤️', by: ['u_nadia'] }] },

  // ── IT Helpdesk agent DM ────────────────────────────────────────
  { id: 'm_it_1', conversationId: 'ag_it', authorId: 'u_ashton', kind: 'text', ts: at('2026-10-08T16:10'), text: 'How do I add a new joiner to Hearth?' },
  { id: 'm_it_2', conversationId: 'ag_it', authorId: 'a_it', kind: 'text', ts: at('2026-10-08T16:10'), text: 'Admins add people in Admin → People → Add person, or import a CSV with name, phone, department, team, manager and role. The new joiner then signs in with their phone number and sets a PIN.' },

  // ── #it-help ────────────────────────────────────────────────────
  { id: 'm_ih_1', conversationId: 'c_it', authorId: 'u_arjun', kind: 'text', ts: at('2026-10-09T10:05'), text: 'The label printer at the Woodlands DC office is back online.' },

  // ── Assistant ───────────────────────────────────────────────────
  { id: 'm_as_1', conversationId: 'c_assistant', authorId: 'as_me', kind: 'text', ts: at('2026-10-12T07:30'), text: 'Good morning, Ashton. 4 things need you today, and the Q4 launch review prep brief is ready. Open Today for the list.' },
]
