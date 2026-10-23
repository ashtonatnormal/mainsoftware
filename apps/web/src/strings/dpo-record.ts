// What the Notice tab's record dialog says (PDPA-03, ACC-12; C0.9 OD-19, PD-75, PD-76): recording
// an acknowledgement someone made outside Hearth. strings/dpo.ts's header gives the rules for every
// DPO page's copy: British English, short and active, never "ask" and never an AI word (decision 8,
// ST-02, DPP-06). A file of its own, so only the Notice tab's chunk carries it: strings/dpo-notice.ts
// loads with every register page's notice markers too. What holds a record back is packages/shared's
// codes (RECORD_PROBLEMS), worded here once each. The DPO and the owner may reword any of it in the
// PR.
import type { RecordProblemCode } from '@hearth/shared'

// Recording an acknowledgement made outside Hearth, from the Notice tab (C0.9 OD-19, PD-75, PD-76):
// for the latest version, for someone else still at the organisation, with the day and how. The
// people are picked by name and department, then their manager and the day they were added where
// two would read the same; never a number or whether they have acknowledged.
export const RECORD = {
  open: 'Record an acknowledgement',
  title: (version: string) => `Record an acknowledgement of version ${version}`,
  intro:
    'For someone who acknowledged this version outside Hearth, such as by signing a printed copy. They can use Hearth as soon as you record it, and they see what you record in their Settings.',
  loadingPeople: 'Loading the people at the organisation…',
  nobody: 'There’s nobody else at the organisation.',
  person: 'Who acknowledged it',
  choose: 'Choose someone',
  withDepartment: (name: string, department: string) => `${name} (${department})`,
  withManager: (label: string, manager: string) => `${label}, reports to ${manager}`,
  withAdded: (label: string, day: string) => `${label}, added ${day}`,
  sameDetails:
    'Two people here have the same name, department and manager, and were added on the same day. Check with them which is which before you record.',
  // NOTICE_PEOPLE_MAX (NTW-12 holds the figure to it).
  more: 'Only the first 2,000 people, by name, are listed.',
  day: 'When they acknowledged it',
  dayHint: (from: string, to: string) => `From ${from} to ${to}.`,
  how: 'How they acknowledged it',
  howHint: 'For example: signed a printed copy at induction.',
  beforeRecording: 'Before you can record',
  record: 'Record',
  recording: 'Recording…',
  recorded: (name: string, version: string) => `Recorded: ${name} acknowledged version ${version}.`,
  // changed false: the record was redundant, and nothing was written (PD-76).
  already: (name: string, version: string) =>
    `${name} had already acknowledged version ${version}, so nothing was recorded.`,
  // 409 notice_changed, 400 notice_invalid and 403 forbidden, in this dialog's words.
  newer: 'A newer version was published. Reload, then record their acknowledgement of that one.',
  invalid: (version: string) =>
    `This can’t be recorded as it is. Check the day, from the day version ${version} was published to today, and how they acknowledged it.`,
  refused: 'You can record this only for someone still at the organisation, other than you.',
  // What holds the record back (recordProblems), in RECORD_PROBLEMS' order.
  problems: {
    person_missing: 'Choose who acknowledged it.',
    day_missing: 'Give the day they acknowledged it.',
    day_out_of_range: (version: string) => `Give a day from the day version ${version} was published to today.`,
    note_missing: 'Say how they acknowledged it.',
    note_long: 'Keep it to 500 characters.',
    note_not_one_line: 'Keep it on one line.',
    ai_copy: 'This uses wording Hearth keeps off its screens. Reword it.',
  } satisfies Record<RecordProblemCode, string | ((version: string) => string)>,
} as const
