-- Instant message delivery. The chat client already subscribes to
-- postgres_changes on public.messages, but Supabase Realtime only streams rows
-- from tables that belong to the supabase_realtime publication. These tables
-- were never added, so every subscription connected successfully and then
-- received nothing: readers had to reload the page to see a teammate's message.
--
-- Idempotent, safe to re-run, and changes no rows. REPLICA IDENTITY FULL makes
-- the UPDATE and DELETE payloads carry the row contents, so an edit or a
-- deletion can be applied in place instead of refetching the thread.

-- The publication is created by Supabase on hosted projects; guard for the
-- case where it is missing so this script never aborts.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

alter table public.messages replica identity full;
alter table public.message_reactions replica identity full;
alter table public.message_attachments replica identity full;
alter table public.notifications replica identity full;

-- ALTER PUBLICATION has no IF NOT EXISTS, so skip tables already published.
do $$
declare
  target text;
begin
  foreach target in array array['messages', 'message_reactions', 'message_attachments', 'notifications'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = target
    ) then
      execute format('alter publication supabase_realtime add table public.%I', target);
    end if;
  end loop;
end $$;

-- Realtime evaluates the subscriber's own row-level security policies, and
-- SELECT is already limited to conversation members (messages_read) and to the
-- owner of a notification (notifications_read). Nothing new is exposed: a
-- subscriber only ever receives events for rows they could already read.
