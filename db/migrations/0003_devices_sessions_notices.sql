-- C0.3: devices, sessions and notice acknowledgments (ACC-04, ACC-12, PDPA-03; T5).
--
-- C0.5 builds sign-in on these: it adds the lookups that run before the org is known (token
-- hash to session, phone number to person) as SECURITY DEFINER functions, and whatever columns
-- passkeys and new-device step-up need.

-- The browsers and phones a person has signed in on (ACC-04). Signing a device out ends its
-- sessions; the row stays so the device list and the audit log can name it.
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  -- How the device list names it, e.g. 'iPhone · Safari'.
  label text not null check (label = btrim(label) and length(label) between 1 and 100),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  signed_out_at timestamptz,
  signed_out_by uuid,
  unique (org_id, id),
  -- For sessions and acknowledgments to name the person's own device.
  unique (org_id, user_id, id),
  check ((signed_out_at is null) = (signed_out_by is null)),
  foreign key (org_id, user_id) references public.users (org_id, id),
  foreign key (org_id, signed_out_by) references public.principals (org_id, id)
);
create trigger devices_keep_history before update of signed_out_at, signed_out_by on public.devices
  for each row execute function public.keep_history('signed_out_at', 'signed_out_by');

-- Server-side sessions (T5): the browser holds an opaque token, and only its SHA-256 is stored,
-- so a database read can't sign anyone in. Revoking a session ends it everywhere within 60
-- seconds (ACC-04, ACC-05). Expired and revoked sessions are cleared by the retention engine
-- (C0.10), not by the server.
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  user_id uuid not null,
  device_id uuid not null,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by uuid,
  -- Why it ended, as a code such as sign_out or deactivated (C0.5 names them).
  revoke_reason text check (revoke_reason ~ '^[a-z][a-z_]{0,62}$'),
  unique (org_id, id),
  check (expires_at > created_at),
  check ((revoked_at is null) = (revoked_by is null) and (revoked_at is null) = (revoke_reason is null)),
  -- A session is on the signed-in person's own device.
  foreign key (org_id, user_id, device_id) references public.devices (org_id, user_id, id),
  foreign key (org_id, revoked_by) references public.principals (org_id, id)
);
create index sessions_user_current on public.sessions (org_id, user_id) where revoked_at is null;
create index sessions_device on public.sessions (org_id, device_id);
-- A revoked session stays revoked: signing in again makes a new one.
create trigger sessions_keep_history before update of revoked_at, revoked_by, revoke_reason on public.sessions
  for each row execute function public.keep_history('revoked_at', 'revoked_by', 'revoke_reason');

-- Versions of the privacy and recording notice (PDPA-02), numbered from 0 as the build plan
-- numbers them (v0 in C0, v1 at C1.13). A published version never changes: a change of purposes
-- publishes a new one, numbered above every earlier one, which everyone acknowledges again
-- (PDPA-03), so the current notice is the highest version. C0.9 generates the text from the
-- processing register.
create table public.notice_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  version integer not null check (version >= 0),
  body text not null check (length(body) > 0),
  published_at timestamptz not null default now(),
  published_by uuid not null,
  unique (org_id, id),
  unique (org_id, version),
  foreign key (org_id, published_by) references public.principals (org_id, id)
);

-- A new version numbers above the org's latest. Two published at once both pass this; the unique
-- (org_id, version) then refuses the second if they share a number.
create function public.notice_versions_check() returns trigger
language plpgsql set search_path = '' as $$
declare
  latest integer;
begin
  select max(v.version) into latest from public.notice_versions v where v.org_id = new.org_id;
  if latest is not null and new.version <= latest then
    raise exception 'A new notice version must be numbered above the latest, which is %.', latest
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
revoke execute on function public.notice_versions_check() from public;
create trigger notice_versions_check before insert on public.notice_versions
  for each row execute function public.notice_versions_check();

-- Who acknowledged which notice version, when and how (ACC-12, PDPA-03): in the app (first run,
-- or again after a new version), or recorded by the DPO for someone who acknowledged another way.
-- A record, so it is only ever added to; the records are exportable.
create table public.notice_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id),
  person_id uuid not null,
  notice_version_id uuid not null,
  acknowledged_at timestamptz not null default now(),
  method text not null check (method in ('in_app', 'recorded_by_dpo')),
  -- The person's own device it was acknowledged on, in the app. The record outlives the device:
  -- when the retention engine deletes the device (PDPA-09), this becomes empty.
  device_id uuid,
  -- The DPO who recorded it, for one made another way.
  recorded_by uuid,
  unique (org_id, id),
  unique (org_id, person_id, notice_version_id),
  constraint notice_acknowledgments_recorder check ((method = 'recorded_by_dpo') = (recorded_by is not null)),
  constraint notice_acknowledgments_device_in_app check (method = 'in_app' or device_id is null),
  constraint notice_acknowledgments_not_self_recorded check (recorded_by <> person_id),
  foreign key (org_id, person_id) references public.people (org_id, id),
  foreign key (org_id, notice_version_id) references public.notice_versions (org_id, id),
  foreign key (org_id, person_id, device_id) references public.devices (org_id, user_id, id) on delete set null (device_id),
  foreign key (org_id, recorded_by) references public.principals (org_id, id)
);

do $$
declare
  t text;
begin
  foreach t in array array['devices', 'sessions', 'notice_versions', 'notice_acknowledgments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy org_isolation on public.%I
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  end loop;
end
$$;

grant select, insert on public.devices to hearth_app;
grant update (label, last_seen_at, signed_out_at, signed_out_by) on public.devices to hearth_app;
grant select, insert on public.sessions to hearth_app;
grant update (last_seen_at, revoked_at, revoked_by, revoke_reason) on public.sessions to hearth_app;
grant select, insert on public.notice_versions to hearth_app;
-- The time an acknowledgment is recorded is when it's written, never a time the server chose.
grant select on public.notice_acknowledgments to hearth_app;
grant insert (org_id, person_id, notice_version_id, method, device_id, recorded_by) on public.notice_acknowledgments to hearth_app;
