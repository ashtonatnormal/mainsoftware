// Scripted example content used only by the Chats screen: thread replies,
// transcripts for voice notes you record, and the sources behind AI messages
// that ship in the seed data. Everything here is fictional.
import type { ParticipationLevel, PersonId, SourceRef } from '../../types'
import { at } from '../../time'

export interface ThreadReply {
  id: string
  authorId: PersonId
  text: string
  ts: number
}

/** Short scripted threads, keyed by the parent message id (CHAT-03). */
export const threadReplies: Record<string, ThreadReply[]> = {
  m_ops_4: [
    { id: 'tr_ops_1', authorId: 'u_arjun', ts: at('2026-10-12T08:06'), text: 'On it. The vendor can come at 2 pm today. I’ll confirm once the server migration wraps up at 10.' },
    { id: 'tr_ops_2', authorId: 'u_marcus', ts: at('2026-10-12T08:09'), text: 'I’ll keep forklift 3 tagged out and park it by bay 4 so they can get to it easily.' },
    { id: 'tr_ops_3', authorId: 'u_arjun', ts: at('2026-10-12T08:10'), text: 'Thanks. If the repair quote is over S$2,000 it needs Ashton’s sign-off, so I’ll send it to him first.' },
  ],
  m_sa_2: [
    { id: 'tr_sa_1', authorId: 'u_rachel', ts: at('2026-10-09T18:32'), text: 'Amazing work, Ahmad! That’s our biggest new account this year.' },
    { id: 'tr_sa_2', authorId: 'u_weiling', ts: at('2026-10-09T18:41'), text: 'I’ll set them up in billing this week. Payment terms are 30 days, as agreed.' },
    { id: 'tr_sa_3', authorId: 'u_priya', ts: at('2026-10-09T18:55'), text: 'Noted for Ops. A 2 Nov start works; we’ll need the extra cold-room slots from week 2.' },
    { id: 'tr_sa_4', authorId: 'u_ashton', ts: at('2026-10-09T19:02'), text: 'Brilliant result. Thank you, Ahmad. Let’s get Ops the weekly volumes as soon as Meridian confirms them.' },
    { id: 'tr_sa_5', authorId: 'u_rachel', ts: at('2026-10-09T19:11'), text: 'I’ll run the onboarding calls with their logistics team.' },
  ],
}

/** What your simulated voice note "said", per conversation. */
export const myVoiceTranscripts: Record<string, string> = {
  dm_marcus: 'Hi Marcus, I’ve looked at the roster. That’s fine, go ahead and tell the crew today. Thanks for turning it round so quickly.',
  dm_priya: 'Hi Priya, I’ve read both quotes. Kranji looks good if the insurance cover matches. Let’s talk it through at our one-to-one at eleven.',
  c_ops: 'Morning everyone, catching up now. Arjun, please send me the forklift repair quote as soon as you have it.',
  c_sales: 'Great work on Meridian, everyone. Rachel, I’ll read the customer email draft on Wednesday.',
  c_design: 'Daniel, the tracking screens look great. I’ll drop into the room after the standup.',
  g_q4: 'Hi all, I’ll review the proposal tonight and leave comments before Wednesday.',
}
export const defaultVoiceTranscript = 'Quick one from me: I’ve seen this and I’ll come back to you after my eleven o’clock.'

/** Sources behind AI messages in the seed data (every AI output cites its sources). */
export const seedSources: Record<string, SourceRef[]> = {
  m_as_1: [
    { label: 'Today · 4 things need you', kind: 'task', route: { name: 'today' } },
    { label: 'Q4 launch review · 3:00 pm', kind: 'event', route: { name: 'calendar', eventId: 'e_q4' } },
  ],
  m_le_1: [
    { label: 'Ahmad in #sales · Fri', kind: 'message', route: { name: 'chats', conversationId: 'c_sales' } },
    { label: 'Q3 pricing review · Fri 9 Oct', kind: 'session', route: { name: 'session', sessionId: 's_pricing' } },
    { label: '#ops-north-site', kind: 'message', route: { name: 'chats', conversationId: 'c_ops' } },
    { label: 'Hui Min in #announcements', kind: 'message', route: { name: 'chats', conversationId: 'c_announce' } },
  ],
  m_it_2: [{ label: 'Adding people · IT wiki', kind: 'doc', route: { name: 'docs', docId: 'd_itpeople' } }],
}

/** AGT-08 participation levels, explained in plain words. */
export const participationLevels: { value: ParticipationLevel; label: string; body: string }[] = [
  { value: 'off', label: 'Off', body: 'Agents don’t take part here, even when someone @mentions them.' },
  { value: 'mention', label: 'Mention only', body: 'Agents answer only when someone @mentions them.' },
  { value: 'suggest', label: 'Suggest', body: 'When an agent is confident and can cite a source, it offers a small card. Anyone can open it or dismiss it.' },
  { value: 'active', label: 'Active', body: 'Agents can post full messages without being asked, up to an hourly limit.' },
]

export const quickReactions = ['👍', '❤️', '😂', '🙏']
