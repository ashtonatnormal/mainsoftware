-- BUILD-PLAN Part 1D seams, ACC-10: principals are human, agent, assistant or system, each with
-- its rules. A person's id is a human principal's id; an assistant serves one human; Hearth's
-- system principal has a key; hearth_app creates only human principals for now.
\ir fixtures/two_orgs.sql

-- As the owner (the bootstrap and later stages), every kind with its own rules.
select pg_temp.expect_error($$insert into public.principals (org_id, kind)
  values ('f1000000-0000-4000-8000-000000000000', 'robot')$$, '23514');
select pg_temp.expect_error($$insert into public.principals (org_id, kind)
  values ('f1000000-0000-4000-8000-000000000000', 'system')$$, '23514');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, system_key)
  values ('f1000000-0000-4000-8000-000000000000', 'human', 'hearth_two')$$, '23514');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, system_key)
  values ('f1000000-0000-4000-8000-000000000000', 'system', 'hearth')$$, '23505');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, system_key)
  values ('f1000000-0000-4000-8000-000000000000', 'system', 'Not A Key')$$, '23514');
select pg_temp.expect_error($$insert into public.principals (org_id, kind)
  values ('f1000000-0000-4000-8000-000000000000', 'assistant')$$, '23514');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, owner_id)
  values ('f1000000-0000-4000-8000-000000000000', 'agent', 'f1000000-0000-4000-8000-0000000000a1')$$, '23514');
-- An assistant serves a human in its own org: not an agent, not Hearth, not another org's person.
select pg_temp.expect_error($$insert into public.principals (org_id, kind, owner_id)
  values ('f1000000-0000-4000-8000-000000000000', 'assistant', 'f1000000-0000-4000-8000-0000000000ab')$$, '23503');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, owner_id)
  values ('f1000000-0000-4000-8000-000000000000', 'assistant', 'f1000000-0000-4000-8000-0000000000a0')$$, '23503');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, owner_id)
  values ('f1000000-0000-4000-8000-000000000000', 'assistant', 'f2000000-0000-4000-8000-0000000000a8')$$, '23503');
-- One assistant per person (PA-01).
select pg_temp.expect_error($$insert into public.principals (org_id, kind, owner_id)
  values ('f1000000-0000-4000-8000-000000000000', 'assistant', 'f1000000-0000-4000-8000-0000000000a8')$$, '23505');
insert into public.principals (org_id, kind, owner_id)
values ('f1000000-0000-4000-8000-000000000000', 'assistant', 'f1000000-0000-4000-8000-0000000000a7');

-- A person's id is a human principal's: not an agent's, an assistant's or Hearth's.
select pg_temp.expect_error($$insert into public.people (id, org_id, full_name, created_by)
  values ('f1000000-0000-4000-8000-0000000000ab', 'f1000000-0000-4000-8000-000000000000', 'Agent', 'f1000000-0000-4000-8000-0000000000a1')$$, '23503');
select pg_temp.expect_error($$insert into public.people (id, org_id, full_name, created_by)
  values ('f1000000-0000-4000-8000-0000000000ac', 'f1000000-0000-4000-8000-000000000000', 'Assistant', 'f1000000-0000-4000-8000-0000000000a1')$$, '23503');
select pg_temp.expect_error($$insert into public.people (id, org_id, full_name, created_by)
  values ('f1000000-0000-4000-8000-0000000000a0', 'f1000000-0000-4000-8000-000000000000', 'Hearth', 'f1000000-0000-4000-8000-0000000000a1')$$, '23503');
select pg_temp.expect_error($$insert into public.people (id, org_id, full_name, created_by)
  values (gen_random_uuid(), 'f1000000-0000-4000-8000-000000000000', 'No principal', 'f1000000-0000-4000-8000-0000000000a1')$$, '23503');

-- hearth_app adds people to the roster, so it creates human principals, and nothing else.
select pg_temp.act_as('1', 'a2');
insert into public.principals (org_id, kind) values ('f1000000-0000-4000-8000-000000000000', 'human');
select pg_temp.expect_error($$insert into public.principals (org_id, kind)
  values ('f1000000-0000-4000-8000-000000000000', 'agent')$$, '42501');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, system_key)
  values ('f1000000-0000-4000-8000-000000000000', 'system', 'impostor')$$, '42501');
select pg_temp.expect_error($$insert into public.principals (org_id, kind, owner_id)
  values ('f1000000-0000-4000-8000-000000000000', 'assistant', 'f1000000-0000-4000-8000-0000000000a6')$$, '42501');
select pg_temp.expect_error($$update public.principals set kind = 'system'$$, '42501');
