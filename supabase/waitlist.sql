-- ─────────────────────────────────────────────────────────────────────────────
-- Halal Bridge — pre-launch waitlist
--
-- Run this once in Supabase: SQL Editor → New query → paste → Run.
-- It is safe to run again; it only adds what is missing.
--
-- What it adds:
--   • waitlist        people who signed up on the coming-soon page
--   • site_settings   whether the site is live, the launch goal, the app link,
--                     and the wording of the launch email
--   • join_waitlist()          public: the sign-up form calls this
--   • site_status()            public: the page asks "are we live yet?"
--   • admin_waitlist()         admin only: the list on the admin page
--   • admin_site_settings()    admin only: read the settings
--   • admin_update_settings()  admin only: go live / change the link or email
--
-- Nobody outside the admins table can read the list. The public can only add
-- themselves to it, through join_waitlist(), which checks every field.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.waitlist (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null check (char_length(trim(name)) between 1 and 100),
  email              text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' and char_length(email) <= 254),
  gender             text not null check (gender in ('brother','sister')),
  age                int  not null check (age between 18 and 80),
  city               text check (city is null or char_length(city) <= 80),
  state              text not null check (state in ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT','Outside Australia')),
  phone              text check (phone is null or char_length(phone) <= 30),
  heard_from         text check (heard_from is null or char_length(heard_from) <= 80),
  consent            boolean not null default false check (consent),
  created_at         timestamptz not null default now(),
  welcome_emailed_at timestamptz,
  launch_emailed_at  timestamptz,
  launch_email_error text
);
-- For anyone who ran an earlier copy of this file.
alter table public.waitlist add column if not exists launch_email_error text;

-- One sign-up per email address, whatever the capitals.
create unique index if not exists waitlist_email_unique on public.waitlist (lower(email));
create index if not exists waitlist_created_idx on public.waitlist (created_at);
create index if not exists waitlist_launch_pending_idx on public.waitlist (created_at) where launch_emailed_at is null;

alter table public.waitlist enable row level security;
-- No policies on purpose: the browser can't read or write this table
-- directly. Everything goes through the functions below.
revoke all on public.waitlist from anon, authenticated;

create table if not exists public.site_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.site_settings enable row level security;
revoke all on public.site_settings from anon, authenticated;

insert into public.site_settings (key, value) values
  ('launched',      'false'::jsonb),
  ('launch_goal',   '1000'::jsonb),
  ('app_url',       '""'::jsonb),
  ('launch_email_subject', to_jsonb('Your Halal Bridge beta access is open'::text)),
  ('launch_email_body', to_jsonb(
'Assalamu alaykum {{firstname}},

Alhamdulillah, the Halal Bridge closed beta is now open, and your place is ready.

Thank you for registering early and for your patience. You can now create your account, complete your profile and verification, and we will begin looking for your matches inshallah. As a beta member, your feedback will help shape Halal Bridge, so please tell us what works and what doesn''t.

Every introduction is arranged by our team, nothing is shared until both sides agree, and every conversation is supervised, with your wali welcome to join.

Create your account here:
{{link}}

May Allah put barakah in your search.

JazakAllah khair,
The Halal Bridge Team'::text))
on conflict (key) do nothing;

-- ── helpers ──────────────────────────────────────────────────────────────────
create or replace function public.hb_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where id = auth.uid());
$$;

-- ── public: sign up ──────────────────────────────────────────────────────────
-- Returns 'joined' for a new sign-up and 'already' if that email is on the
-- list. Never returns anyone's details.
create or replace function public.join_waitlist(
  p_name text, p_email text, p_gender text, p_age int,
  p_state text, p_city text default null, p_phone text default null,
  p_heard_from text default null, p_consent boolean default false
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email));
begin
  if not coalesce(p_consent, false) then
    raise exception 'Please agree to be contacted about Halal Bridge.';
  end if;
  if exists (select 1 from public.waitlist where lower(email) = v_email) then
    return 'already';
  end if;
  insert into public.waitlist (name, email, gender, age, state, city, phone, heard_from, consent)
  values (trim(p_name), v_email, p_gender, p_age, p_state,
          nullif(trim(coalesce(p_city,'')), ''),
          nullif(trim(coalesce(p_phone,'')), ''),
          nullif(trim(coalesce(p_heard_from,'')), ''),
          true);
  return 'joined';
exception
  when unique_violation then return 'already';
  when check_violation then raise exception 'Please check your details and try again.';
end;
$$;

-- ── public: are we live? ─────────────────────────────────────────────────────
-- Deliberately does not expose the sign-up count.
create or replace function public.site_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'launched', coalesce((select value from public.site_settings where key = 'launched'), 'false'::jsonb),
    'app_url',  coalesce((select value from public.site_settings where key = 'app_url'),  '""'::jsonb)
  );
$$;

-- ── admin: the list ──────────────────────────────────────────────────────────
create or replace function public.admin_waitlist()
returns setof public.waitlist
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.hb_is_admin() then raise exception 'Admins only'; end if;
  return query select * from public.waitlist order by created_at desc;
end;
$$;

create or replace function public.admin_site_settings()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not public.hb_is_admin() then raise exception 'Admins only'; end if;
  return (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.site_settings);
end;
$$;

-- Only the keys below can be changed, so this can't be used to write
-- anything else.
create or replace function public.admin_update_settings(p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text;
begin
  if not public.hb_is_admin() then raise exception 'Admins only'; end if;
  for k in select jsonb_object_keys(p_settings) loop
    if k not in ('launched','launch_goal','app_url','launch_email_subject','launch_email_body') then
      raise exception 'Unknown setting: %', k;
    end if;
    insert into public.site_settings (key, value, updated_at)
    values (k, p_settings -> k, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end loop;
  return public.admin_site_settings();
end;
$$;

revoke all on function public.join_waitlist(text,text,text,int,text,text,text,text,boolean) from public;
revoke all on function public.site_status() from public;
revoke all on function public.admin_waitlist() from public;
revoke all on function public.admin_site_settings() from public;
revoke all on function public.admin_update_settings(jsonb) from public;
revoke all on function public.hb_is_admin() from public;
-- Supabase also grants new functions to anon directly; the admin ones are
-- for signed-in admins only.
revoke all on function public.admin_waitlist() from anon;
revoke all on function public.admin_site_settings() from anon;
revoke all on function public.admin_update_settings(jsonb) from anon;
revoke all on function public.hb_is_admin() from anon;

grant execute on function public.join_waitlist(text,text,text,int,text,text,text,text,boolean) to anon, authenticated;
grant execute on function public.site_status() to anon, authenticated;
grant execute on function public.admin_waitlist() to authenticated;
grant execute on function public.admin_site_settings() to authenticated;
grant execute on function public.admin_update_settings(jsonb) to authenticated;
grant execute on function public.hb_is_admin() to authenticated;
