# Hearth — Engineering Contract

Hearth is an internal work suite (chat, drop-in voice rooms, meetings, calendar, tasks, and a Drive holding docs and wiki, sheets, slides and files) where AI agents are teammates, built over a permission-aware Org Brain. Its first customer is our own organisation, moving its work communication off WhatsApp. It is not an email client, a guest or cross-org tool, an integrations hub, a full Excel or PowerPoint replacement, or an assistant that acts on anyone's behalf. Spec: `docs/PRD.md`, where a decision (`Dn`) beats a requirement that disagrees with it. Keep each module at the depth its P0 rows set (D18).

- Build → simplify → automate. Start with manual input.
- Scope guard: do NOT build email, external guests or shared channels, third-party integrations, native apps, agent computers, macros, pivot tables or other full Office parity, an assistant that sends or edits for a user (D16), WhatsApp import (D17), billing or self-serve sign-up, or AI scoring of what people say or voiceprints (D34). The full list is PRD §3.2.
- Stack (D37; the build plan's T1–T11): TypeScript strict end to end in an npm-workspaces monorepo (`apps/web`, `apps/server`, `packages/shared`, `packages/access`, `infra/`; `demo/` stays as the reference UI). Node 24 LTS. Web: Vite + React 19 + Tailwind v4 as an installable PWA. Server: Fastify + `ws`. PostgreSQL 17 (RDS; pgvector later), Valkey, S3, LiveKit Cloud. AWS CDK in ap-southeast-1. Vitest, Playwright, Biome. Not Next.js, Supabase or Vercel: D37 keeps everything on AWS Singapore, and Vercel can't host the WebSocket, Yjs and recorder services.

## Product rules that never bend
- Never leak (Principle 1). Every access check goes through `packages/access`; no screen or endpoint checks access its own way. Every AI feature retrieves through the one permission-enforcing retrieval layer (B.4) and never queries the index directly.
- Every record belongs to an org (ACC-11): every table has `org_id`, and no query runs without it.
- Recording is never hidden (Principle 6): every room and call UI shows the recording indicator.
- The personal assistant suggests and drafts; it never sends, edits, creates or deletes for a user (D16).
- Content is data, not instructions (Rule 8).
- Privileged access (Rule 9) happens only in the DPO and Compliance consoles, against a logged case with a stated reason. It is never available to any AI feature.

## Git
- Never commit directly to `main`. Create a feature branch.
- Keep PRs small and focused. Use Conventional Commit titles: `feat(scope): …`, `fix(scope): …`, `chore: …`, `docs: …`, `ci: …`. Name the migration in the title when a PR adds one, e.g. `feat(db): … (0006)`. Cite requirement and decision IDs (CHAT-04, D39) in commit messages and test names. Squash-merge.
- Claude may merge a PR without asking once all three hold on its latest commit: CodeRabbit has approved it; Qodo has reviewed it and left no open "Action required" finding; the CI checks (`check`, `migrations`) passed. Hold the merge while the PR description lists unticked "Before merging" steps.
- Never bypass CI or branch protection. Never merge past red CI. Don't post `@coderabbitai approve` unless the user asks: the approval must come from CodeRabbit's own review.
- `main` protection lives in `.github/rulesets/protect-main.json`, applied with `scripts/protect-main.sh`. Change it only by PR; never loosen it in the GitHub UI.
  - Changes land only through a PR with 1 approval (CodeRabbit's counts). A new push dismisses earlier approvals, and every review thread must be resolved.
  - The required checks (`check`, `migrations`) must pass on a branch that is up to date with `main`.
  - No force-pushes, no deleting `main`, no bypass actors (admins included).
- After every Claude response, a Stop hook (`.claude/hooks/auto-push.sh`) commits and pushes the current branch as a checkpoint (`chore(auto): checkpoint after Claude Code run`). Opt out with `HEARTH_AUTOPUSH=0`. The hook never runs on `main`/`master`, never commits secrets, skips while a merge or rebase is in progress, and never force-pushes.

## Database (PostgreSQL)
- Never modify the production schema by hand. Every schema change is a migration in `db/migrations/`, named `<NNNN>_<name>.sql`, that runs forwards from an empty database. No direct production changes.
- RLS is on for every table, and its policies key on the request's org. CI fails if any table has it off.
- The app's runtime database role owns no tables and doesn't have `BYPASSRLS`, so RLS always applies to it (a table's owner skips RLS). Migrations run as the owner role. Roles belong to the whole server, so a migration that creates one skips it when it already exists.
- New tables, views and functions get no grants by default:
  - Grant what's needed to the app role in the same migration.
  - Run `revoke execute … from public` on every new function (Postgres grants it to everyone otherwise).
  - Create views `with (security_invoker = true)` so RLS still applies.
- Never let the browser reach a privileged credential (the owner or any `BYPASSRLS` role, AWS keys, provider keys). Server-only variables never get a `VITE_` prefix (Vite ships those to the browser). In AWS they live in Secrets Manager, never in code or plain config.
- One module holds the database connection that bypasses RLS (`apps/server/src/db/privileged.ts`; only the Rule 9 consoles and system jobs such as retention use it). A guard test next to it (`privileged-imports.test.ts`) keeps an allow-list of the files that may import it and fails on any other import, or on any other code reading its credential. Add the guard in the same PR as the module. Adding a file to that list is a reviewed change.
- The browser never talks to Postgres. Every read and write goes through the server, which takes the user from the server-side session (opaque, revocable tokens), never from the request.
- Admin powers are roles (ACC-10) held as rows, and policies allow each admin action only to holders of the matching role. Roles change only through the admin console's role assignment (ADM-02), which needs re-authentication (§9.4), never lets anyone change their own roles, and is audited (ADM-06). Until the PRD says who may grant Owner and Admin, only an Owner may. Nobody can promote themselves.
- An admin write that RLS can't express goes through one `SECURITY DEFINER` function with a pinned `search_path`. It checks the caller and everything RLS would check, and writes an audit event.
- Rows that carry history (people, teams, channels, sessions) are archived or soft-removed (`archived_at`, `removed_at`), not deleted. Record who did what and when in `*_by` / `*_at` columns. Content the PRD says to delete (CHAT-05, FILE-02's Trash after 30 days, Rule 7, PDPA-09 retention) is deleted for real, but only through the deletion and retention code, which logs it and stops for a legal hold (ADM-08).
- Store the context a record was made in (e.g. the team or channel it belonged to). Later moves must not rewrite history.
- Compute derived values (colours, statuses, due dates) from stored raw values plus a settings row, never from a stored derived column. Tuning the settings then re-applies to history.
- Enforce hierarchy (folders, teams, departments) and other invariants with DB triggers whose error messages the UI can show as is. Run tree changes under READ COMMITTED.
- Tables that hold sensitive judgements about people get no grants to the app role; only the privileged module reaches them.
- File storage (S3):
  - Use private buckets, with keys `<org_id>/<owner_id>/<file>`.
  - To upload, the server makes a presigned upload URL that can't overwrite (`If-None-Match: *`) for a key it builds from the session, and the browser uploads straight to it. Downloads use short-lived signed URLs issued after an access check.
  - Uploaded files are parsed only in an isolated worker with no network access, and macros never run (§9.4).
  - Sensitive deletes go through a checked DB function that logs which files to delete. The server removes only those files and stamps the log row, and a daily job retries unstamped rows. Retention deletes are S3 lifecycle rules defined in `infra/` (B.6), never set by hand.
- DB tests live in `db/tests/` (`scripts/test-db.sh`). They cover every role the table concerns: signed out, Member, Team Admin, Admin, Owner, plus the DPO and Compliance Officer where Rule 9 applies. Rules 1–9 also get named cases in `packages/access`'s test suite.

## Security and privacy
- Never commit secrets. `.env*` is git-ignored except `.env.example`, which documents every variable with a comment.
- Never disable auth checks or weaken RLS or access rules without explicit review.
- Never send a third-party API key to the browser, not even a short-lived one. The server opens the connection and passes back only what the browser needs. The one exception is the LiveKit participant token, which LiveKit requires: the server mints it per room and identity, after an access check.
- Git-ignore any local output that holds people's data (exports, transcript comparisons, test-set clips from §9.5).
- Ad-hoc analysis of production data looks at totals and shares, never at one person's rows. Don't export anything that identifies anyone. In-product people insights follow ADM-14 (D34): counts and durations only, shown only to the roles it names.
- A setting that changes where people's data goes (provider, model, region, live processing) also changes the processing register and the notice (PDPA-01, PDPA-02, PDPA-10), and everyone acknowledges it again (PDPA-03).

## AI and LLM features
- Prompt text people edit is data, kept out of code. Built-in feature prompts live in plain files, built into the app, that tests validate on every PR and a README explains how to edit. Agent instructions live in Agent Studio (AGT-02) and are validated on save. Problems are explained in plain words.
- These stay in code, never in anything people edit, so no edit can weaken them:
  - safety rules (Rule 8: content is data, never instructions)
  - the access filter (Rules 1–8)
  - the reply format
  - length limits
  - call and session limits, and spend caps (ADM-05)
  - the allowed range of every setting
- Validate model output strictly (zod). Put decision policy in plain, testable code, and use the model only for judgement.
- Choose models through configuration (env vars, and ADM-05's provider settings), so switching needs no code change. Default to the cheaper model, and compare on real data before switching, using data with the DPO's basis such as the consented test set (§9.5).
- Cache the system prompt. Log every paid API call to a cost table (no content); per-person cost figures are for cost control only and visible only to Owners and Admins (§7.5). Show monthly totals to admins.
- Store a fingerprint of the prompt, model and pipeline version with each AI result (B.5, PDPA-08).
- Put swappable providers behind one interface: the model layer (D4), `transcribe()`, `SmsProvider`.
- If an AI feature fails, the core flow carries on (§9.3): chat, rooms, docs, sheets, slides and recording continue, and transcription and notes queue.

## Testing and CI
- Add tests for new business logic. Test the riskiest code first: `packages/access`, sign-in and sessions.
- Before opening a PR, run what the CI `check` job runs. Today that is `cd demo && npm run typecheck && npm test && npm run build`. Once the workspace lands, it is `npm run check` (typecheck, lint, test) at the root.
- The CI `check` job runs `npm ci` → typecheck → lint → test → build. Until the workspace lands it runs in `demo/` and has no lint step (Biome arrives with the workspace, T11).
- The CI `migrations` job, on a fresh Postgres 17 with pgvector:
  - applies every migration in order to an empty database (`scripts/check-migrations.sh`)
  - fails on a bad or duplicate file name, a failing migration, or a table with RLS off
  - runs the DB tests (`scripts/test-db.sh`)
  - applies each risky migration on top of production-shaped data (add its upgrade step, `scripts/check-<name>-upgrade.sh`, in the same PR as the migration)
- Write guard tests for architectural rules (import allow-lists, editable-file validity).

## Code and docs
- The libraries here are newer than your training data (React 19.3, Vite 8, Tailwind 4.3, TypeScript 5.9). Read the installed package's docs or changelog in `node_modules/` before using an API you aren't sure of, and heed deprecation notices.
- Explain code in `//` comments, not `/** */` docstrings (CodeRabbit's docstring check is off for this reason).
- Use TypeScript strict mode, with the `@/*` → `src/*` alias inside each app and workspace packages imported by name. `apps/web` never imports from `apps/server`; shared code goes in `packages/`. Validate every input at the server boundary with zod.
- When docs and code disagree, the code is what happens. Fix the doc in the same PR.
