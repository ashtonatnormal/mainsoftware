// Job kinds (INF-QUEUE, TECH-SPEC T15): each kind of work the worker runs, in code, with what the
// gate and the fences judge it by. The registry entry, never the job row, decides a job's feature
// and purpose (a claimed job whose row says otherwise is never run: job_mismatch), so a producer
// can't move work under another flag or purpose.
//
// validateRegistries() runs at the worker's start and refuses a registry that breaks a rule, so a
// mistake fails the start-up check (scripts/check-server.sh) rather than a job at 03:17.
import {
  EVENTS,
  type EventType,
  type FlagSpec,
  idsProblems,
  isAiFlag,
  isAiPurpose,
  isPurposeKey,
  PROVIDERS,
  type ProviderKey,
  type PurposeKey,
} from '@hearth/shared'
import type { z } from 'zod'
import { isJobRole, type JobRole } from '#src/db/roles.ts'
import type { JobContext } from '#src/jobs/context.ts'
import { nextAfter, parseCron } from '#src/jobs/cron.ts'
import { type Backoff, DEFAULT_BACKOFF, DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS } from '#src/jobs/policy.ts'
import type { OutboxConsumer } from '#src/outbox/consumers.ts'

export interface JobKind<P extends object = object> {
  // Dotted lower case, at least two parts: 'maintenance.data_access_partitions'.
  readonly kind: string
  // A registered flag: the job runs only while it is on for the job's person.
  readonly feature: string
  // One of the flag's purposes: why the job processes personal data.
  readonly purpose: PurposeKey
  // The job role its transactions take (one that may fence and finish jobs).
  readonly role: JobRole
  // The payload's schema: ids only (packages/shared ids.ts). A payload it refuses makes the job
  // dead (payload_invalid).
  readonly payload: z.ZodType<P>
  // 1-100 attempts; the back-off between them; how long one attempt may run before it is aborted
  // (timeout) and retried.
  readonly maxAttempts: number
  readonly backoff: Backoff
  readonly timeoutMs: number
  // What happens to its work when its feature is switched off: requeued to wait for it (essential
  // flags' default) or cancelled (optional flags'). A cohort that leaves its person out always
  // cancels it.
  readonly onFlagOff?: 'requeue' | 'cancel'
  // Outside providers it sends personal data to (PDPA-10); each must be cleared.
  readonly providers?: readonly ProviderKey[]
  // It commits in several transactions, each safe to repeat, since a retry starts it again from
  // the top (T15 item 3). Without it, only the finishing commit is allowed.
  readonly idempotentCommits?: boolean
  // An event the runner also logs, at error level, when a job of the kind goes dead, for an alarm
  // of its own (offboarding_handler_dead).
  readonly deadEvent?: string
  run(ctx: JobContext<P>): Promise<void>
}

// A kind as written, with the defaults left out: 5 attempts, back-off 5 s doubling to 10 minutes,
// 5 minutes an attempt (T15 item 4).
export type JobKindSpec<P extends object> = Omit<JobKind<P>, 'maxAttempts' | 'backoff' | 'timeoutMs'> &
  Partial<Pick<JobKind<P>, 'maxAttempts' | 'backoff' | 'timeoutMs'>>

export function defineJob<P extends object>(spec: JobKindSpec<P>): JobKind<P> {
  return {
    ...spec,
    maxAttempts: spec.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoff: spec.backoff ?? DEFAULT_BACKOFF,
    timeoutMs: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

// A schedule from the registry (jobs/scheduler.ts writes it to every org): a key never changes its
// kind, cron, payload or policy; a change is a new key, with the old one listed as retired.
export interface ScheduleDef {
  key: string
  kind: string
  // Five-field cron, in UTC (jobs/cron.ts).
  cron: string
  // rerun: a run cut short goes back to the queue (safe to repeat); review: it waits for a person
  // (AGT-10), and its job is never retried on its own.
  onInterrupt: 'rerun' | 'review'
  payload?: Record<string, unknown>
}

// A key retired from the registry stays listed, so reconcile can retire its row in every org.
export interface RetiredSchedule {
  key: string
  retired: true
}

export interface Registries {
  kinds: readonly JobKind[]
  schedules: readonly (ScheduleDef | RetiredSchedule)[]
  consumers: readonly OutboxConsumer[]
}

const KIND = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/
const SCHEDULE_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
const CONSUMER = /^[a-z][a-z0-9_]{0,62}$/
// The roles that may fence and finish a job (0007's and 0008's grants); hearth_queue runs the queue
// itself.
const JOB_RUN_ROLES: readonly JobRole[] = [
  'hearth_job_offboarding',
  'hearth_job_partitions',
  'hearth_job_purge',
  'hearth_job_revocation',
]
// The roles that may move an outbox checkpoint (0007's and 0008's grants).
const CONSUMER_ROLES: readonly JobRole[] = ['hearth_job_offboarding', 'hearth_job_revocation']

export const isRetired = (schedule: ScheduleDef | RetiredSchedule): schedule is RetiredSchedule => 'retired' in schedule

// Throws, naming every problem, unless the registries keep the rules (T15 items 1, 8, 10 and 13;
// T16 item 15): each kind's and consumer's flag, purpose, role and providers registered, its
// purpose one of its flag's, no two of anything with one name, every schedule naming a known kind,
// a cron that can fire and a payload its kind accepts, every consumer naming known event types, only
// core.system's accounts work protective (T19 item 4), and every payload and ids schema ids only.
// Until A0 nothing may serve an AI purpose or an ai.* flag (D41): C0.9's purpose gate is the second
// lock.
export function validateRegistries(registries: Registries, flags: Readonly<Record<string, FlagSpec>>): void {
  const problems: string[] = []
  const flagOf = (key: string) => (Object.hasOwn(flags, key) ? flags[key] : undefined)
  const checkWork = (what: string, feature: string, purpose: string, providers: readonly string[] | undefined) => {
    const flag = flagOf(feature)
    if (flag === undefined) problems.push(`${what}: its feature ${feature} is not a registered flag`)
    if (!isPurposeKey(purpose)) problems.push(`${what}: ${purpose} is not a purpose (PURPOSES)`)
    else if (flag !== undefined && !(flag.purposes as readonly string[]).includes(purpose)) {
      problems.push(`${what}: its purpose ${purpose} is not one of ${feature}'s`)
    }
    for (const provider of providers ?? []) {
      if (!(PROVIDERS as readonly string[]).includes(provider)) problems.push(`${what}: ${provider} is not a provider`)
    }
    if (isAiFlag(feature) || isAiPurpose(purpose)) {
      problems.push(`${what}: nothing may serve an AI flag or purpose until A0 (D41)`)
    }
  }

  const kinds = new Map<string, JobKind>()
  for (const kind of registries.kinds) {
    const what = `job kind ${kind.kind}`
    if (!KIND.test(kind.kind) || kind.kind.length > 100) problems.push(`${what}: a kind is dotted lower case`)
    if (kinds.has(kind.kind)) problems.push(`${what}: two job kinds have this name`)
    kinds.set(kind.kind, kind)
    checkWork(what, kind.feature, kind.purpose, kind.providers)
    if (!isJobRole(kind.role) || !JOB_RUN_ROLES.includes(kind.role)) {
      problems.push(`${what}: ${kind.role} is not a role that runs jobs (${JOB_RUN_ROLES.join(', ')})`)
    }
    if (!Number.isInteger(kind.maxAttempts) || kind.maxAttempts < 1 || kind.maxAttempts > 100) {
      problems.push(`${what}: maxAttempts is 1 to 100`)
    }
    if (!(kind.backoff.baseMs >= 1 && kind.backoff.capMs >= kind.backoff.baseMs)) {
      problems.push(`${what}: the back-off needs a base of at least 1 ms and a cap no lower`)
    }
    if (!(kind.timeoutMs >= 1)) problems.push(`${what}: timeoutMs must be positive`)
    for (const problem of idsProblems(kind.payload))
      problems.push(`${what}: its payload must hold ids only: ${problem}`)
  }

  const keys = new Set<string>()
  for (const schedule of registries.schedules) {
    const what = `schedule ${schedule.key}`
    if (!SCHEDULE_KEY.test(schedule.key) || schedule.key.length > 100) {
      problems.push(`${what}: a key is dotted lower case`)
    }
    if (keys.has(schedule.key)) problems.push(`${what}: two schedules have this key`)
    keys.add(schedule.key)
    if (isRetired(schedule)) continue
    const kind = kinds.get(schedule.kind)
    if (kind === undefined) problems.push(`${what}: its kind ${schedule.kind} is not a registered job kind`)
    try {
      nextAfter(parseCron(schedule.cron), new Date())
    } catch (error) {
      problems.push(`${what}: ${(error as Error).message}`)
    }
    if (kind !== undefined && !kind.payload.safeParse(schedule.payload ?? {}).success) {
      problems.push(`${what}: its payload is not one its kind accepts`)
    }
  }

  const consumers = new Set<string>()
  for (const consumer of registries.consumers) {
    const what = `outbox consumer ${consumer.name}`
    if (!CONSUMER.test(consumer.name)) problems.push(`${what}: a consumer name is a code`)
    if (consumers.has(consumer.name)) problems.push(`${what}: two consumers have this name`)
    consumers.add(consumer.name)
    checkWork(what, consumer.feature, consumer.purpose, consumer.providers)
    if (!CONSUMER_ROLES.includes(consumer.role)) {
      problems.push(`${what}: ${consumer.role} can't move a checkpoint (${CONSUMER_ROLES.join(', ')})`)
    }
    for (const type of consumer.types) {
      if (!Object.hasOwn(EVENTS, type)) problems.push(`${what}: ${type as EventType} is not an event type`)
    }
    if (
      consumer.batch !== undefined &&
      !(Number.isInteger(consumer.batch) && consumer.batch >= 1 && consumer.batch <= 10_000)
    ) {
      problems.push(`${what}: a batch is 1 to 10,000 events`)
    }
    if (!(consumer.lagBudgetMs > 0)) problems.push(`${what}: lagBudgetMs must be positive`)
    // A protective consumer's events are never withheld for a subject's processing switch, so only
    // Hearth's own account work may be one: revocation (T19 item 4, S8).
    if (consumer.protective !== undefined && (consumer.feature !== 'core.system' || consumer.purpose !== 'accounts')) {
      problems.push(`${what}: only a consumer under core.system with purpose accounts may be protective`)
    }
  }

  if (problems.length > 0) throw new Error(`The worker's registries break its rules:\n  ${problems.join('\n  ')}`)
}
