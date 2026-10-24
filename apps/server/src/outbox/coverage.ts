// Every way a runtime transaction can write a table in schema public (the only schema
// scripts/check-migrations.sh allows; Postgres's own catalogue functions aside), and what covers
// it (TECH-SPEC T16 item 7): an outbox event the transaction must append, or an exemption with its
// reason. CLAUDE.md asks every content write to append its event with an ACL snapshot, and D41's
// seams every write to be covered, so nothing here is left undecided:
//   - content writes always append their event (no exemption is allowed for a content table,
//     packages/shared CONTENT_TABLES or one whose events carry a snapshot, by its grant or through
//     a function: check-catalogues.ts refuses one);
//   - other writes append their catalogue event where a consumer may act on them (sign-ins,
//     credentials, deactivation, flags, the registers), including the grants a later step will use
//     first, which name that step's reserved events (C0.9, C0.15, C0.16);
//   - bookkeeping (last-seen stamps), security counters, the logs themselves and the queue's and
//     outbox's own machinery are exempt, each saying why.
//
// Two checks hold the code to it. apps/server/scripts/check-catalogues.ts (CI's migrations job)
// requires an entry here for every write grant any runtime role holds, every function such a role
// may execute and every SECURITY DEFINER and trigger function in the schema, and no entry for
// anything else, and each function's `writes` to name every table its body writes. The integration suites' sweep (testing/writes.ts) records every committed write
// and requires each to be exempt or to have, in its own transaction, an event of a listed type
// naming the row's MATCH column as its entity or among its subjects.
//
// Keys:
//   '<role> <table>:INSERT' and '<role> <table>:DELETE' for a role that may insert or delete rows
//     (by a table grant or a column grant: an insert is one row whichever columns it sets);
//   '<role> <table>.<column>:UPDATE' for each column a role may update;
//   '<function>(<argument types>)' for each function, with `writes` listing the '<table>:<op>' and
//     '<table>.<column>:UPDATE' it makes that its entry covers (an empty list when it writes
//     nothing), so the sweep can match a write made inside it, which it records as the role of the
//     transaction calling it. A write a caller's own grant covers (set_feature_flag()'s audit row)
//     is that grant's.
import type { EmittedEventType, EventType } from '@hearth/shared'

export type Coverage = ({ events: readonly EventType[] } | { exempt: string }) & { writes?: readonly string[] }

// Reasons shared by several entries.
const AUDIT_LOG = 'the audit log is itself the record of the change, written in its transaction (ADM-06)'
const ACCESS_LOG = 'the data access log is itself the record of the read it logs (PDPA-05)'
const OUTBOX = 'the outbox itself'
const QUEUE = "the queue's and scheduler's own machinery: jobs, schedules and their runs"
const CHECKPOINT = "the outbox's own machinery: a consumer's position, moved with its effects"
const LAST_SEEN = 'bookkeeping, at most once a minute, which no one makes and nothing acts on (T14 item 6)'
const CHECK = 'a check or a lock: it refuses or waits, and writes nothing'
const DPO_CONTACT =
  "the DPO's business contact: its versions are its history, and nothing acts on a change until the next published version, which notice.published covers"
const STAMP = 'stamps the row being written with the database clock; that write is covered by its own entry'

const deactivation: Coverage = { events: ['person.deactivated'] }
// The registers (C0.9, TECH-SPEC T22 item 13): their functions are their only writers.
const transferChanged = 'register.transfer_changed' as const
// What ending an open clearance writes, by the DPO's decision or because new facts were recorded.
const CLEARANCE_ENDED = [
  'transfer_clearances.withdrawn_at:UPDATE',
  'transfer_clearances.withdrawn_by:UPDATE',
  'transfer_clearances.withdraw_reason:UPDATE',
] as const
const signinEnded: Coverage = { events: ['signin.ended'] }
const signinStarted: Coverage = { events: ['signin.started'] }
const pinSetOrReset: Coverage = { events: ['account.pin_set', 'account.pin_reset'] }
const personUpdated: Coverage = { events: ['person.updated', 'acl.changed'] }
const department: Coverage = { events: ['department.changed'] }
const team: Coverage = { events: ['team.changed', 'acl.changed'] }
const membership: Coverage = { events: ['team.membership_changed', 'acl.changed'] }
const phone: Coverage = { events: ['person.phone_changed'] }
const profile: Coverage = { events: ['profile.updated'] }
const queue: Coverage = { exempt: QUEUE }
const checkpoint: Coverage = { exempt: CHECKPOINT }

export const WRITES: Readonly<Record<string, Coverage>> = {
  // --- hearth_app, the api and realtime roles -------------------------------------------------

  // The logs (W1; read_audit_events' row below).
  'hearth_app audit_events:INSERT': { exempt: AUDIT_LOG },
  'hearth_app data_access_events:INSERT': { exempt: ACCESS_LOG },
  'hearth_app outbox_events:INSERT': { exempt: OUTBOX },

  // The roster (C0.16 writes these first; hearth_app may already). A person and their principal
  // are made in one transaction, which appends person.added.
  'hearth_app principals:INSERT': { events: ['person.added'] },
  'hearth_app people:INSERT': { events: ['person.added'] },
  'hearth_app people.full_name:UPDATE': personUpdated,
  // A department or a reporting line can bound what someone may read or manage (T13).
  'hearth_app people.department_id:UPDATE': personUpdated,
  'hearth_app people.manager_id:UPDATE': personUpdated,
  // W15: a deactivation (its cascade, people_end_sessions, is covered below).
  'hearth_app people.deactivated_at:UPDATE': deactivation,
  'hearth_app people.deactivated_by:UPDATE': deactivation,
  'hearth_app phone_numbers:INSERT': phone,
  'hearth_app phone_numbers.removed_at:UPDATE': phone,
  'hearth_app phone_numbers.removed_by:UPDATE': phone,
  'hearth_app departments:INSERT': department,
  'hearth_app departments.name:UPDATE': department,
  'hearth_app departments.archived_at:UPDATE': department,
  'hearth_app departments.archived_by:UPDATE': department,
  // An archived team ends its Team Admin's powers (T13), so it changes people's keys too.
  'hearth_app teams:INSERT': team,
  'hearth_app teams.name:UPDATE': team,
  'hearth_app teams.archived_at:UPDATE': team,
  'hearth_app teams.archived_by:UPDATE': team,
  'hearth_app team_memberships:INSERT': membership,
  'hearth_app team_memberships.removed_at:UPDATE': membership,
  'hearth_app team_memberships.removed_by:UPDATE': membership,

  // Profiles and working hours (C0.15 writes these first).
  'hearth_app profiles:INSERT': profile,
  'hearth_app profiles.display_name:UPDATE': profile,
  'hearth_app profiles.title:UPDATE': profile,
  'hearth_app profiles.time_zone:UPDATE': profile,
  'hearth_app profiles.custom_status:UPDATE': profile,
  'hearth_app profiles.custom_status_until:UPDATE': profile,
  'hearth_app profiles.updated_at:UPDATE': profile,
  'hearth_app working_hours:INSERT': profile,
  // Working hours are replaced whole: the old rows deleted, the new inserted, one profile.updated.
  'hearth_app working_hours:DELETE': profile,

  // The privacy notice: hearth_app writes neither table itself from 0010; publish_notice(),
  // acknowledge_notice() and, from 0011, record_notice_acknowledgement() below are their only
  // writers (C0.9 PD-42, OD-19). Nor the DPO's contact: set_dpo_contact() is its only writer.

  // Accounts and PINs. W3 and W4: setting a PIN at a PIN-role holder's first sign-in, or a code-only
  // sign-in making the account beside its signin.started (D46); W16: an admin's reset.
  'hearth_app users:INSERT': { events: ['account.pin_set', 'signin.started'] },
  'hearth_app users.pin_hash:UPDATE': pinSetOrReset,
  'hearth_app users.pin_key_id:UPDATE': pinSetOrReset,
  'hearth_app users.pin_set_at:UPDATE': pinSetOrReset,
  'hearth_app users.pin_reset_at:UPDATE': { events: ['account.pin_reset'] },
  'hearth_app users.pin_reset_by:UPDATE': { events: ['account.pin_reset'] },
  // W5, W6, and the reset to 0 that setting or resetting a PIN makes.
  'hearth_app users.pin_failures:UPDATE': {
    exempt:
      'a security counter; a PIN lock is audited (auth.pin_locked), and the set or reset it belongs to has its event',
  },

  // Passkeys. W12, W13; W2 is a passkey's use.
  'hearth_app passkeys:INSERT': { events: ['account.passkey_added'] },
  'hearth_app passkeys.removed_at:UPDATE': { events: ['account.passkey_removed'] },
  'hearth_app passkeys.removed_by:UPDATE': { events: ['account.passkey_removed'] },
  'hearth_app passkeys.counter:UPDATE': {
    exempt: "a credential's use: the sign-in or re-authentication it serves has its own event or audit row",
  },
  'hearth_app passkeys.last_used_at:UPDATE': {
    exempt: "a credential's use: the sign-in or re-authentication it serves has its own event or audit row",
  },

  // Devices and sessions. W10, W11: a sign-in; W14, W17 and the cascades: ending them.
  'hearth_app devices:INSERT': signinStarted,
  'hearth_app sessions:INSERT': signinStarted,
  'hearth_app devices.signed_out_at:UPDATE': signinEnded,
  'hearth_app devices.signed_out_by:UPDATE': signinEnded,
  'hearth_app sessions.revoked_at:UPDATE': signinEnded,
  'hearth_app sessions.revoked_by:UPDATE': signinEnded,
  'hearth_app sessions.revoke_reason:UPDATE': signinEnded,
  // W7, W8.
  'hearth_app devices.last_seen_at:UPDATE': { exempt: LAST_SEEN },
  'hearth_app sessions.last_seen_at:UPDATE': { exempt: LAST_SEEN },
  // W9.
  'hearth_app sessions.reauthenticated_at:UPDATE': {
    exempt: 'a stamp on the session, audited as auth.reauth; nothing acts on it but the next admin check',
  },
  // A device's name is set from the browser when it signs in; nothing renames one yet, and a name
  // changes no access and nothing downstream reads it. The step that adds renaming may give it an
  // event of its own.
  'hearth_app devices.label:UPDATE': {
    exempt: "a device's display name, which changes no access and which nothing downstream reads",
  },

  // --- The worker's job roles (T18) ----------------------------------------------------------

  'hearth_queue jobs:INSERT': queue,
  'hearth_queue jobs.state:UPDATE': queue,
  'hearth_queue jobs.attempts:UPDATE': queue,
  'hearth_queue jobs.give_backs:UPDATE': queue,
  'hearth_queue jobs.run_after:UPDATE': queue,
  'hearth_queue jobs.lease_token:UPDATE': queue,
  'hearth_queue jobs.lease_expires_at:UPDATE': queue,
  'hearth_queue jobs.claimed_by:UPDATE': queue,
  'hearth_queue jobs.reason:UPDATE': queue,
  'hearth_queue jobs.started_at:UPDATE': queue,
  'hearth_queue jobs.finished_at:UPDATE': queue,
  'hearth_queue schedules:INSERT': queue,
  'hearth_queue schedules.next_run_at:UPDATE': queue,
  'hearth_queue schedules.last_fired_at:UPDATE': queue,
  'hearth_queue schedules.retired_at:UPDATE': queue,
  'hearth_queue schedule_runs:INSERT': queue,
  'hearth_queue schedule_runs.state:UPDATE': queue,
  'hearth_queue schedule_runs.reason:UPDATE': queue,
  'hearth_queue schedule_runs.started_at:UPDATE': queue,
  'hearth_queue schedule_runs.finished_at:UPDATE': queue,
  'hearth_job_offboarding jobs:INSERT': queue,
  'hearth_job_offboarding outbox_checkpoints:INSERT': checkpoint,
  'hearth_job_offboarding outbox_checkpoints.last_tx:UPDATE': checkpoint,
  'hearth_job_offboarding outbox_checkpoints.last_id:UPDATE': checkpoint,
  'hearth_job_offboarding outbox_checkpoints.processed:UPDATE': checkpoint,
  'hearth_job_offboarding outbox_checkpoints.updated_at:UPDATE': checkpoint,
  'hearth_job_revocation jobs:INSERT': queue,
  'hearth_job_revocation outbox_checkpoints:INSERT': checkpoint,
  'hearth_job_revocation outbox_checkpoints.last_tx:UPDATE': checkpoint,
  'hearth_job_revocation outbox_checkpoints.last_id:UPDATE': checkpoint,
  'hearth_job_revocation outbox_checkpoints.processed:UPDATE': checkpoint,
  'hearth_job_revocation outbox_checkpoints.updated_at:UPDATE': checkpoint,

  // --- Functions -----------------------------------------------------------------------------

  // Changing a flag: the only way one changes (T17). Its audit row (flag.set) is covered by the
  // audit grant of hearth_app, the only role that may call it.
  'set_feature_flag(text, boolean, text, uuid[], text[], text, uuid, inet)': {
    events: ['flag.changed'],
    writes: [
      'feature_flags.enabled:UPDATE',
      'feature_flags.audience:UPDATE',
      'feature_flags.cohort_people:UPDATE',
      'feature_flags.cohort_roles:UPDATE',
      'feature_flags.revision:UPDATE',
      'feature_flags.updated_at:UPDATE',
      'feature_flags.updated_by:UPDATE',
    ],
  },
  // The registers (C0.9 PD-21, PD-22; TECH-SPEC T22 item 13): the DPO's routes call these after
  // can() allows the change and append the event in the same transaction, naming the new version's
  // row or the transfer entry. Their audit rows are covered by hearth_app's audit grant, as for
  // set_feature_flag(). The first-Owner bootstrap's function (bootstrap_transfer_clearance()), and
  // its break-glass re-clear (C0.9 OD-20), is no runtime role's and appends its own event (PD-23).
  'set_register_purpose(text, integer, text, text, text, integer, text, text[], text, uuid, inet)': {
    events: ['register.purpose_changed'],
    writes: ['processing_register:INSERT'],
  },
  'record_transfer_entry(text, bigint, text, text, text[], text[], text, text, text, date, boolean, text, text, text, text, text, date, boolean, text, uuid, inet)':
    {
      events: [transferChanged],
      writes: [
        ...CLEARANCE_ENDED,
        'transfer_register.services:UPDATE',
        'transfer_register.data_types:UPDATE',
        'transfer_register.processing_countries:UPDATE',
        'transfer_register.storage_countries:UPDATE',
        'transfer_register.countries_confirmed:UPDATE',
        'transfer_register.safeguard:UPDATE',
        'transfer_register.safeguard_reference:UPDATE',
        'transfer_register.certificate_verified_on:UPDATE',
        'transfer_register.dpa_terms_confirmed:UPDATE',
        'transfer_register.training:UPDATE',
        'transfer_register.zero_retention:UPDATE',
        'transfer_register.provider_retention:UPDATE',
        'transfer_register.retention_confirmed:UPDATE',
        'transfer_register.onward_recipients:UPDATE',
        'transfer_register.review_on:UPDATE',
        'transfer_register.revision:UPDATE',
        'transfer_register.updated_at:UPDATE',
        'transfer_register.updated_by:UPDATE',
        // "Save and keep cleared": the new facts' clearance (PD-05).
        'transfer_clearances:INSERT',
      ],
    },
  'clear_transfer_entry(text, bigint, text, uuid, inet)': {
    events: [transferChanged],
    writes: ['transfer_clearances:INSERT'],
  },
  'withdraw_transfer_clearance(text, text, uuid, inet)': { events: [transferChanged], writes: [...CLEARANCE_ENDED] },
  // An outbound client's question in the transaction that decides a send (PD-15): it reads the open
  // clearance FOR SHARE and writes nothing. From 0010 it wraps transfer_send_state(), which answers
  // why a code may or may not go too (PD-59, B-03, C-02).
  'transfer_cleared(text)': { exempt: CHECK, writes: [] },
  'transfer_send_state(text)': { exempt: CHECK, writes: [] },
  // The privacy notice (C0.9 PD-37, PD-42, PD-50; TECH-SPEC T22 items 33 and 45): the notice
  // tables' three writers. The api calls each after can() allows it (notice.publish,
  // notice.acknowledge_own, notice.acknowledgement.record) and appends the event in the same
  // transaction: notice.published naming the new version's row, whose id its links carry, and
  // notice.acknowledged naming the person, only when something was recorded. Their audit rows are
  // covered by hearth_app's audit grant, as for set_feature_flag(). 0011 replaced 0010's
  // publish_notice() with one that names the contact its draft printed (the same events and writes).
  'publish_notice(integer, text, text, text[], integer[], uuid[], integer, text, uuid, inet)': {
    events: ['notice.published'],
    writes: ['notice_versions:INSERT', 'notice_version_purposes:INSERT', 'notice_version_providers:INSERT'],
  },
  'acknowledge_notice(uuid, text, uuid, inet)': {
    events: ['notice.acknowledged'],
    writes: ['notice_acknowledgments:INSERT'],
  },
  // An acknowledgement the DPO records (C0.9 OD-19): the event an acknowledgement in the app appends.
  'record_notice_acknowledgement(uuid, uuid, date, text, text, uuid, inet)': {
    events: ['notice.acknowledged'],
    writes: ['notice_acknowledgments:INSERT'],
  },
  // The DPO's business contact (C0.9 OD-10, PD-63, PD-72): its only writer. Its versions are its
  // history and its audit row the record of who changed it; nothing acts on a change until the next
  // published version, which notice.published covers.
  'set_dpo_contact(integer, text, text, text, text, text, uuid, inet)': {
    exempt: DPO_CONTACT,
    writes: ['dpo_settings:INSERT'],
  },
  // Whether the latest version states each open clearance, for the registers' copy (B-06): a read.
  'notice_provider_states()': {
    exempt: 'a read: whether the latest notice states each open clearance, and nothing written',
    writes: [],
  },
  // A published version never changes, and a stand-in never follows a generated one (PD-33); nor
  // does a recorded contact version (PD-63).
  'notice_unchanged()': { exempt: CHECK, writes: [] },
  'dpo_settings_unchanged()': { exempt: CHECK, writes: [] },
  'notice_versions_generated()': { exempt: CHECK, writes: [] },
  'orgs_add_registers()': {
    exempt: 'gives a new org its register entries; it runs only when the owner makes an org, never at run time',
    writes: ['processing_register:INSERT', 'transfer_register:INSERT'],
  },
  'transfer_clearances_check()': {
    exempt:
      "checks a clearance's facts and stamps the row being written with the revision and facts it rests on; that write is covered by its own entry",
    writes: [],
  },
  'transfer_register_check()': { exempt: CHECK, writes: [] },
  'processing_restrictions_check()': { exempt: CHECK, writes: [] },
  // D2: a deactivation ends the person's sessions and signs out their devices, as part of the one
  // business event (T16 item 8).
  'people_end_sessions()': {
    events: ['signin.ended'],
    writes: [
      'sessions.revoked_at:UPDATE',
      'sessions.revoked_by:UPDATE',
      'sessions.revoke_reason:UPDATE',
      'devices.signed_out_at:UPDATE',
      'devices.signed_out_by:UPDATE',
    ],
  },
  // D1: signing a device out ends its sessions.
  'devices_end_sessions()': {
    events: ['signin.ended'],
    writes: ['sessions.revoked_at:UPDATE', 'sessions.revoked_by:UPDATE', 'sessions.revoke_reason:UPDATE'],
  },
  // D3: the failure count's own time, set with it.
  'users_check_pin_failures()': {
    exempt: 'stamps the time of the last PIN failure with its count, a security counter',
    writes: ['users.pin_last_failed_at:UPDATE'],
  },
  // D4.
  'sessions_stamp_times()': { exempt: STAMP, writes: [] },
  // D5: reading the audit log logs itself.
  'read_audit_events(timestamp with time zone, timestamp with time zone, bigint, integer)': {
    exempt: 'a read of the audit log, which logs itself in it (audit.read)',
    writes: ['audit_events:INSERT'],
  },
  // D6: creates partitions, writes no row.
  'create_data_access_partitions(integer)': {
    exempt: "DDL only: it creates data_access_events' month partitions and writes no row",
    writes: [],
  },
  'orgs_add_feature_flags()': {
    exempt: 'gives a new org its flags; it runs only when the owner makes an org, never at run time',
    writes: ['feature_flags:INSERT'],
  },
  'job_finish(uuid, uuid, bigint[])': {
    exempt: QUEUE,
    writes: [
      'jobs.state:UPDATE',
      'jobs.finished_at:UPDATE',
      'jobs.lease_token:UPDATE',
      'jobs.lease_expires_at:UPDATE',
      'jobs.reason:UPDATE',
      'schedule_runs.state:UPDATE',
      'schedule_runs.finished_at:UPDATE',
    ],
  },
  // The clean-up: the only way rows leave the outbox and the queue, each batch audited (T15 item 17).
  'purge_outbox(integer)': {
    exempt: 'the clean-up, which deletes by position after 14 days and writes one audit row per batch',
    writes: [
      'outbox_events:DELETE',
      'outbox_floors:INSERT',
      'outbox_floors.last_tx:UPDATE',
      'outbox_floors.last_id:UPDATE',
      'outbox_floors.purged_at:UPDATE',
      'audit_events:INSERT',
    ],
  },
  'purge_jobs(integer)': {
    exempt: 'the clean-up of finished jobs, which writes one audit row per batch',
    writes: ['jobs:DELETE', 'audit_events:INSERT'],
  },
  'purge_schedule_runs(integer)': {
    exempt: 'the clean-up of finished schedule runs, which writes one audit row per batch',
    writes: ['schedule_runs:DELETE', 'audit_events:INSERT'],
  },
  // Lookups, fences and checks.
  'session_by_token(bytea, interval)': { exempt: 'a sign-in lookup before the org is known', writes: [] },
  'person_by_phone(text)': { exempt: 'a sign-in lookup before the org is known', writes: [] },
  'worker_org_ids()': { exempt: "the worker's list of org ids", writes: [] },
  'feature_fence(text, bigint[])': { exempt: CHECK, writes: [] },
  'job_fence(uuid, uuid, bigint[])': { exempt: CHECK, writes: [] },
  'is_ids_only(jsonb)': { exempt: CHECK, writes: [] },
  'is_iana_time_zone(text)': { exempt: CHECK, writes: [] },
  'check_user_active()': { exempt: CHECK, writes: [] },
  'keep_history()': { exempt: CHECK, writes: [] },
  'notice_versions_check()': { exempt: CHECK, writes: [] },
  'outbox_checkpoints_own_row()': { exempt: CHECK, writes: [] },
  'outbox_events_check_actor()': { exempt: CHECK, writes: [] },
  'people_check_department()': { exempt: CHECK, writes: [] },
  'people_check_manager()': { exempt: CHECK, writes: [] },
  'role_assignments_check()': { exempt: CHECK, writes: [] },
  'sessions_check_start()': { exempt: CHECK, writes: [] },
  'team_memberships_check()': { exempt: CHECK, writes: [] },
}

// For each table an event covers a write to, the column whose value the covering event must name,
// as its entity or among its subjects: the person, or the row itself.
export const MATCH: Readonly<Record<string, string>> = {
  people: 'id',
  principals: 'id',
  users: 'id',
  phone_numbers: 'person_id',
  devices: 'user_id',
  sessions: 'user_id',
  passkeys: 'user_id',
  profiles: 'person_id',
  working_hours: 'person_id',
  team_memberships: 'person_id',
  teams: 'id',
  departments: 'id',
  notice_versions: 'id',
  // A version's links name it (notice.published's entity, PD-34).
  notice_version_purposes: 'notice_version_id',
  notice_version_providers: 'notice_version_id',
  notice_acknowledgments: 'person_id',
  feature_flags: 'id',
  // A purpose's change names the new version's row; a provider's, its transfer entry (PD-22).
  processing_register: 'id',
  transfer_register: 'id',
  transfer_clearances: 'entry_id',
}

// The integration suite that must append each emitted type at least once (testing/writes.ts): each
// suite has its own database and module state, so a union across files can't be taken, and each
// checks its own share instead. The passkey events belong to the dormant passkey suite, the only one
// that switches passkeys on (D46). The register events belong to the registers suite (C0.9 PD-22),
// and the notice's to the notice suite (C0.9 PD-50).
export const EMITTED_BY: Readonly<
  Record<EmittedEventType, 'sign-in' | 'passkeys' | 'flags' | 'outbox' | 'jobs' | 'registers' | 'notice'>
> = {
  'signin.started': 'sign-in',
  'signin.ended': 'sign-in',
  'account.pin_set': 'sign-in',
  'account.pin_reset': 'sign-in',
  'account.passkey_added': 'passkeys',
  'account.passkey_removed': 'passkeys',
  'person.deactivated': 'sign-in',
  'acl.changed': 'sign-in',
  'flag.changed': 'flags',
  'register.purpose_changed': 'registers',
  'register.transfer_changed': 'registers',
  'notice.published': 'notice',
  'notice.acknowledged': 'notice',
}

export type WriteOp = 'INSERT' | 'UPDATE' | 'DELETE'

// The key a write grant has: a row operation by table, an update by column.
export function grantKey(role: string, table: string, op: WriteOp, column?: string): string {
  return op === 'UPDATE' ? `${role} ${table}.${column ?? '?'}:UPDATE` : `${role} ${table}:${op}`
}

// What a function's `writes` names for the same write.
export function writeKey(table: string, op: WriteOp, column?: string): string {
  return op === 'UPDATE' ? `${table}.${column ?? '?'}:UPDATE` : `${table}:${op}`
}

// The entries that can cover one write a role made: its grant's, or failing that every function
// that says it makes that write (a definer function, or a trigger, writing on the role's behalf).
// The sweep can't tell which of them made it, so an exemption excuses it only when every one is
// exempt. Empty when nothing here explains the write.
export function coverageOf(
  role: string,
  table: string,
  op: WriteOp,
  column?: string,
): Array<{ key: string; coverage: Coverage }> {
  const key = grantKey(role, table, op, column)
  const granted = WRITES[key]
  if (granted !== undefined) return [{ key, coverage: granted }]
  const write = writeKey(table, op, column)
  return Object.entries(WRITES)
    .filter(([, coverage]) => coverage.writes?.includes(write))
    .map(([name, coverage]) => ({ key: name, coverage }))
}
