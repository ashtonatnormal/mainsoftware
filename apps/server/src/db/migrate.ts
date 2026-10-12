// The migrate step (T3, INF-MIGRATE): applies db/migrations/ to a database. In AWS it runs before
// each deploy as a one-off task from the server image (`node src/db/migrate.ts`, C0.11), with a
// login that may act as hearth_owner; scripts/check-migrations.sh runs it on CI's scratch
// database, and scripts/db-local.sh on the local stack's.
//
//   MIGRATION_DATABASE_URL  postgres://… for a login that is hearth_owner or a member of it
//   MIGRATION_ROLE          the role every migration runs as (default hearth_owner)
//   --before NNNN           apply only the migrations numbered below NNNN (an upgrade test)
//
// It prints one line per migration applied and exits 1 if any fails, after Postgres has rolled
// the whole batch back. It never prints the connection string.
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { migrate, ROLE_NAME, TransactionEndedError } from '#src/db/migrations.ts'

const Env = z.object({
  MIGRATION_DATABASE_URL: z
    .string({ error: 'is required' })
    .refine(value => /^postgres(ql)?:\/\//.test(value), 'must be a postgres:// URL'),
  MIGRATION_ROLE: z.string().regex(ROLE_NAME, 'must be a role name').default('hearth_owner'),
})

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { before: { type: 'string' } }, strict: true })
  if (values.before !== undefined && !/^\d{4}$/.test(values.before)) {
    console.error('migrate: --before takes a 4-digit migration number')
    return 2
  }
  const env = Env.safeParse(process.env)
  if (!env.success) {
    // The issue names the variable and the problem, never its value.
    for (const issue of env.error.issues) console.error(`migrate: ${issue.path.join('.')} ${issue.message}`)
    return 2
  }

  const { error, results = [] } = await migrate({
    databaseUrl: env.data.MIGRATION_DATABASE_URL,
    role: env.data.MIGRATION_ROLE,
    ...(values.before === undefined ? {} : { before: values.before }),
  })
  for (const result of results) {
    if (result.status === 'Success') console.log(`migrate: applied ${result.migrationName}`)
    if (result.status === 'Error') console.error(`migrate: failed ${result.migrationName}`)
  }
  if (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`migrate: ${message}`)
    if (error instanceof TransactionEndedError) {
      console.error('migrate: everything that ran before that COMMIT is committed; check the database before retrying')
    } else if (results.some(result => result.status === 'Success')) {
      console.error('migrate: nothing was applied; the batch rolled back')
    }
    return 1
  }
  if (results.length === 0) console.log('migrate: nothing to apply')
  return 0
}

process.exitCode = await main().catch((error: unknown) => {
  console.error(`migrate: ${error instanceof Error ? error.message : String(error)}`)
  return 1
})
