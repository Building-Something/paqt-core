-- ============================================================
-- Paqt — Supabase schema (database side)
--
-- Paste this into the Supabase Dashboard SQL editor and run it
-- (idempotent — safe to re-run after app upgrades).
-- It creates:
--   1. the `documents` table (per-user review/draft history)
--   2. Row Level Security so users only see their own rows
--
-- The storage bucket + its policies live in `storage.sql` (a
-- separate file) because that section touches Supabase's managed
-- `storage` schema and can need elevated privileges on some
-- projects. Run this file first — the app works (rows, history,
-- chat) even before storage.sql succeeds; storage only adds PDFs
-- and thumbnails.
--
-- Rows hold metadata + finished analysis/draft JSON plus the
-- extracted per-page text (`page_texts`, capped by the app) so the
-- assistant works from history even without the PDF.
-- ============================================================

create table if not exists public.documents (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('analysis', 'draft')),
  name text not null,
  page_count integer,
  section_count integer,
  draft_brief text,
  draft_markdown text,
  draft_doc text,
  draft_signatures jsonb,
  analysis jsonb,
  page_texts jsonb,
  preview_path text,
  pdf_path text,
  created_at bigint not null,
  updated_at bigint not null
);

-- Upgrade path for databases created before PDF/text retention existed.
alter table if exists public.documents add column if not exists pdf_path text;
alter table if exists public.documents add column if not exists page_texts jsonb;

create index if not exists documents_user_updated_idx
  on public.documents (user_id, updated_at desc);

-- Ensure the Data API role can access the table.
grant select, insert, update, delete on public.documents to authenticated;

-- ============================================================
-- Session liveness helpers (sign-out-from-everywhere).
--
-- MUST be defined BEFORE the RLS policies below, because the
-- policies call `public.is_active_user()`.
--
-- Supabase access tokens are STATELESS JWTs: after an account is
-- deleted or its sessions are revoked (password change, global
-- sign-out) an already-issued access token keeps passing RLS until
-- its `exp` claim, so other devices stay "logged in" for up to a
-- token lifetime. The app repairs this in two ways:
--
--   1. `is_active_user()` - a database-level guard added to every
--      documents policy. Requests carrying a token whose subject no
--      longer exists in auth.users are rejected server-side, closing
--      the window for deleted accounts.
--
--   2. `auth_session_alive()` - an RPC the client polls (every ~30s
--      and on tab focus). It compares the token's session_id claim
--      against auth.sessions: if the user row or the session row is
--      gone (delete account / password change / global sign-out from
--      another device), it returns false and the app signs the local
--      session out immediately.
-- ============================================================
create or replace function public.is_active_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from auth.users where id = auth.uid());
$$;

revoke all on function public.is_active_user() from public, anon, authenticated;
grant execute on function public.is_active_user() to authenticated;

create or replace function public.auth_session_alive()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb;
  raw_sid text;
  sid uuid;
begin
  begin
    claims := coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  exception when others then
    claims := '{}'::jsonb;
  end;

  raw_sid := coalesce(claims->>'session_id', claims->>'sid', '');
  if raw_sid <> '' then
    begin
      sid := raw_sid::uuid;
    exception when others then
      sid := null;
    end;
  end if;

  if not exists (select 1 from auth.users where id = auth.uid()) then
    return false;
  end if;

  if sid is not null then
    return exists (
      select 1 from auth.sessions s
      where s.user_id = auth.uid() and s.id = sid
    );
  end if;

  return true;
end;
$$;

revoke all on function public.auth_session_alive() from public, anon, authenticated;
grant execute on function public.auth_session_alive() to authenticated;

-- ---- Row Level Security ----
-- Rules are NOT configurable; they live here so every client
-- request is scoped to the caller's own user id.
alter table public.documents enable row level security;

drop policy if exists "documents_select_own" on public.documents;
create policy "documents_select_own"
  on public.documents for select
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user());

drop policy if exists "documents_insert_own" on public.documents;
create policy "documents_insert_own"
  on public.documents for insert
  to authenticated
  with check ((select auth.uid()) = user_id and public.is_active_user());

drop policy if exists "documents_update_own" on public.documents;
create policy "documents_update_own"
  on public.documents for update
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user())
  with check ((select auth.uid()) = user_id and public.is_active_user());

drop policy if exists "documents_delete_own" on public.documents;
create policy "documents_delete_own"
  on public.documents for delete
  to authenticated
  using ((select auth.uid()) = user_id and public.is_active_user());

-- ============================================================
-- Permanent account deletion (browser-safe).
--
-- A browser running with the anon/public key is NOT allowed to
-- delete its own row from auth.users (that needs the service-role
-- key, which must never be shipped to the client). This security
-- definer function runs with elevated privileges so a signed-in
-- user CAN remove their own login identity, making re-registering
-- with the same email a truly fresh start.
--
-- Run this once in the Supabase dashboard (SQL editor), always on
-- the full schema (idempotent). The app calls it from
-- deleteAccount via supabase.rpc('delete_user').
-- ============================================================
create or replace function public.delete_user()
returns void
language sql
security definer
set search_path = public
as $$
  delete from auth.users where id = auth.uid();
$$;

revoke all on function public.delete_user() from public, anon, authenticated;
grant execute on function public.delete_user() to authenticated;