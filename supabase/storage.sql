-- ============================================================
-- Paqt — Supabase storage (bucket + owner-scoped policies)
--
-- Run this AFTER supabase/schema.sql, in the Dashboard SQL editor.
-- It creates the private `documents` bucket and scopes every
-- object under `{user_id}/{doc_id}/...` to its owner.
--
-- If you get "permission denied for schema storage", your SQL
-- editor role can't touch Supabase's managed `storage` schema.
-- Easiest fix: create the bucket via the Dashboard instead
-- (Storage → New bucket → name `documents`, private) and skip the
-- CREATE POLICY lines below (or re-run after switching the editor
-- role to `postgres`). The app only needs rows from schema.sql to
-- work; storage adds PDFs + thumbnails.
--
-- Object paths are `{user_id}/{doc_id}/preview.jpg` and
-- `{user_id}/{doc_id}/document.pdf`. The owner is the first path
-- segment (`storage.foldername(name)[1]`).
-- ============================================================

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "documents_preview_select_own" on storage.objects;
create policy "documents_preview_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents_preview_insert_own" on storage.objects;
create policy "documents_preview_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents_preview_update_own" on storage.objects;
create policy "documents_preview_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents_preview_delete_own" on storage.objects;
create policy "documents_preview_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );