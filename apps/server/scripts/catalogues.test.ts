import { FLAGS } from '@hearth/shared'
import { describe, expect, it } from 'vitest'
import type { Coverage } from '#src/outbox/coverage.ts'
import {
  bodyProblems,
  bodyWrites,
  contentProblems,
  coverageProblems,
  eventProblems,
  type Fn,
  flagProblems,
  matchProblems,
  roleProblems,
} from './catalogues.ts'

const writes: Record<string, Coverage> = {
  'hearth_app people:INSERT': { events: ['person.added'] },
  'hearth_app people.full_name:UPDATE': { events: ['person.updated'] },
  'hearth_app audit_events:INSERT': { exempt: 'the audit log is itself the record of the change' },
  'keep_history()': { exempt: 'a check', writes: [] },
}
const grants = [
  { role: 'hearth_app', table: 'people', op: 'INSERT' },
  { role: 'hearth_app', table: 'people', op: 'UPDATE', column: 'full_name' },
  { role: 'hearth_app', table: 'audit_events', op: 'INSERT' },
] as const
const functions = [{ key: 'keep_history()', definer: false, trigger: true }]

describe('C0.6 T16 item 7 check-catalogues: every way to write is covered', () => {
  it('passes when every grant and reachable function has its entry and no entry is stale', () => {
    expect(coverageProblems(writes, grants, functions)).toEqual([])
  })

  it('names a grant with no entry, with the key to add', () => {
    const problems = coverageProblems(
      writes,
      [...grants, { role: 'hearth_app', table: 'people', op: 'UPDATE', column: 'phone' }],
      functions,
    )
    expect(problems).toEqual([
      "hearth_app may UPDATE public.people.phone, but apps/server/src/outbox/coverage.ts doesn't say which event covers it or why it's exempt: add 'hearth_app people.phone:UPDATE'",
    ])
  })

  it('names a new definer or trigger function with no entry, and one whose entry lists no writes', () => {
    const problems = coverageProblems({ ...writes, 'set_x(text)': { events: ['flag.changed'] } }, grants, [
      ...functions,
      { key: 'set_x(text)', definer: true, trigger: false },
      { key: 'zz()', definer: false, trigger: true },
    ])
    expect(problems).toEqual([
      "apps/server/src/outbox/coverage.ts's 'set_x(text)' must list the writes it makes (writes: [] if none)",
      expect.stringContaining('the trigger function public.zz() can run in a runtime transaction'),
    ])
  })

  it('names a stale entry: a grant or function that no longer exists', () => {
    expect(coverageProblems(writes, grants.slice(1), functions)).toEqual([
      expect.stringContaining(
        "covers 'hearth_app people:INSERT', which no runtime role's grant or reachable function matches",
      ),
    ])
  })

  it('needs MATCH for every table an event covers, naming a real column', () => {
    const columns = new Set(['people.id'])
    expect(matchProblems(writes, { people: 'id' }, columns)).toEqual([])
    expect(matchProblems(writes, {}, columns)).toEqual([
      expect.stringContaining("'hearth_app people:INSERT' needs an event, but MATCH"),
      expect.stringContaining("'hearth_app people.full_name:UPDATE' needs an event, but MATCH"),
    ])
    expect(matchProblems(writes, { people: 'person_id' }, columns)).toEqual([
      "apps/server/src/outbox/coverage.ts's MATCH names public.people.person_id, which doesn't exist",
    ])
    // A function's writes count too.
    expect(
      matchProblems({ 'f()': { events: ['flag.changed'], writes: ['feature_flags.enabled:UPDATE'] } }, {}, columns),
    ).toEqual([expect.stringContaining('which column of feature_flags the event must name')])
  })

  it('refuses an exemption for a content table: one whose writes append events with a snapshot', () => {
    const content: Record<string, Coverage> = {
      'hearth_app messages:INSERT': { events: ['message.created'] },
      'hearth_app messages.body:UPDATE': { exempt: 'nobody reads it' },
    }
    expect(contentProblems(content, type => type === 'message.created')).toEqual([
      expect.stringContaining("'hearth_app messages.body:UPDATE' is exempt, but writes messages, which holds content"),
    ])
    expect(contentProblems(content, () => false)).toEqual([])
    expect(contentProblems(writes)).toEqual([])
  })

  it('CONTRACT-7: a content table is content whatever its entries say: an all-exempt one, or one a function writes, is refused', () => {
    // Every entry exempt, by grant and through a definer function: nothing carries a snapshot, so
    // only CONTENT_TABLES says messages is content.
    const exempt: Record<string, Coverage> = {
      'hearth_app messages:INSERT': { exempt: 'nobody reads it' },
      'post_message(uuid, text)': { exempt: 'a check', writes: ['messages:INSERT'] },
      'hearth_app people:INSERT': { exempt: 'not content' },
    }
    expect(contentProblems(exempt, () => false, ['messages'])).toEqual([
      "'hearth_app messages:INSERT' is exempt, but writes messages, which holds content, whose every write appends its event with an ACL snapshot",
      "'post_message(uuid, text)' is exempt, but writes messages, which holds content, whose every write appends its event with an ACL snapshot",
    ])
    expect(contentProblems(exempt, () => false, [])).toEqual([])
    // A grant covered by a snapshot event makes the table content, so an exempt function writing
    // it is refused too.
    const mixed: Record<string, Coverage> = {
      'hearth_app messages:INSERT': { events: ['message.created'] },
      'post_message(uuid, text)': { exempt: 'a check', writes: ['messages:INSERT'] },
    }
    expect(contentProblems(mixed, type => type === 'message.created', [])).toEqual([
      expect.stringContaining("'post_message(uuid, text)' is exempt, but writes messages"),
    ])
  })

  it('CONTRACT-1: reads the tables a function body writes, schema-qualified, by operation', () => {
    expect(
      bodyWrites(`
        update public.people set full_name = x where id = y;
        insert into public.audit_events (org_id) values (o);
        insert into public.outbox_floors as f (org_id) values (o) on conflict (org_id) do update set last_id = 1;
        delete from public.jobs j using doomed d where j.id = d.id;
        select 1 from public.people for no key update;
        DELETE  FROM  public.Jobs;`),
    ).toEqual([
      { table: 'people', op: 'UPDATE', column: 'full_name' },
      { table: 'audit_events', op: 'INSERT' },
      { table: 'outbox_floors', op: 'INSERT' },
      { table: 'outbox_floors', op: 'UPDATE', column: 'last_id' },
      { table: 'jobs', op: 'DELETE' },
    ])
  })

  it('R2DB-3: reads an upsert’s DO UPDATE SET as an UPDATE of each column it sets', () => {
    expect(
      bodyWrites(`insert into public.outbox_floors as f (org_id, last_tx) values (o, t)
        on conflict (org_id) do update set last_tx = excluded.last_tx, last_id = greatest(f.last_id, 1)
        where f.org_id = o;`),
    ).toEqual([
      { table: 'outbox_floors', op: 'INSERT' },
      { table: 'outbox_floors', op: 'UPDATE', column: 'last_tx' },
      { table: 'outbox_floors', op: 'UPDATE', column: 'last_id' },
    ])
  })

  it('R2DB-3: reads ONLY, quoted names and every column of a SET list, and stops where the list ends', () => {
    expect(bodyWrites('delete from only public.jobs; update only public.schedules set paused = true;')).toEqual([
      { table: 'jobs', op: 'DELETE' },
      { table: 'schedules', op: 'UPDATE', column: 'paused' },
    ])
    expect(
      bodyWrites(`delete from "public"."jobs";
        update public."people" p set "full_name" = n, title = case when x then 'a' else 'b' end,
          (manager_id, department_id) = (m, d), tags = array[1, 2]
        from public.teams t, public.orgs o where p.id = t.id returning p.id, p.org_id;`),
    ).toEqual([
      { table: 'jobs', op: 'DELETE' },
      { table: 'people', op: 'UPDATE', column: 'full_name' },
      { table: 'people', op: 'UPDATE', column: 'title' },
      { table: 'people', op: 'UPDATE', column: 'manager_id' },
      { table: 'people', op: 'UPDATE', column: 'department_id' },
      { table: 'people', op: 'UPDATE', column: 'tags' },
    ])
    expect(
      bodyWrites('with d as (delete from public.jobs returning id) update public.t set a = 1 returning a, b'),
    ).toEqual([
      { table: 'jobs', op: 'DELETE' },
      { table: 't', op: 'UPDATE', column: 'a' },
    ])
  })

  it('Qodo-18 #3: reads quoted table and column names of any case and characters, and refuses a name it can’t read', () => {
    expect(
      bodyWrites(`insert into public."AuditData" (org_id) values (o);
        INSERT INTO "public"."Audit ""Log""" (org_id) values (o);
        delete from only public."Jobs-Old";
        update public."People" "P" set "FullName" = n, ("Title", plain) = (t, p), "Tags"[1] = x where "P".id = y;
        merge into public."Café" c using s on c.id = s.id when matched then update set "Prix" = 1;
        update public.people set "Full""Name" = n;`),
    ).toEqual([
      { table: 'AuditData', op: 'INSERT' },
      { table: 'Audit "Log"', op: 'INSERT' },
      { table: 'Jobs-Old', op: 'DELETE' },
      { table: 'People', op: 'UPDATE', column: 'FullName' },
      { table: 'People', op: 'UPDATE', column: 'Title' },
      { table: 'People', op: 'UPDATE', column: 'plain' },
      { table: 'People', op: 'UPDATE', column: 'Tags' },
      { table: 'Café', op: 'UPDATE', column: 'Prix' },
      { table: 'people', op: 'UPDATE', column: 'Full"Name' },
    ])
    // Unquoted names fold to lower case, as Postgres folds them.
    expect(bodyWrites('UPDATE public.People SET FullName = n;')).toEqual([
      { table: 'people', op: 'UPDATE', column: 'fullname' },
    ])
    // A name after public. it can't read is the table '?', which no entry lists.
    expect(bodyWrites('insert into public.9x (a) values (1);')).toEqual([{ table: '?', op: 'INSERT' }])
    const fn: Fn = {
      key: 'f()',
      definer: true,
      trigger: false,
      source: 'insert into public."AuditData" (a) values (1);',
    }
    expect(bodyProblems({ 'f()': { exempt: 'a check', writes: ['auditdata:INSERT'] } }, [fn], [], {})).toEqual([
      expect.stringContaining('runs insert into public.AuditData, but its entry'),
    ])
    expect(bodyProblems({ 'f()': { exempt: 'a check', writes: ['AuditData:INSERT'] } }, [fn], [], {})).toEqual([])
    const unreadable: Fn = { ...fn, source: 'delete from public.9x;' }
    expect(bodyProblems({ 'f()': { exempt: 'a check', writes: [] } }, [unreadable], [], {})).toEqual([
      expect.stringContaining("runs delete from a table of public whose name check-catalogues can't read"),
    ])
  })

  it('Qodo-18 round 3 #4: reads a MERGE by its own action clauses: an update-only one is only its UPDATE', () => {
    const source = `merge into public.jobs j using src s on j.id = s.id
        when matched then update set state = 'cancelled'
        when not matched then do nothing;
      insert into public.audit_events (org_id) values (o);`
    expect(bodyWrites(source)).toEqual([
      { table: 'jobs', op: 'UPDATE', column: 'state' },
      { table: 'audit_events', op: 'INSERT' },
    ])
    const fn: Fn = { key: 'f()', definer: true, trigger: false, source }
    expect(
      bodyProblems(
        { 'f()': { exempt: 'a check', writes: ['jobs.state:UPDATE', 'audit_events:INSERT'] } },
        [fn],
        [],
        {},
      ),
    ).toEqual([])
    // A MERGE that only deletes, or only inserts, is that alone.
    expect(bodyWrites('merge into public.jobs j using s on true when matched then delete;')).toEqual([
      { table: 'jobs', op: 'DELETE' },
    ])
    expect(
      bodyWrites('merge into public.jobs j using s on false when not matched then insert (id) values (s.id);'),
    ).toEqual([{ table: 'jobs', op: 'INSERT' }])
  })

  it('R2DB-3: reads MERGE INTO as an INSERT, a DELETE and an UPDATE of the columns it sets', () => {
    expect(
      bodyWrites(`merge into public.jobs j using src s on j.id = s.id
        when matched and s.done then update set state = 'succeeded', lease_token = null
        when matched then delete
        when not matched then insert (id) values (s.id);`),
    ).toEqual([
      { table: 'jobs', op: 'INSERT' },
      { table: 'jobs', op: 'DELETE' },
      { table: 'jobs', op: 'UPDATE', column: 'state' },
      { table: 'jobs', op: 'UPDATE', column: 'lease_token' },
    ])
  })

  it('R2DB-3: ignores writes named in comments and string literals', () => {
    expect(
      bodyWrites(`-- we never delete from public.people
        /* nor insert into public.jobs /* nested */ here */
        raise exception 'update public.people set full_name = x';
        perform pg_catalog.format(E'delete from public.jobs \\' it', $q$insert into public.jobs$q$);
        select $1;`),
    ).toEqual([])
  })

  it('CONTRACT-1: names a function whose body writes a table its writes leave out, unless every caller holds that write', () => {
    const entries: Record<string, Coverage> = {
      'rename_person(uuid, text)': { events: ['person.updated'], writes: ['people.full_name:UPDATE'] },
      'set_x(text)': { events: ['flag.changed'], writes: ['feature_flags.enabled:UPDATE'] },
      'end_all()': { exempt: 'a check', writes: [] },
    }
    const body = [
      {
        key: 'rename_person(uuid, text)',
        definer: true,
        trigger: false,
        executors: ['hearth_app'],
        source:
          'update public.people set full_name = n; delete from public.jobs; insert into public.feature_flags (key) values (k);',
      },
      // Its audit row is covered by its one caller's own grant.
      {
        key: 'set_x(text)',
        definer: true,
        trigger: false,
        executors: ['hearth_app'],
        source: 'update public.feature_flags set enabled = e; insert into public.audit_events (action) values (a);',
      },
      // A trigger's caller is whoever writes its table, so only its writes count.
      {
        key: 'end_all()',
        definer: false,
        trigger: true,
        executors: [],
        source: 'insert into public.audit_events values (1);',
      },
    ]
    expect(bodyProblems(entries, body, grants, {})).toEqual([
      "public.rename_person(uuid, text) runs delete from public.jobs, but its entry in apps/server/src/outbox/coverage.ts doesn't list that write: add 'jobs:DELETE' to its writes",
      "public.rename_person(uuid, text) runs insert into public.feature_flags, but its entry in apps/server/src/outbox/coverage.ts doesn't list that write: add 'feature_flags:INSERT' to its writes",
      "public.end_all() runs insert into public.audit_events, but its entry in apps/server/src/outbox/coverage.ts doesn't list that write: add 'audit_events:INSERT' to its writes",
    ])
    // A caller without the grant doesn't excuse it.
    expect(
      bodyProblems(
        entries,
        body.slice(1, 2).map(fn => ({ ...fn, executors: ['hearth_app', 'hearth_queue'] })),
        grants,
        {},
      ),
    ).toEqual([expect.stringContaining('public.set_x(text) runs insert into public.audit_events')])
  })

  it('R2DB-3: compares an UPDATE column by column, in the caller-grant excuse too', () => {
    const entries: Record<string, Coverage> = {
      'finish(uuid)': { exempt: 'a check', writes: ['jobs.state:UPDATE'] },
      'rename(uuid)': { events: ['person.updated'], writes: [] },
    }
    const fns = [
      {
        key: 'finish(uuid)',
        definer: true,
        trigger: false,
        executors: ['hearth_queue'],
        source: 'update public.jobs set state = 1, lease_token = null where id = $1;',
      },
      // hearth_app may update people.full_name, but not people.title.
      {
        key: 'rename(uuid)',
        definer: true,
        trigger: false,
        executors: ['hearth_app'],
        source: 'update public.people set full_name = n, title = t;',
      },
    ]
    expect(bodyProblems(entries, fns, grants, {})).toEqual([
      "public.finish(uuid) runs update public.jobs set lease_token, but its entry in apps/server/src/outbox/coverage.ts doesn't list that write: add 'jobs.lease_token:UPDATE' to its writes",
      "public.rename(uuid) runs update public.people set title, but its entry in apps/server/src/outbox/coverage.ts doesn't list that write: add 'people.title:UPDATE' to its writes",
    ])
    // An upsert's update counts too: the floor's last_tx is written by the DO UPDATE.
    expect(
      bodyProblems(
        { 'floor(uuid)': { exempt: 'a check', writes: ['outbox_floors:INSERT', 'outbox_floors.last_id:UPDATE'] } },
        [
          {
            key: 'floor(uuid)',
            definer: true,
            trigger: false,
            executors: ['hearth_queue'],
            source:
              'insert into public.outbox_floors (org_id) values (o) on conflict (org_id) do update set last_id = 1, last_tx = 2;',
          },
        ],
        grants,
        {},
      ),
    ).toEqual([expect.stringContaining("add 'outbox_floors.last_tx:UPDATE' to its writes")])
  })

  it('R2DB-3: refuses a body it can’t read: BEGIN ATOMIC, and EXECUTE outside DYNAMIC_DDL', () => {
    const entries: Record<string, Coverage> = {
      'atomic()': { exempt: 'a check', writes: [] },
      'dynamic()': { exempt: 'a check', writes: [] },
      'ddl()': { exempt: 'a check', writes: [] },
      'quiet()': { exempt: 'a check', writes: [] },
    }
    const fns = [
      { key: 'atomic()', definer: true, trigger: false, executors: [], source: '', atomic: true },
      {
        key: 'dynamic()',
        definer: true,
        trigger: false,
        executors: [],
        source: "begin execute pg_catalog.format('delete from public.%I', t); end",
      },
      { key: 'ddl()', definer: true, trigger: false, executors: [], source: "begin execute 'create table x ()'; end" },
      // The word only in a comment or a message is no EXECUTE.
      {
        key: 'quiet()',
        definer: true,
        trigger: false,
        executors: [],
        source: "begin -- never execute anything\n raise exception 'cannot execute this'; end",
      },
    ]
    expect(bodyProblems(entries, fns, grants, { 'ddl()': 'creates a table' })).toEqual([
      "public.atomic() is written with BEGIN ATOMIC, whose writes check-catalogues can't read: write its body as a quoted string (as $$ ... $$)",
      "public.dynamic() runs dynamic SQL (EXECUTE), whose writes check-catalogues can't read: write them as plain statements, or, if it only changes the schema, add it to DYNAMIC_DDL in apps/server/scripts/catalogues.ts with why",
    ])
    expect(bodyProblems(entries, fns.slice(2), grants, { 'ddl()': 'x', 'gone()': 'y' })).toEqual([
      'DYNAMIC_DDL in apps/server/scripts/catalogues.ts lists gone(), which no reachable function is: remove it',
    ])
  })
})

describe('C0.6 check-catalogues: the catalogues equal the database', () => {
  it('compares the event names both ways', () => {
    expect(eventProblems(['a.done', 'b.done'], ['b.done', 'a.done'])).toEqual([])
    expect(eventProblems(['a.done', 'b.done'], ['b.done', 'c.done'])).toEqual([
      'a.done is in packages/shared EVENTS but not in outbox_events_type: a migration adds it',
      'c.done is in outbox_events_type but not in packages/shared EVENTS: add it to the catalogue',
    ])
  })

  it('compares the flag registry with feature_flag_defaults() both ways, and keeps every AI flag off and locked', () => {
    const defaults = Object.entries(FLAGS).map(([key, spec]) => ({ key, enabled: spec.default, locked: spec.locked }))
    expect(flagProblems(FLAGS, defaults)).toEqual([])
    const changed = defaults.map(row => (row.key === 'core.system' ? { ...row, locked: false } : row))
    expect(flagProblems(FLAGS, changed)).toEqual([
      'core.system: FLAGS says default true, locked true; feature_flag_defaults() says true, false',
    ])
    expect(flagProblems(FLAGS, [...defaults, { key: 'ai.extra', enabled: true, locked: false }])).toEqual([
      'ai.extra is in feature_flag_defaults() but not in packages/shared FLAGS: register it',
      'ai.extra is an AI flag, so feature_flag_defaults() must keep it off and locked until A0',
    ])
    expect(
      flagProblems(
        FLAGS,
        defaults.filter(row => row.key !== 'ai.ask'),
      ),
    ).toEqual(['ai.ask is in packages/shared FLAGS but not in feature_flag_defaults(): a migration adds it'])
    const unlocked = { ...FLAGS, 'ai.ask': { ...FLAGS['ai.ask'], locked: false } }
    expect(flagProblems(unlocked, defaults)).toContain(
      'ai.ask is an AI flag, so FLAGS must keep it off and locked until A0',
    )
  })

  it('compares the job roles both ways', () => {
    expect(roleProblems(['hearth_queue'], ['hearth_queue'])).toEqual([])
    expect(roleProblems(['hearth_queue', 'hearth_job_x'], ['hearth_queue', 'hearth_job_y'])).toEqual([
      "hearth_job_x is in apps/server/src/db/roles.ts JOB_ROLES, but hearth_worker can't SET it in the database",
      "hearth_worker can SET hearth_job_y, which apps/server/src/db/roles.ts JOB_ROLES doesn't list",
    ])
  })
})
