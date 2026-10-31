create type public.meeting_status as enum ('scheduled', 'cancelled', 'completed');
create type public.rsvp_status as enum ('pending', 'accepted', 'declined', 'tentative');
create type public.message_kind as enum ('text', 'system');
create type public.notification_kind as enum ('invitation', 'task', 'meeting', 'message', 'announcement', 'review');

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  agenda text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'UTC',
  status public.meeting_status not null default 'scheduled',
  meeting_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table public.meeting_attendees (
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rsvp public.rsvp_status not null default 'pending',
  attended boolean,
  primary key (meeting_id, user_id)
);

create table public.meeting_minutes (
  meeting_id uuid primary key references public.meetings(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete restrict,
  body text not null default '',
  decisions text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  title text,
  is_group boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (char_length(body) between 1 and 4000),
  kind public.message_kind not null default 'text',
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  content_type text not null,
  file_size integer not null check (file_size > 0 and file_size <= 25000000),
  created_at timestamptz not null default now()
);

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  storage_path text not null unique,
  file_name text not null,
  category text not null default 'general',
  content_type text not null,
  file_size integer not null check (file_size > 0 and file_size <= 100000000),
  created_at timestamptz not null default now()
);

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id uuid references public.teams(id) on delete cascade,
  kind public.notification_kind not null,
  title text not null,
  body text not null default '',
  resource_type text,
  resource_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_invitations boolean not null default true,
  email_meetings boolean not null default true,
  email_tasks boolean not null default true,
  email_deadlines boolean not null default true,
  email_announcements boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.scheduled_jobs (
  id uuid primary key default gen_random_uuid(),
  job_key text not null unique,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  run_at timestamptz not null,
  attempts integer not null default 0,
  locked_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  team_id uuid references public.teams(id) on delete cascade,
  action text not null,
  resource_type text not null,
  resource_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index meetings_team_start_idx on public.meetings(team_id, starts_at);
create index meeting_attendees_user_idx on public.meeting_attendees(user_id);
create index conversations_team_idx on public.conversations(team_id, created_at desc);
create index conversation_members_user_idx on public.conversation_members(user_id);
create index messages_conversation_idx on public.messages(conversation_id, created_at desc);
create index project_files_team_idx on public.project_files(team_id, created_at desc);
create index notifications_user_idx on public.notifications(user_id, read_at, created_at desc);
create index audit_logs_team_idx on public.audit_logs(team_id, created_at desc);

alter table public.meetings enable row level security;
alter table public.meeting_attendees enable row level security;
alter table public.meeting_minutes enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_attachments enable row level security;
alter table public.project_files enable row level security;
alter table public.announcements enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.scheduled_jobs enable row level security;
alter table public.audit_logs enable row level security;

create policy meetings_read on public.meetings for select to authenticated using (public.is_team_member(team_id));
create policy meetings_manage on public.meetings for all to authenticated using (public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[])) with check (public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[]));
create policy meeting_attendees_read on public.meeting_attendees for select to authenticated using (exists (select 1 from public.meetings where id = meeting_id and public.is_team_member(team_id)));
create policy meeting_attendees_manage on public.meeting_attendees for all to authenticated using (exists (select 1 from public.meetings where id = meeting_id and public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[])) or user_id = auth.uid()) with check (exists (select 1 from public.meetings where id = meeting_id and public.is_team_member(team_id)));
create policy meeting_minutes_read on public.meeting_minutes for select to authenticated using (exists (select 1 from public.meetings where id = meeting_id and public.is_team_member(team_id)));
create policy meeting_minutes_manage on public.meeting_minutes for all to authenticated using (author_id = auth.uid() or exists (select 1 from public.meetings where id = meeting_id and public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[]))) with check (author_id = auth.uid());

create policy conversations_read on public.conversations for select to authenticated using (exists (select 1 from public.conversation_members where conversation_id = id and user_id = auth.uid()));
create policy conversations_create on public.conversations for insert to authenticated with check (created_by = auth.uid() and public.is_team_member(team_id));
create policy conversation_members_read on public.conversation_members for select to authenticated using (user_id = auth.uid() or exists (select 1 from public.conversation_members mine where mine.conversation_id = conversation_id and mine.user_id = auth.uid()));
create policy conversation_members_manage on public.conversation_members for all to authenticated using (exists (select 1 from public.conversations where id = conversation_id and created_by = auth.uid())) with check (exists (select 1 from public.conversations where id = conversation_id and created_by = auth.uid()));
create policy messages_read on public.messages for select to authenticated using (exists (select 1 from public.conversation_members where conversation_id = messages.conversation_id and user_id = auth.uid()));
create policy messages_send on public.messages for insert to authenticated with check (sender_id = auth.uid() and exists (select 1 from public.conversation_members where conversation_id = messages.conversation_id and user_id = auth.uid()));
create policy messages_edit on public.messages for update to authenticated using (sender_id = auth.uid()) with check (sender_id = auth.uid());
create policy message_attachments_read on public.message_attachments for select to authenticated using (exists (select 1 from public.messages m join public.conversation_members cm on cm.conversation_id = m.conversation_id where m.id = message_id and cm.user_id = auth.uid()));
create policy message_attachments_manage on public.message_attachments for all to authenticated using (exists (select 1 from public.messages where id = message_id and sender_id = auth.uid())) with check (exists (select 1 from public.messages where id = message_id and sender_id = auth.uid()));

create policy project_files_read on public.project_files for select to authenticated using (public.is_team_member(team_id));
create policy project_files_manage on public.project_files for all to authenticated using (uploaded_by = auth.uid() or public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[])) with check (uploaded_by = auth.uid() and public.is_team_member(team_id));
create policy announcements_read on public.announcements for select to authenticated using (public.is_team_member(team_id));
create policy announcements_manage on public.announcements for all to authenticated using (author_id = auth.uid() or public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[])) with check (author_id = auth.uid() and public.is_team_member(team_id));
create policy notifications_read on public.notifications for select to authenticated using (user_id = auth.uid());
create policy notifications_update on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notification_preferences_manage on public.notification_preferences for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy audit_logs_read on public.audit_logs for select to authenticated using (public.has_team_role(team_id, array['owner','supervisor']::public.team_role[]));

revoke all on public.scheduled_jobs from anon, authenticated;
revoke all on public.audit_logs from anon;
