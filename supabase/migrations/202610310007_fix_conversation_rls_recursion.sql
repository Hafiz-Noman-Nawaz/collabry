-- Fixes "infinite recursion detected in policy for relation conversation_members"
-- and the follow-on "new row violates row-level security policy for table conversations".
--
-- Root cause: RLS checks are evaluated as the calling role, so a policy that
-- reads a protected table inherits that table's own policies. The chat policies
-- formed cycles: conversation_members -> conversation_members,
-- conversation_members -> conversations -> conversation_members, and
-- messages -> conversation_members. Security-definer helpers below run as the
-- table owner, whose access bypasses RLS, so no policy reads a protected table
-- directly anymore. This mirrors the existing is_team_member/has_team_role
-- pattern. Idempotent, safe to re-run, and touches no rows.

create or replace function public.is_conversation_member(target_conversation uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.conversation_members
  where conversation_id = target_conversation and user_id = auth.uid()
) $$;

-- Guards against a deleted conversation leaving an orphaned member row, which a
-- plain id-matches-a-row test would still accept.
create or replace function public.is_conversation_creator(target_conversation uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (
  select 1 from public.conversations
  where id = target_conversation and created_by = auth.uid()
) $$;

-- Lets conversation_members policies reach the owning team without reading
-- public.conversations as the caller, which would re-enter conversations_read.
create or replace function public.conversation_team_id(target_conversation uuid)
returns uuid language sql stable security definer set search_path = public
as $$ select team_id from public.conversations where id = target_conversation $$;

revoke all on function public.is_conversation_member(uuid) from public;
grant execute on function public.is_conversation_member(uuid) to anon, authenticated, service_role;
revoke all on function public.is_conversation_creator(uuid) from public;
grant execute on function public.is_conversation_creator(uuid) to anon, authenticated, service_role;
revoke all on function public.conversation_team_id(uuid) from public;
grant execute on function public.conversation_team_id(uuid) to anon, authenticated, service_role;

-- conversations: the creator always sees their own channel (this is what makes
-- the post-insert return-representation round-trip succeed, before any member
-- row exists); membership grants access to shared channels.
drop policy if exists conversations_read on public.conversations;
create policy conversations_read on public.conversations for select to authenticated
  using (created_by = auth.uid() or public.is_conversation_member(id));

drop policy if exists conversations_manage on public.conversations;
create policy conversations_manage on public.conversations for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid() and public.is_team_member(team_id));

drop policy if exists conversations_delete on public.conversations;
create policy conversations_delete on public.conversations for delete to authenticated
  using (created_by = auth.uid());

-- conversation_members: reads check only the row's own columns plus the helper;
-- the conversation creator manages membership, and every member may touch only
-- their own row (last_read_at / typing state).
drop policy if exists conversation_members_read on public.conversation_members;
create policy conversation_members_read on public.conversation_members for select to authenticated
  using (user_id = auth.uid() or public.is_conversation_member(conversation_id));

drop policy if exists conversation_members_manage on public.conversation_members;
create policy conversation_members_manage on public.conversation_members for all to authenticated
  using (public.is_conversation_creator(conversation_id))
  with check (public.is_conversation_creator(conversation_id)
              and public.is_team_member(public.conversation_team_id(conversation_id)));

drop policy if exists conversation_members_mark_read on public.conversation_members;
create policy conversation_members_mark_read on public.conversation_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- messages: membership resolved through the helper instead of an RLS sub-query
-- on conversation_members, which previously re-entered its own policy.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (public.is_conversation_member(conversation_id));

drop policy if exists messages_send on public.messages;
create policy messages_send on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_conversation_member(conversation_id));

drop policy if exists message_reactions_read on public.message_reactions;
create policy message_reactions_read on public.message_reactions for select to authenticated
  using (public.is_conversation_member(
    (select m.conversation_id from public.messages m where m.id = message_id)));

drop policy if exists message_reactions_insert on public.message_reactions;
create policy message_reactions_insert on public.message_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.is_conversation_member(
    (select m.conversation_id from public.messages m where m.id = message_id)));

drop policy if exists message_reactions_delete on public.message_reactions;
create policy message_reactions_delete on public.message_reactions for delete to authenticated
  using (user_id = auth.uid());

drop policy if exists message_attachments_read on public.message_attachments;
create policy message_attachments_read on public.message_attachments for select to authenticated
  using (exists (select 1 from public.messages m
                 where m.id = message_id and public.is_conversation_member(m.conversation_id)));
