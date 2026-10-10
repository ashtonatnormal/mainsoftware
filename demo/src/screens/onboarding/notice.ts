// The privacy and recording notice (PDPA-02), shared by onboarding and Settings.
export const NOTICE_VERSION = '1.0'
export const NOTICE_DATE = '12 Oct 2026'
export const ACK_RECORD = 'Version 1.0 acknowledged on 12 Oct 2026, 8:41 am'
export const DPO_NAME = 'Ashton Teo'

export interface NoticeSection {
  id: string
  title: string
  points: string[]
}

export const noticeSections: NoticeSection[] = [
  {
    id: 'recorded',
    title: 'What’s recorded',
    points: [
      'Every voice session with 2 or more people is recorded and transcribed, including calls and drop-in rooms.',
      'A red recording indicator is always on screen while a session is recorded.',
      'Voice messages are transcribed so they can be read and searched.',
    ],
  },
  {
    id: 'ai',
    title: 'What the AI does',
    points: [
      'Writes transcripts and meeting notes, and runs your private assistant.',
      'It only uses what you can already open. It never shows you anything you couldn’t see yourself.',
      'Our AI providers never train on our data.',
    ],
  },
  {
    id: 'who',
    title: 'Who can see recordings',
    points: [
      'Members of the room’s channel can open its recordings, transcripts and notes.',
      'Restricted rooms: only the people in the session.',
      'Every view is logged, and you can see who opened a session.',
    ],
  },
  {
    id: 'where',
    title: 'Where data goes',
    points: [
      'Storage on AWS in Singapore, and Claude through Amazon Bedrock in Singapore.',
      'OpenAI for transcription, processed outside Singapore.',
      'LiveKit for voice rooms, with service logs kept in the US or EU.',
    ],
  },
  {
    id: 'keep',
    title: 'How long we keep it',
    points: [
      'Session recordings: 120 days.',
      'Voice-message audio: 360 days.',
      'Transcripts and notes: 3 years (proposed, for the DPO to confirm).',
    ],
  },
  {
    id: 'rights',
    title: 'Your rights',
    points: [
      'You can ask to see your data, correct it, or withdraw consent where a purpose relies on consent.',
      'Requests go to the Data Protection Officer, who replies within 30 days.',
    ],
  },
  {
    id: 'dpo',
    title: 'Data Protection Officer',
    points: ['Ashton Teo, Tembusu Logistics. You can message the DPO in Hearth, and the contact is also published on our website.'],
  },
]
