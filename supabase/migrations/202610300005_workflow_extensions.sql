create type public.task_review_state as enum ('pending', 'approved', 'changes_requested');

-- Server-only helper: maps an email address to an auth user id so invitation
-- delivery can honour that user's notification preferences.
create or replace function public.user_id_by_email(p_email text)
returns uuid language sql stable security definer set search_path = public
as $$ select id from auth.users where lower(email) = lower(p_email) limit 1 $$;
revoke all on function public.user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.user_id_by_email(text) to service_role;
create type public.file_submission_state as enum ('draft', 'submitted', 'approved', 'changes_requested');

create table public.task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_checklist_items (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 200),
  done boolean not null default false,
  position integer not null default 0,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  from_value text,
  to_value text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.task_reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  state public.task_review_state not null default 'pending',
  body text not null default '',
  created_at timestamptz not null default now()
);

create table public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 8),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table public.meeting_action_items (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  assignee_id uuid references auth.users(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  done boolean not null default false,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.project_files
  add column task_id uuid references public.tasks(id) on delete set null,
  add column submission_status public.file_submission_state not null default 'draft',
  add column review_note text not null default '',
  add column reviewed_by uuid references auth.users(id) on delete set null,
  add column reviewed_at timestamptz;

alter table public.teams add column storage_quota_bytes bigint not null default 1073741824;

create index task_comments_task_idx on public.task_comments(task_id, created_at);
create index task_checklist_task_idx on public.task_checklist_items(task_id, position);
create index task_events_task_idx on public.task_events(task_id, created_at desc);
create index task_reviews_task_idx on public.task_reviews(task_id, created_at desc);
create index message_reactions_message_idx on public.message_reactions(message_id);
create index meeting_action_items_meeting_idx on public.meeting_action_items(meeting_id);
create index project_files_task_idx on public.project_files(task_id);

alter table public.task_comments enable row level security;
alter table public.task_checklist_items enable row level security;
alter table public.task_events enable row level security;
alter table public.task_reviews enable row level security;
alter table public.message_reactions enable row level security;
alter table public.meeting_action_items enable row level security;

create policy task_comments_read on public.task_comments for select to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_comments_insert on public.task_comments for insert to authenticated
with check (author_id = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_comments_update on public.task_comments for update to authenticated
using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy task_comments_delete on public.task_comments for delete to authenticated
using (author_id = auth.uid() or exists (select 1 from public.tasks t where t.id = task_id and public.has_team_role(t.team_id, array['owner','leader']::public.team_role[])));

create policy task_checklist_read on public.task_checklist_items for select to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_checklist_insert on public.task_checklist_items for insert to authenticated
with check (created_by = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_checklist_update on public.task_checklist_items for update to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)))
with check (exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_checklist_delete on public.task_checklist_items for delete to authenticated
using (created_by = auth.uid() or exists (select 1 from public.tasks t where t.id = task_id and public.has_team_role(t.team_id, array['owner','leader']::public.team_role[])));

create policy task_events_read on public.task_events for select to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_events_insert on public.task_events for insert to authenticated
with check (actor_id = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));

create policy task_reviews_read on public.task_reviews for select to authenticated
using (exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_reviews_insert on public.task_reviews for insert to authenticated
with check (reviewer_id = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id and public.is_team_member(t.team_id)));
create policy task_reviews_delete on public.task_reviews for delete to authenticated
using (reviewer_id = auth.uid());

create policy message_reactions_read on public.message_reactions for select to authenticated
using (exists (select 1 from public.messages m join public.conversation_members cm on cm.conversation_id = m.conversation_id where m.id = message_id and cm.user_id = auth.uid()));
create policy message_reactions_insert on public.message_reactions for insert to authenticated
with check (user_id = auth.uid() and exists (select 1 from public.messages m join public.conversation_members cm on cm.conversation_id = m.conversation_id where m.id = message_id and cm.user_id = auth.uid()));
create policy message_reactions_delete on public.message_reactions for delete to authenticated
using (user_id = auth.uid());

-- Members may update only their own membership row (last_read_at / typing state).
create policy conversation_members_mark_read on public.conversation_members for update to authenticated
using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The original combined "for all" policy forced uploaded_by = auth.uid() on
-- UPDATE, which blocked reviewer decisions. Split it so uploads stay restricted to
-- the uploader while reviewers can record decisions on other people's files.
drop policy project_files_manage on public.project_files;
create policy project_files_insert on public.project_files for insert to authenticated
with check (uploaded_by = auth.uid() and public.is_team_member(team_id));
create policy project_files_update on public.project_files for update to authenticated
using (uploaded_by = auth.uid() or public.has_team_role(team_id, array['owner','supervisor','leader','reviewer']::public.team_role[]))
with check (public.is_team_member(team_id));
create policy project_files_delete on public.project_files for delete to authenticated
using (uploaded_by = auth.uid() or public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[]));

create policy meeting_action_items_read on public.meeting_action_items for select to authenticated
using (exists (select 1 from public.meetings mt where id = meeting_id and public.is_team_member(mt.team_id)));
create policy meeting_action_items_insert on public.meeting_action_items for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.meetings mt where id = meeting_id and public.is_team_member(mt.team_id))
);
create policy meeting_action_items_update on public.meeting_action_items for update to authenticated
using (
  exists (select 1 from public.meetings mt where id = meeting_id and public.has_team_role(mt.team_id, array['owner','supervisor','leader']::public.team_role[]))
  or created_by = auth.uid()
  or assignee_id = auth.uid()
) with check (
  exists (select 1 from public.meetings mt where id = meeting_id and public.is_team_member(mt.team_id))
);
create policy meeting_action_items_delete on public.meeting_action_items for delete to authenticated
using (
  exists (select 1 from public.meetings mt where id = meeting_id and public.has_team_role(mt.team_id, array['owner','supervisor','leader']::public.team_role[]))
  or created_by = auth.uid()
);
