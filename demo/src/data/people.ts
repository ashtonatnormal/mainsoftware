import type { Person } from '../types'

// Fictional organisation: Tembusu Logistics, a Singapore warehousing and
// distribution company (~400 staff). All names are invented.
export const ORG_NAME = 'Tembusu Logistics'
export const ME = 'u_ashton'
export const ASSISTANT = 'as_me'

export const people: Person[] = [
  { id: 'u_ashton', name: 'Ashton Teo', short: 'Ashton', kind: 'human', title: 'Founder · Data Protection Officer', team: 'Leadership', hue: 24, status: 'online' },
  { id: 'u_priya', name: 'Priya Nair', short: 'Priya', kind: 'human', title: 'Head of Operations', team: 'Operations', hue: 330, status: 'online' },
  { id: 'u_marcus', name: 'Marcus Ong', short: 'Marcus', kind: 'human', title: 'Site Supervisor, Woodlands DC', team: 'Operations', hue: 205, status: 'online', mobile: true, customStatus: 'On the warehouse floor' },
  { id: 'u_farah', name: 'Farah Iskandar', short: 'Farah', kind: 'human', title: 'Warehouse Coordinator', team: 'Operations', hue: 160, status: 'online', mobile: true },
  { id: 'u_weiling', name: 'Tan Wei Ling', short: 'Wei Ling', kind: 'human', title: 'Finance Manager', team: 'Finance', hue: 270, status: 'away', customStatus: 'Month-end close' },
  { id: 'u_ahmad', name: 'Ahmad Rahman', short: 'Ahmad', kind: 'human', title: 'Sales Lead', team: 'Sales', hue: 45, status: 'online' },
  { id: 'u_rachel', name: 'Rachel Goh', short: 'Rachel', kind: 'human', title: 'Account Manager', team: 'Sales', hue: 350, status: 'online' },
  { id: 'u_daniel', name: 'Daniel Lim', short: 'Daniel', kind: 'human', title: 'Product Designer', team: 'Design', hue: 190, status: 'online' },
  { id: 'u_huimin', name: 'Chua Hui Min', short: 'Hui Min', kind: 'human', title: 'People & Culture Lead', team: 'People', hue: 300, status: 'online' },
  { id: 'u_arjun', name: 'Arjun Menon', short: 'Arjun', kind: 'human', title: 'IT Lead', team: 'IT', hue: 120, status: 'dnd', customStatus: 'Server migration until 10' },
  { id: 'u_kelvin', name: 'Kelvin Ng', short: 'Kelvin', kind: 'human', title: 'Driver, Fleet', team: 'Fleet', hue: 15, status: 'online', mobile: true },
  { id: 'u_nadia', name: 'Nadia Yusof', short: 'Nadia', kind: 'human', title: 'Customer Success Associate (joined today)', team: 'Customer Success', hue: 230, status: 'online' },

  // Personal assistant (PA-01) — one per person, private.
  { id: 'as_me', name: 'Assistant', short: 'Assistant', kind: 'assistant', title: 'Your private assistant', team: '', hue: 24, status: 'online' },

  // Specialist agents (§8.12), built by the central AI team.
  { id: 'a_hr', name: 'HR Policy', short: 'HR Policy', kind: 'agent', title: 'Answers leave, benefits and policy questions from the HR wiki', team: 'People', hue: 174, status: 'online', agentOwner: 'u_huimin' },
  { id: 'a_it', name: 'IT Helpdesk', short: 'IT Helpdesk', kind: 'agent', title: 'How-to answers and support tasks', team: 'IT', hue: 174, status: 'online', agentOwner: 'u_arjun' },
  { id: 'a_onboard', name: 'Onboarding Buddy', short: 'Onboarding Buddy', kind: 'agent', title: 'Helps new joiners find people, places and how things work', team: 'People', hue: 174, status: 'online', agentOwner: 'u_huimin' },
  { id: 'a_digest', name: 'Weekly Digest', short: 'Weekly Digest', kind: 'agent', title: 'Posts a weekly summary per team and for leadership', team: 'Leadership', hue: 174, status: 'online', agentOwner: 'u_ashton', customStatus: 'Next digest Mon 7:00 am' },
]

export const personById = Object.fromEntries(people.map(p => [p.id, p])) as Record<string, Person>
export const humans = people.filter(p => p.kind === 'human')
export const agents = people.filter(p => p.kind === 'agent')
