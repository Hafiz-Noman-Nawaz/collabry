-- Keep project knowledge synchronized with collaboration records.
-- Content is indexed for grounded full-text retrieval; embeddings remain optional.

create or replace function public.upsert_ai_knowledge(
  target_team uuid,
  target_type text,
  target_id uuid,
  target_title text,
  target_content text,
  target_metadata jsonb,
  target_user uuid
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized_content text := left(coalesce(target_content, ''), 12000);
  normalized_title text := left(coalesce(target_title, ''), 240);
  content_hash_value text := md5(normalized_title || E'\n' || normalized_content);
begin
  if target_team is null or char_length(normalized_content) = 0 then
    return;
  end if;

  delete from public.ai_knowledge_chunks
  where team_id = target_team
    and source_type = target_type
    and source_id is not distinct from target_id;

  insert into public.ai_knowledge_chunks (
    team_id, source_type, source_id, title, content, metadata, content_hash, created_by, updated_at
  )
  values (
    target_team,
    target_type,
    target_id,
    normalized_title,
    normalized_content,
    coalesce(target_metadata, '{}'::jsonb),
    content_hash_value,
    target_user,
    now()
  );
end;
$$;

create or replace function public.index_task_for_ai()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.ai_knowledge_chunks where source_type = 'task' and source_id = old.id;
    return old;
  end if;

  perform public.upsert_ai_knowledge(
    new.team_id,
    'task',
    new.id,
    new.title,
    concat(
      coalesce(new.description, ''),
      E'\nStatus: ', new.status::text,
      E'\nPriority: ', new.priority::text,
      E'\nDue: ', coalesce(new.due_at::text, 'not set')
    ),
    jsonb_build_object('status', new.status, 'priority', new.priority, 'dueAt', new.due_at),
    new.created_by
  );
  return new;
end;
$$;

create or replace function public.index_roadmap_phase_for_ai()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.ai_knowledge_chunks where source_type = 'roadmap' and source_id = old.id;
    return old;
  end if;

  perform public.upsert_ai_knowledge(
    new.team_id,
    'roadmap',
    new.id,
    new.title,
    concat(coalesce(new.summary, ''), E'\nStatus: ', new.status, E'\nPosition: ', new.position),
    jsonb_build_object('status', new.status, 'position', new.position, 'startDate', new.start_date, 'endDate', new.end_date),
    new.created_by
  );
  return new;
end;
$$;

create or replace function public.index_meeting_for_ai()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.ai_knowledge_chunks where source_type = 'meeting' and source_id = old.id;
    return old;
  end if;

  perform public.upsert_ai_knowledge(
    new.team_id,
    'meeting',
    new.id,
    new.title,
    concat(
      'Agenda: ', coalesce(new.agenda, ''),
      E'\nStarts: ', new.starts_at::text,
      E'\nStatus: ', new.status::text
    ),
    jsonb_build_object('status', new.status, 'startsAt', new.starts_at, 'endsAt', new.ends_at),
    new.created_by
  );
  return new;
end;
$$;

create or replace function public.index_minutes_for_ai()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  meeting public.meetings%rowtype;
begin
  select * into meeting from public.meetings where id = new.meeting_id;
  if meeting.id is null then
    return new;
  end if;

  perform public.upsert_ai_knowledge(
    meeting.team_id,
    'meeting',
    meeting.id,
    meeting.title,
    concat(
      'Agenda: ', coalesce(meeting.agenda, ''),
      E'\nMinutes: ', coalesce(new.body, ''),
      E'\nDecisions: ', coalesce(new.decisions, '')
    ),
    jsonb_build_object('status', meeting.status, 'startsAt', meeting.starts_at, 'hasMinutes', true),
    new.author_id
  );
  return new;
end;
$$;

create or replace function public.index_message_for_ai()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  conversation_team uuid;
begin
  if tg_op = 'DELETE' or new.deleted_at is not null then
    if tg_op <> 'DELETE' then
      delete from public.ai_knowledge_chunks where source_type = 'message' and source_id = new.id;
    else
      delete from public.ai_knowledge_chunks where source_type = 'message' and source_id = old.id;
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  select team_id into conversation_team from public.conversations where id = new.conversation_id;
  perform public.upsert_ai_knowledge(
    conversation_team,
    'message',
    new.id,
    'Conversation message',
    new.body,
    jsonb_build_object('conversationId', new.conversation_id, 'senderId', new.sender_id, 'createdAt', new.created_at),
    new.sender_id
  );
  return new;
end;
$$;

create or replace function public.index_announcement_for_ai()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.ai_knowledge_chunks where source_type = 'announcement' and source_id = old.id;
    return old;
  end if;

  perform public.upsert_ai_knowledge(
    new.team_id,
    'announcement',
    new.id,
    new.title,
    new.body,
    jsonb_build_object('createdAt', new.created_at, 'updatedAt', new.updated_at),
    new.author_id
  );
  return new;
end;
$$;

create or replace function public.index_project_file_for_ai()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.ai_knowledge_chunks where source_type = 'file' and source_id = old.id;
    return old;
  end if;

  perform public.upsert_ai_knowledge(
    new.team_id,
    'file',
    new.id,
    new.file_name,
    concat(
      'Uploaded project file: ', new.file_name,
      E'\nCategory: ', new.category,
      E'\nType: ', new.content_type,
      E'\nFile contents are not extracted yet.'
    ),
    jsonb_build_object('fileName', new.file_name, 'category', new.category, 'contentType', new.content_type, 'fileSize', new.file_size),
    new.uploaded_by
  );
  return new;
end;
$$;

drop trigger if exists ai_index_tasks on public.tasks;
create trigger ai_index_tasks after insert or update or delete on public.tasks
for each row execute function public.index_task_for_ai();

drop trigger if exists ai_index_roadmap_phases on public.roadmap_phases;
create trigger ai_index_roadmap_phases after insert or update or delete on public.roadmap_phases
for each row execute function public.index_roadmap_phase_for_ai();

drop trigger if exists ai_index_meetings on public.meetings;
create trigger ai_index_meetings after insert or update or delete on public.meetings
for each row execute function public.index_meeting_for_ai();

drop trigger if exists ai_index_meeting_minutes on public.meeting_minutes;
create trigger ai_index_meeting_minutes after insert or update or delete on public.meeting_minutes
for each row execute function public.index_minutes_for_ai();

drop trigger if exists ai_index_messages on public.messages;
create trigger ai_index_messages after insert or update or delete on public.messages
for each row execute function public.index_message_for_ai();

drop trigger if exists ai_index_announcements on public.announcements;
create trigger ai_index_announcements after insert or update or delete on public.announcements
for each row execute function public.index_announcement_for_ai();

drop trigger if exists ai_index_project_files on public.project_files;
create trigger ai_index_project_files after insert or update or delete on public.project_files
for each row execute function public.index_project_file_for_ai();

revoke all on function public.upsert_ai_knowledge(uuid, text, uuid, text, text, jsonb, uuid) from public;
revoke all on function public.index_task_for_ai() from public;
revoke all on function public.index_roadmap_phase_for_ai() from public;
revoke all on function public.index_meeting_for_ai() from public;
revoke all on function public.index_minutes_for_ai() from public;
revoke all on function public.index_message_for_ai() from public;
revoke all on function public.index_announcement_for_ai() from public;
revoke all on function public.index_project_file_for_ai() from public;

-- Backfill current records when this migration is applied.
insert into public.ai_knowledge_chunks (team_id, source_type, source_id, title, content, metadata, content_hash, created_by)
select t.team_id, 'task', t.id, t.title,
  left(concat(coalesce(t.description, ''), E'\nStatus: ', t.status::text, E'\nPriority: ', t.priority::text, E'\nDue: ', coalesce(t.due_at::text, 'not set')), 12000),
  jsonb_build_object('status', t.status, 'priority', t.priority, 'dueAt', t.due_at),
  md5(t.title || E'\n' || left(concat(coalesce(t.description, ''), E'\nStatus: ', t.status::text, E'\nPriority: ', t.priority::text, E'\nDue: ', coalesce(t.due_at::text, 'not set')), 12000)),
  t.created_by
from public.tasks t
on conflict (team_id, source_type, source_id, content_hash) do nothing;

insert into public.ai_knowledge_chunks (team_id, source_type, source_id, title, content, metadata, content_hash, created_by)
select p.team_id, 'roadmap', p.id, p.title, left(concat(coalesce(p.summary, ''), E'\nStatus: ', p.status, E'\nPosition: ', p.position), 12000),
  jsonb_build_object('status', p.status, 'position', p.position, 'startDate', p.start_date, 'endDate', p.end_date),
  md5(p.title || E'\n' || left(concat(coalesce(p.summary, ''), E'\nStatus: ', p.status, E'\nPosition: ', p.position), 12000)),
  p.created_by
from public.roadmap_phases p
on conflict (team_id, source_type, source_id, content_hash) do nothing;

insert into public.ai_knowledge_chunks (team_id, source_type, source_id, title, content, metadata, content_hash, created_by)
select a.team_id, 'announcement', a.id, a.title, left(a.body, 12000),
  jsonb_build_object('createdAt', a.created_at, 'updatedAt', a.updated_at),
  md5(a.title || E'\n' || left(a.body, 12000)),
  a.author_id
from public.announcements a
on conflict (team_id, source_type, source_id, content_hash) do nothing;

notify pgrst, 'reload schema';
