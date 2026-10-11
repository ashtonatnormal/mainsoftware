# Hearth — Engineering Contract

Hearth is an internal work suite (chat, drop-in voice rooms, meetings, calendar, tasks, and a Drive holding docs and wiki, sheets, slides and files) where AI agents are teammates, built over a permission-aware Org Brain. Its first customer is our own organisation, moving its work communication off WhatsApp. It is not an email client, a guest or cross-org tool, an integrations hub, a full Excel or PowerPoint replacement, or an assistant that acts on anyone's behalf. Spec: `docs/PRD.md`, where a decision (`Dn`) beats a requirement that disagrees with it. Keep each module at the depth its P0 rows set (D18).

- Build → simplify → automate. Start with manual input.
- Scope guard: do NOT build email, external guests or shared channels, third-party integrations, native apps, agent computers, macros, pivot tables or other full Office parity, an assistant that sends or edits for a user (D16), WhatsApp import (D17), billing or self-serve sign-up, or AI scoring of what people say or voiceprints (D34). The full list is PRD §3.2.
- Stack (D37): TypeScript strict end to end in an npm-workspaces monorepo (`apps/web`, `apps/server`, `packages/shared`, `packages/access`, `infra/`; `demo/` stays as the reference UI). Node 24 LTS. Web: Vite + React 19 + Tailwind v4 as an installable PWA. Server: Fastify + `ws`. PostgreSQL 17 (RDS; pgvector later), Valkey, S3, LiveKit Cloud. AWS CDK in ap-southeast-1. Vitest, Playwright, Biome. Not Next.js, Supabase or Vercel: hosting is AWS ap-southeast-1 (D37, B.6), and the server runs long-lived WebSocket, Yjs and recorder processes that serverless hosts don't. LiveKit Cloud metadata and OpenAI transcription still leave Singapore and are recorded in PDPA-10. The build plan's technical decisions (T1–T12) will live in `docs/TECH-SPEC.md` once that plan merges.

## Product rules that never bend
- Never leak (Principle 1). Every access check goes through `packages/access`; no screen or endpoint checks access its own way. Every AI feature retrieves through the one permission-enforcing retrieval layer (B.4) and never queries the index directly.
- Every record belongs to an org (ACC-11): every table has `org_id`, and no query runs without it.
- Recording is never hidden (Principle 6): every room and call UI shows the recording indicator.
- The personal assistant suggests and drafts; it never sends, edits, creates or deletes for a user (D16).
- Content is data, not instructions (Rule 8).
- Privileged access (Rule 9) happens only in the DPO and Compliance consoles, against a logged case with a stated reason. It is never available to any AI feature.

## Git
- Never commit directly to `main`. Create a feature branch.
- This repository is public: anything pushed, on any branch, stays public even after the branch is deleted.
- Keep PRs small and focused. Use Conventional Commit titles: `feat(scope): …`, `fix(scope): …`, `chore: …`, `docs: …`, `ci: …`. Name the migration in the title when a PR adds one, e.g. `feat(db): … (0006)`. Cite requirement and decision IDs (CHAT-04, D39) in commit messages and test names. Squash-merge.
- Claude may merge without asking only a PR whose head branch is in this repository (not a fork) and that Claude opened or the user asked it to merge, once all three hold on its latest commit: CodeRabbit has approved it; Qodo has reviewed it and left no open "Action required" finding (no Qodo review on the latest commit means this isn't met); the CI checks (`check`, `migrations`) passed. Hold the merge while the PR description lists unticked "Before merging" steps.
- A PR that adds or changes a file in `db/migrations/`, or the privileged module's allow-list, lists an unticked "Before merging: @ashtonatnormal has read it" step. Only the user ticks it or tells Claude to go ahead: CodeRabbit skips migrations, and the user can't formally approve PRs opened under their own account.
- Never bypass CI or branch protection. Never merge past red CI. Don't post `@coderabbitai approve` unless the user asks: the approval must come from CodeRabbit's own review. Never resolve a CodeRabbit or Qodo thread unless the commit that fixes it is pushed; if you disagree with a finding, reply with your reason and leave the thread for the user. Resolving threads to unlock an approval counts as bypassing review.
- `main` protection lives in `.github/rulesets/protect-main.json`. A repo admin applies it with `scripts/protect-main.sh`, or imports the file under Settings → Rules → Rulesets. Change it only by PR; never loosen it in the GitHub UI. If it isn't live, say so rather than assume `main` is protected.
  - Changes land only through a PR with 1 approval (CodeRabbit's counts). A new push dismisses earlier approvals, and every review thread must be resolved. Only squash merges.
  - The required checks (`check`, `migrations`) must pass on a branch that is up to date with `main`.
  - No force-pushes, no deleting `main`, no bypass actors (admins included).
- After every Claude response, a Stop hook (`.claude/hooks/auto-push.sh`) commits and pushes the current branch as a checkpoint (`chore(auto): checkpoint after Claude Code run`). Opt out with `HEARTH_AUTOPUSH=0`. The hook never runs on `main`/`master`, never commits files or token shapes it recognises as secrets, skips while a merge or rebase is in progress, and never force-pushes. Checkpoints aren't gated and may be red; the gates are the pre-PR check and green CI before merge. The hook pushes every file that isn't git-ignored, so anything holding people's data goes only under `/local-data/` (git-ignored).

## Database (PostgreSQL)
- Never modify the production schema by hand. Every schema change is a migration in `db/migrations/`, named `<NNNN>_<name>.sql`, applied in name order to an empty database in one transaction (as Drizzle and Kysely do). Migrations are plain SQL: no psql meta-commands, and a migration never ends its own transaction. When the migration tool is chosen, `scripts/check-migrations.sh` switches to that tool's migrator. No direct production changes.
- Roles:
  - `hearth_owner` runs migrations and owns every table, view, function and schema. It is NOSUPERUSER; anything that needs more (an untrusted extension, a `BYPASSRLS` role) is a bootstrap step in `infra/` and in `scripts/check-migrations.sh`, never a migration.
  - `hearth_app` is the runtime role: NOSUPERUSER, NOBYPASSRLS, owns nothing, and is never a member of `hearth_owner` or of any role that owns tables or has `BYPASSRLS` (a member of a table's owner skips RLS just like the owner).
  - Migrations create roles NOLOGIN or without a password; passwords and IAM auth are set outside git (Secrets Manager). Roles belong to the whole server, so a migration that finds a role already there asserts its attributes and memberships instead of skipping it silently.
- RLS is on for every table. Policies are org-scoped, the second line of defence behind `packages/access`. They read `nullif(current_setting('app.org_id', true), '')::uuid`, so a missing org means no rows. CI fails if any table has RLS off.
- The server sets the org and user only inside a transaction, through one helper in `apps/server/src/db/`: `BEGIN`, `select set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)`, the work, then `COMMIT` or `ROLLBACK` before the client goes back to the pool. Both values come from the server-side session (opaque, revocable tokens), never from the request. Never `SET app.*` or `set_config(…, false)` on a pooled connection. Jobs and WebSocket handlers use the same helper with their own org.
- New tables, views and functions get no grants by default:
  - Grant `hearth_app` only the SELECT/INSERT/UPDATE/DELETE each table needs, in the same migration. Never ALL, TRUNCATE, TRIGGER or REFERENCES: TRUNCATE ignores RLS and empties every org's rows.
  - Run `revoke execute … from public` on every new function (Postgres grants it to everyone otherwise).
  - Create views `with (security_invoker = true)` so RLS still applies. Never grant a materialized view (RLS can't apply to it); precompute per-org rows into a table with RLS instead.
- `audit_events` (and later `data_access_events`) is append-only: `hearth_app` gets INSERT, plus SELECT only where a policy allows the reader, and never UPDATE, DELETE or TRUNCATE. DB tests prove it.
- Never let the browser reach a privileged credential (the owner or any `BYPASSRLS` role, AWS keys, provider keys). Server-only variables never get a `VITE_` prefix (Vite ships those to the browser). In AWS they live in Secrets Manager, never in code or plain config.
- The browser never talks to Postgres. Every read and write goes through the server.
- The Rule 9 module (`apps/server/src/db/privileged.ts`) is the only code that bypasses RLS. It uses its own database role and credential, which no other job or service can assume. Only the DPO and Compliance consoles import it; every read through it is logged with its case and reason (Rule 9, ADM-06); it makes no outbox or index writes; AI code never imports it. A guard test next to it (`privileged-imports.test.ts`, added in the same PR) keeps the allow-list. Like Module One's `admin-imports.test.ts`, it catches static and dynamic imports, re-exports, `require()` and `vi.mock()`-style calls, and any other code reading the module's credential. It also fails on any `VITE_` variable in source or `.env.example` whose name contains KEY, SECRET, TOKEN, PASSWORD or PRIVATE. Adding a file to the list is a reviewed change.
- Every system job (retention, indexer, recorder, calculation and conversion workers) gets its own role with only the grants it needs. None gets `BYPASSRLS`, and no single service credential can read every transcript (PDPA-12).
- Admin powers are roles (ACC-10) held as rows. `packages/access` (`can()`) decides every admin action, and RLS stays org-scoped.
  - Every path that sets roles (role assignment and roster CSV import, ADM-02, ACC-03) runs the same server-side checks on every row and writes an audit event (ADM-06).
  - Nobody changes their own roles, alone or by approving a grant to themselves. Nobody can promote themselves.
  - Until the PRD decides otherwise, only an Owner grants or removes Owner, Admin, AI Admin, Leadership, DPO and Compliance Officer; Admins assign Team Admin and Member. DPO and Compliance Officer grants open Rule 9 access, so they also need a second approver and alert the DPO.
  - The first Owner and the DPO (D35) come from a reviewed bootstrap, never from the console or an API.
  - Every admin action needs re-authentication (§9.4).
- A write `hearth_app` has no grant for goes through one `SECURITY DEFINER` function declared `set search_path = ''`, with every object schema-qualified (`public.people`). A plain `search_path = public` lets a temporary table stand in for a real one. The server calls the function only after `can()` allows the action, passing the acting user; the function re-checks that user's role and org in tables and writes an audit event. Sign-in and session lookups that run before the org is known (token hash → session, phone → user) are narrow functions of the same kind that return only ids.
- Rows that carry history (people, teams, channels, sessions) are archived or soft-removed (`archived_at`, `removed_at`), not deleted. Record who did what and when in `*_by` / `*_at` columns. Content the PRD says to delete (CHAT-05, FILE-02's Trash after 30 days, Rule 7, PDPA-09 retention) is deleted for real, but only through the deletion and retention code, for rows and S3 objects alike. That code checks holds (ADM-08), cascades to derived content and logs each deletion (PDPA-09).
- Store the context a record was made in (e.g. the team or channel it belonged to). Later moves must not rewrite history.
- Compute values that depend on a tunable settings row (e.g. retention "delete after" dates, overdue flags, a session's "substantive" status) from stored raw values plus that row, never from a stored derived column, so tuning the setting re-applies to history. Fields people set (a task's status and due date, TASK-01) are raw values. Caches of derived data (computed sheet values, thumbnails, index rows) may be stored if they can be recomputed and are deleted with their source (PDPA-09), but they're never the source of truth.
- Enforce hierarchy (folders, teams, departments) and other invariants with DB triggers whose error messages the UI can show as is. Run tree changes under READ COMMITTED.
- Tables that hold Rule 9 case material get no grants to `hearth_app`; only the Rule 9 module reaches them.
- File storage (S3):
  - Use private buckets per data class. Object keys are `<org_id>/<random id>`, made by the server and never changed. The filename, owner, folder and ACL live in the database, and access decisions never read the key.
  - Uploads go to a quarantine prefix through a presigned URL the server issues per upload. The URL signs `If-None-Match: *` (so it can't overwrite) and the size the server checked against the limits. The server sets the stored content type from the bytes, never from the client, and a file is served only after the malware scan promotes it. Uploaded files are parsed only in an isolated worker with no network access, and macros never run (§9.4).
  - Downloads: the server checks access, logs the view where the PRD asks (REC-21), and issues a signed GET URL that expires within 60 s, on a separate user-content origin, never the app origin. Anything not on the preview allow-list is served as an attachment with a safe content type; HTML and SVG never render inline.
  - S3 lifecycle rules (defined in `infra/`, never set by hand) only change storage class. Retention deletes are done by the retention engine (PDPA-09, ADM-07). It checks legal holds first (ADM-08), deletes every version in a versioned bucket, and logs each deletion. Held recordings also get an S3 Object Lock legal hold. An age-based expiry may only be a backstop for objects the engine has released. B.6's "deleted at 120/360 days" lifecycle row predates this; PDPA-09, REC-23 and ADM-08 win.
  - Sensitive deletes go through a checked DB function that logs which files to delete. The server removes only those files and stamps the log row, and a daily job retries unstamped rows.
- DB tests live in `db/tests/` (`scripts/test-db.sh`). Each table's tests cover signed out, a member of another org, and every ACC-10 role (Member, Team Admin, Admin, Owner, AI Admin, Leadership, DPO, Compliance Officer), including the roles that must see nothing. A test switches to the role it checks with `set local role`; otherwise it runs as a superuser and passes trivially. Rule 9 reads are tested in the Rule 9 module's own tests, not through RLS. Rules 1–9 also get named cases in `packages/access`'s test suite.

## Security and privacy
- Never commit secrets. `.env*` is git-ignored except `.env.example`, which documents every variable with a comment.
- Never disable auth checks or weaken RLS or access rules without explicit review.
- The session token lives only in a `__Host-` cookie marked `HttpOnly; Secure; SameSite=Lax`, never in storage JavaScript can read. State changes are never GETs. One Fastify hook refuses any cookie-authenticated non-GET request whose `Origin` isn't exactly the app origin (a missing or `null` Origin included), and the WebSocket upgrade handler makes the same check before accepting. Provider webhooks (LiveKit, SMS) carry no session and verify the provider's signature instead.
- Never send a third-party API key to the browser, not even a short-lived one. The server opens the connection and passes back only what the browser needs. The one exception is the LiveKit participant token, which LiveKit requires:
  - The server mints it after `can()` allows joining, for one room and the session's identity.
  - It lasts minutes, not the SDK's 6-hour default.
  - `canPublish` and `canSubscribe` are set from the access check.
  - People's tokens never get `hidden`, recorder or admin grants; only Hearth's own recorder and agent workers get those, server-side.
  - Expiry only gates joining, so when someone loses access the server removes them from the room within 60 s (Rule 6).
- Write any local output that holds people's data (exports, transcript comparisons, test-set clips from §9.5) only under `/local-data/`, which is git-ignored.
- Coding agents (Claude Code sessions, CI) never connect to production or read production data. Production access is logged (§9.4) and never uses the Rule 9 module's credential. Any analysis looks at totals and shares, never one person's rows, and leaves out groups small enough to identify someone. Don't export anything that identifies anyone. In-product people insights follow ADM-14 (D34): counts and durations only, shown only to the roles it names.
- A setting that changes which provider receives people's data, where it is processed or stored, or turns on live processing updates the processing register, the transfer register and the notice (PDPA-01, PDPA-02, PDPA-10), and everyone acknowledges the new version (PDPA-03). Switching models within the same provider and region changes neither.

## AI and LLM features
- Prompt text people edit is data, kept out of code. Built-in feature prompts live in plain files, built into the app, that tests validate on every PR and a README explains how to edit. Agent playbooks (AGT-03) are edited in Agent Studio (STU-01) and stay drafts until published (STU-04). The server validates each playbook when it's saved (this repo's rule), and evaluation sets run before every publish (STU-03). Problems are explained in plain words.
- These stay in code, never in anything people edit, so no edit can weaken them:
  - safety rules (Rule 8: content is data, never instructions)
  - the access filter (Rules 1–8)
  - the reply format
  - length limits
  - call and session limits, and how spend caps are enforced: reaching a cap alerts admins and may pause only optional AI, never session or voice-message transcription or meeting notes (ADM-05, D10)
  - the allowed range of every setting (the cap amounts themselves are ADM-05 admin settings within that range)
- Validate model output strictly (zod). Put decision policy in plain, testable code, and use the model only for judgement.
- Any request containing personal data uses only models served in-region in ap-southeast-1 (B.6); the model layer rejects global cross-region model IDs. Among those, choose models through configuration (env vars, and ADM-05's provider settings), so switching needs no code change. Default to the cheaper model, and compare on real data before switching, using data with the DPO's basis such as the consented test set (§9.5).
- Cache the system prompt. Log every paid API call to a cost table (no content); per-person cost figures are for cost control only and visible only to Owners and Admins (§7.5). Show monthly totals to admins.
- Store a fingerprint of the prompt, model and pipeline version with each AI result (B.5, PDPA-08).
- Put swappable providers behind one interface: the model layer (D4), `transcribe()`, `SmsProvider`.
- If an AI feature fails, the core flow carries on (§9.3): chat, rooms, docs, sheets, slides and recording continue, and transcription and notes queue.

## Testing and CI
- Add tests for new business logic. Test the riskiest code first: `packages/access`, sign-in and sessions.
- Use Node 24 (`.nvmrc`). Cloud sessions may start on Node 22, so check `node --version` first. Before opening a PR, run what the CI `check` job runs. Today that is `cd demo && npm run typecheck && npm test && npm run build`. Once the workspace lands, it is `npm run check` (typecheck, lint, test) at the root.
- The CI `check` job runs `npm ci` → typecheck → lint → test → build. Until the workspace lands it runs in `demo/` and has no lint step (Biome arrives with the workspace).
- The CI `migrations` job, on a fresh Postgres 17 with pgvector:
  - builds a scratch database as `hearth_owner` from every migration, in one transaction (`scripts/check-migrations.sh`)
  - fails on a bad or duplicate file name, an unexpected folder, a psql meta-command, a migration that ends its own transaction, or a failing migration
  - fails if a table has RLS off, a view lacks `security_invoker`, a materialized view or foreign table is granted to anyone, a function is executable by PUBLIC, a `SECURITY DEFINER` function lacks `search_path = ''`, anyone but the owner holds TRUNCATE, TRIGGER or REFERENCES, an object isn't owned by `hearth_owner`, or `hearth_app` (once it exists) could bypass RLS
  - runs the DB tests (`scripts/test-db.sh`); a test that ends its own transaction fails
  - applies each risky migration on top of production-shaped data: `UP_TO=NNNN scripts/check-migrations.sh` builds up to the migration before it, then `scripts/check-<name>-upgrade.sh` loads the data and applies it (add both in the same PR as the migration)
- The job ids `check` and `migrations` are the required checks in `protect-main.json`. Never rename them, give them a `name:`, add a matrix, or move them to another workflow; put new work in new jobs that `check` or `migrations` lists in `needs:`.
- Extend this file and `ci.yml`; never replace them (e.g. when the build plan's first step lands).
- Write guard tests for architectural rules (import allow-lists, editable-file validity).

## Code and docs
- The libraries here are newer than your training data (React 19.3, Vite 8, Tailwind 4.3, TypeScript 5.9). Before using an API you aren't sure of, check the installed version: its type definitions (`node_modules/<pkg>/**/*.d.ts`), any docs or changelog it ships (most ship only a README), and that version's docs on the project's own site. Heed deprecation notices.
- Explain code in `//` comments, not `/** */` docstrings (CodeRabbit's docstring check is off for this reason).
- Use TypeScript strict mode, with the `@/*` → `src/*` alias inside each app and workspace packages imported by name. `apps/web` never imports from `apps/server`; shared code goes in `packages/`. Validate every input at the server boundary with zod.
- When docs and code disagree, the code is what happens. Fix the doc in the same PR.
