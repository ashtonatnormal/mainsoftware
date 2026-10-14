-- C0.5: sign-in, devices and revocation (ACC-01, ACC-02, ACC-04, ACC-05, ACC-06; T5, T6, T14).
--
-- Adds to the accounts C0.3 made what sign-in needs: the account PIN and its failure count on
-- users, passkeys, when a session last re-authenticated, the two lookups that run before the org
-- is known (a session's token hash, a phone number), and the triggers that end a leaver's
-- sessions and devices and refuse new ones. The policy numbers (idle limit, PIN lock, re-auth
-- window) live in the server (apps/server/src/auth/policy.ts, TECH-SPEC T14); the only ones here
-- are a session's 90-day cap and the PIN hash's cost, which no code path may exceed. The times
-- that decide access (a session's start, last use and re-authentication, a PIN's last failure)
-- are the database's to write, never the server's.

-- The account PIN (ACC-02, PRD-07): an argon2id hash as a PHC string, made with the server's
-- pepper, whose key id is stored beside it so hashes made under another pepper can be told apart.
-- Failures are raw values, and the lock is computed from them and the database's clock (PRD-53:
-- 5 failures lock it for 15 minutes, 10 until an admin resets it), so changing those numbers
-- applies to history (CLAUDE.md, Database). When the person last set their PIN, and the last admin
-- reset and who made it (ACC-06), stay on the row for C0.16's approval screen (T13 item 5).
-- passkey_user_handle is the WebAuthn user handle: random, never the phone number or person id.
-- The hash's cost parameters are exactly the ones the server issues (apps/server/src/auth/policy.ts),
-- so a changed row can't make a check allocate more. Raising the cost is a new migration.
alter table public.users
  add column pin_hash text constraint users_pin_hash check (
    pin_hash ~ '^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$'),
  add column pin_key_id text constraint users_pin_key_id check (pin_key_id ~ '^[0-9a-f]{16}$'),
  add column pin_set_at timestamptz,
  add column pin_reset_at timestamptz,
  add column pin_reset_by uuid,
  add column pin_failures integer not null default 0 constraint users_pin_failures check (pin_failures >= 0),
  add column pin_last_failed_at timestamptz,
  add column passkey_user_handle uuid not null default gen_random_uuid(),
  add constraint users_pin_complete check (
    (pin_hash is null) = (pin_key_id is null) and (pin_hash is null) = (pin_set_at is null)),
  add constraint users_pin_reset_by check ((pin_reset_at is null) = (pin_reset_by is null)),
  add constraint users_pin_failed_at check ((pin_failures = 0) = (pin_last_failed_at is null)),
  add constraint users_passkey_user_handle unique (passkey_user_handle),
  add constraint users_pin_reset_by_fkey foreign key (org_id, pin_reset_by) references public.principals (org_id, id);

-- The failure count goes up one at a time, or back to zero, and the database stamps when the last
-- failure happened: hearth_app has no grant on pin_last_failed_at, so no write can choose that
-- time to lift or stretch a lock. When the count may go back to zero (a correct PIN, a new PIN or
-- an admin reset) is the server's decision: the database can't know whether a PIN was right. The
-- message can be shown as it is.
create function public.users_check_pin_failures() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.pin_failures = 0 then
    new.pin_last_failed_at := null;
  elsif new.pin_failures = old.pin_failures + 1 then
    new.pin_last_failed_at := pg_catalog.now();
  else
    raise exception 'A PIN''s failure count only goes up by one at a time, or back to zero.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.users_check_pin_failures() from public;
create trigger users_check_pin_failures before update of pin_failures on public.users
  for each row when (new.pin_failures is distinct from old.pin_failures)
  execute function public.users_check_pin_failures();

-- A new users row names only the person and org (the first sign-in makes it); the PIN columns
-- are updated, each with its own reason.
revoke insert on public.users from hearth_app;
grant insert (id, org_id) on public.users to hearth_app;
grant update (pin_hash, pin_key_id, pin_set_at, pin_reset_at, pin_reset_by, pin_failures)
  on public.users to hearth_app;

-- Sessions (T5). Re-authenticating with the PIN or a passkey (never SMS) stamps the session, and
-- admin actions need a stamp from the last 5 minutes (§9.4; the window is the server's, T14). A
-- sign-in counts as one, so a new session starts stamped. A session lasts at most 90 days (2160
-- hours, so no time zone's daylight saving can stretch it), and the server ends it sooner after
-- 30 days unused. Why a session ended is one of these codes; C0.16 adds phone_changed with the
-- phone change.
--
-- Sessions made before 0006 can't fail it (none exist today: nothing wrote a session before C0.5,
-- the seed has none, and no production database exists before C0.11;
-- scripts/check-sign-in-upgrade.sh applies it to rows 0005 allows). The table is locked first, so
-- no session is written in between.
-- - Someone who left has their open sessions ended and their devices signed out, as of when they
--   left, as people_end_sessions below does from now on.
-- - A revoked session keeps its times and reason, since how it ended is history (keep_history
--   refuses a change of reason).
-- - One not revoked, expired or not, must still take an update (a sign-out or PIN reset revokes it
--   with one), and Postgres checks every rule on each row an update writes. So one meant to last
--   more than 90 days now ends 90 days after it started, at once if that has passed. One with no
--   finite start can't be capped.
-- The two rules an older session may break are added NOT VALID, which still holds every row
-- written from now on, and validated just below unless such a session is left, as none is on any
-- database today; pg_constraint.convalidated shows which are. A migration that replaces one (C0.16
-- adds phone_changed) adds it NOT VALID and validates it the same way.
lock table public.sessions in access exclusive mode;
update public.sessions s
set revoked_at = p.deactivated_at, revoked_by = p.deactivated_by, revoke_reason = 'deactivated'
from public.people p
where p.org_id = s.org_id and p.id = s.user_id and p.deactivated_at is not null and s.revoked_at is null;
update public.devices d
set signed_out_at = p.deactivated_at, signed_out_by = p.deactivated_by
from public.people p
where p.org_id = d.org_id and p.id = d.user_id and p.deactivated_at is not null and d.signed_out_at is null;
update public.sessions set expires_at = created_at + interval '2160 hours'
  where revoked_at is null and isfinite(created_at) and expires_at > created_at + interval '2160 hours';
alter table public.sessions
  add column reauthenticated_at timestamptz,
  add constraint sessions_reauthenticated_after_start check (reauthenticated_at >= created_at),
  add constraint sessions_at_most_90_days check (expires_at - created_at <= interval '2160 hours') not valid,
  drop constraint sessions_revoke_reason_check,
  add constraint sessions_revoke_reason
    check (revoke_reason in ('sign_out', 'device_sign_out', 'deactivated', 'pin_reset')) not valid;
do $$
begin
  if not exists (select 1 from public.sessions where expires_at > created_at + interval '2160 hours') then
    alter table public.sessions validate constraint sessions_at_most_90_days;
  end if;
  if not exists (select 1 from public.sessions
                 where revoke_reason not in ('sign_out', 'device_sign_out', 'deactivated', 'pin_reset')) then
    alter table public.sessions validate constraint sessions_revoke_reason;
  end if;
end
$$;
-- Set after the column exists, so sessions made before 0006 stay unstamped: none counts as a
-- recent re-authentication.
alter table public.sessions alter column reauthenticated_at set default now();

-- The times that decide whether a session is live and fresh are the database's. A new session
-- names none of them (the INSERT grant below leaves them out, so the defaults apply), and a write
-- that changes last_seen_at or reauthenticated_at stores now() whatever it asked for. So no write
-- can backdate a start to stretch the 90-day cap, keep a session from going idle, or keep a
-- re-authentication fresh for longer.
create function public.sessions_stamp_times() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.last_seen_at is distinct from old.last_seen_at then
    new.last_seen_at := pg_catalog.now();
  end if;
  if new.reauthenticated_at is distinct from old.reauthenticated_at and new.reauthenticated_at is not null then
    new.reauthenticated_at := pg_catalog.now();
  end if;
  return new;
end
$$;
revoke execute on function public.sessions_stamp_times() from public;
create trigger sessions_stamp_times before update of last_seen_at, reauthenticated_at on public.sessions
  for each row execute function public.sessions_stamp_times();

revoke insert on public.sessions from hearth_app;
grant insert (id, org_id, user_id, device_id, token_hash, expires_at) on public.sessions to hearth_app;
grant update (reauthenticated_at) on public.sessions to hearth_app;

-- Nobody who has left gets a new device or passkey (ACC-05). The person's row is read FOR SHARE
-- (see people_check_department, 0002): a deactivation running at the same time either finishes
-- first and this refuses, or waits for this insert and then ends the device it added
-- (people_end_sessions below). The message is the trigger's argument and can be shown as it is.
create function public.check_user_active() returns trigger
language plpgsql set search_path = '' as $$
declare
  left_at timestamptz;
begin
  select p.deactivated_at into left_at from public.people p
  where p.org_id = new.org_id and p.id = new.user_id for share;
  if left_at is not null then
    raise exception '%', tg_argv[0] using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.check_user_active() from public;
create trigger devices_check_user before insert on public.devices
  for each row execute function public.check_user_active('That person has left the organisation, so no device can be added for them.');

-- No session starts for someone who has left, or on a device that's been signed out. This
-- replaces 0003's sessions_check_device, which read only the device: the person is read first,
-- then the device, both FOR SHARE. Deactivation (below) takes the person's row, then their
-- devices, then their sessions, so taking them in the same order means neither waits on the other.
drop trigger sessions_check_device on public.sessions;
drop function public.sessions_check_device();
create function public.sessions_check_start() returns trigger
language plpgsql set search_path = '' as $$
declare
  ended timestamptz;
begin
  select p.deactivated_at into ended from public.people p
  where p.org_id = new.org_id and p.id = new.user_id for share;
  if ended is not null then
    raise exception 'That person has left the organisation, so they can''t sign in.' using errcode = 'check_violation';
  end if;
  -- The row the foreign key names, so a device that isn't the person's own is left to it.
  select d.signed_out_at into ended from public.devices d
  where d.org_id = new.org_id and d.user_id = new.user_id and d.id = new.device_id for share;
  if ended is not null then
    raise exception 'That device has been signed out. Sign in again to add it as a new device.'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.sessions_check_start() from public;
create trigger sessions_check_start before insert on public.sessions
  for each row execute function public.sessions_check_start();

-- Deactivating someone (ACC-05) signs them out everywhere in the same transaction: their open
-- sessions end with the reason deactivated and the deactivation's when and who, then their devices
-- are signed out (devices_end_sessions then finds nothing open, so the reason stays). It is a
-- trigger so every writer does it: the api, C0.16's console and any CSV deactivation. Their
-- devices are locked first, in id order, so a device being signed out at the same time finishes
-- or waits rather than deadlocking with this. Passkeys stay, unusable while the person has left.
create function public.people_end_sessions() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform 1 from public.devices d
  where d.org_id = new.org_id and d.user_id = new.id and d.signed_out_at is null
  order by d.id for update;
  update public.sessions s
  set revoked_at = new.deactivated_at, revoked_by = new.deactivated_by, revoke_reason = 'deactivated'
  where s.org_id = new.org_id and s.user_id = new.id and s.revoked_at is null;
  update public.devices d
  set signed_out_at = new.deactivated_at, signed_out_by = new.deactivated_by
  where d.org_id = new.org_id and d.user_id = new.id and d.signed_out_at is null;
  return null;
end
$$;
revoke execute on function public.people_end_sessions() from public;
create trigger people_end_sessions after update of deactivated_at on public.people
  for each row when (old.deactivated_at is null and new.deactivated_at is not null)
  execute function public.people_end_sessions();

-- Passkeys (ACC-02): a quicker alternative to the PIN at the step after the SMS code and at
-- re-authentication, never a way to skip the code. One row per credential, kept when removed
-- (removed_at, removed_by) so the audit log can name it. A credential id is unique across orgs and
-- for good: authenticators make a new one for every registration. The public key and counter are
-- what verification needs; transports help the browser find the authenticator; backed_up says
-- whether it is a synced passkey, which outlives a lost phone. created_device_id names the device
-- it was added on, and empties when the retention engine deletes that device (PDPA-09).
create table public.passkeys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  credential_id bytea not null check (octet_length(credential_id) between 16 and 1023),
  public_key bytea not null check (octet_length(public_key) between 32 and 2048),
  counter bigint not null default 0 check (counter between 0 and 4294967295),
  transports text[] not null default '{}'
    check (transports <@ array['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']::text[]),
  backed_up boolean not null,
  created_at timestamptz not null default now(),
  created_device_id uuid,
  last_used_at timestamptz,
  removed_at timestamptz,
  removed_by uuid,
  unique (org_id, id),
  constraint passkeys_credential_id_unique unique (credential_id),
  check ((removed_at is null) = (removed_by is null)),
  foreign key (org_id, user_id) references public.users (org_id, id),
  foreign key (org_id, user_id, created_device_id) references public.devices (org_id, user_id, id)
    on delete set null (created_device_id),
  foreign key (org_id, removed_by) references public.principals (org_id, id)
);
create index passkeys_user_current on public.passkeys (org_id, user_id) where removed_at is null;
create trigger passkeys_keep_history before update of removed_at, removed_by on public.passkeys
  for each row execute function public.keep_history('removed_at', 'removed_by');
create trigger passkeys_check_user before insert on public.passkeys
  for each row execute function public.check_user_active('That person has left the organisation, so they can''t add a passkey.');
alter table public.passkeys enable row level security;
create policy org_isolation on public.passkeys
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant select on public.passkeys to hearth_app;
grant insert (org_id, user_id, credential_id, public_key, counter, transports, backed_up, created_device_id)
  on public.passkeys to hearth_app;
grant update (counter, last_used_at, removed_at, removed_by) on public.passkeys to hearth_app;

-- The sign-in lookups that run before the org is known (CLAUDE.md, Database). They run as the
-- owner, so they see every org's rows and filter for themselves; they ignore app.org_id and
-- app.user_id, take no acting user, return only ids and audit nothing (the sign-in they serve is
-- audited). Each row whose end would make it return nothing is read FOR SHARE, so a revocation,
-- sign-out, deactivation or number removal in progress makes the lookup wait and then see what
-- was committed. That needs a VOLATILE function in a read-write transaction, which
-- apps/server/src/db/pre-org.ts opens for each call; nothing else calls them. An argument out of
-- range returns nothing.

-- A browser's session, from the SHA-256 of its cookie's token (T5): open, not expired, used within
-- max_idle (the server's idle limit, at most 90 days), on a device that isn't signed out, of
-- someone still at the org. The rows are locked person, then device, then session, the order
-- deactivation takes them in (people_end_sessions), so a lookup and a deactivation never wait on
-- each other in a circle.
create function public.session_by_token(token_hash bytea, max_idle interval)
returns table (session_id uuid, org_id uuid, user_id uuid, device_id uuid)
language sql volatile security definer set search_path = '' as $$
  select s.id, s.org_id, s.user_id, s.device_id
  from public.people p
  join public.devices d on d.org_id = p.org_id and d.user_id = p.id
  join public.sessions s on s.org_id = d.org_id and s.user_id = d.user_id and s.device_id = d.id
  where s.token_hash = $1
    and pg_catalog.octet_length($1) = 32
    and $2 >= interval '1 minute' and $2 <= interval '2160 hours'
    and s.revoked_at is null
    and s.expires_at > pg_catalog.now()
    and s.last_seen_at > pg_catalog.now() - $2
    and d.signed_out_at is null
    and p.deactivated_at is null
  for share of p, d, s
$$;
revoke execute on function public.session_by_token(bytea, interval) from public;
grant execute on function public.session_by_token(bytea, interval) to hearth_app;

-- The roster entry a phone number belongs to (ACC-03): its current (not removed) number row, in
-- whichever org has it. Whether the person has left is the server's check, in the org's own
-- transaction, so a leaver's attempt can be audited against them (T14). v1 runs one org (D1), but
-- the schema lets two orgs hold the same number, so this can return two rows; the server then
-- treats the number as not on the roster.
create function public.person_by_phone(e164 text)
returns table (phone_number_id uuid, org_id uuid, person_id uuid)
language sql volatile security definer set search_path = '' as $$
  select n.id, n.org_id, n.person_id
  from public.phone_numbers n
  where n.e164 = $1 and n.removed_at is null
  for share of n
$$;
revoke execute on function public.person_by_phone(text) from public;
grant execute on function public.person_by_phone(text) to hearth_app;
