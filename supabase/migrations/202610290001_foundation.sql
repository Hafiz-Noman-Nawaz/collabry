create extension if not exists pgcrypto;

create type public.team_role as enum ('owner', 'supervisor', 'leader', 'member', 'reviewer');
create type public.invitation_status as enum ('pending', 'accepted', 'declined', 'expired', 'revoked');
create type public.task_status as enum ('todo', 'in_progress', 'in_review', 'completed');
create type public.task_priority as enum ('low', 'medium', 'high', 'urgent');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  avatar_url text,
  university text,
  department text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  description text not null default '',
  university text,
  department text,
  category text,
  start_date date,
  target_date date,
  owner_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.team_members (
  team_id uuid not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.team_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  inviter_id uuid not null references auth.users(id) on delete restrict,
  invitee_email text not null,
  invitee_id uuid references auth.users(id) on delete set null,
  role public.team_role not null default 'member',
  token_hash text not null unique,
  status public.invitation_status not null default 'pending',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (team_id, invitee_email, status)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '',
  status public.task_status not null default 'todo',
  priority public.task_priority not null default 'medium',
  due_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.task_assignees (
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (task_id, user_id)
);

create index team_members_user_idx on public.team_members(user_id);
create index invitations_email_idx on public.invitations(lower(invitee_email), status);
create index tasks_team_status_idx on public.tasks(team_id, status, due_at);

create or replace function public.is_team_member(target_team uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.team_members where team_id = target_team and user_id = auth.uid()); $$;

create or replace function public.has_team_role(target_team uuid, allowed_roles public.team_role[])
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.team_members where team_id = target_team and user_id = auth.uid() and role = any(allowed_roles)); $$;

alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.invitations enable row level security;
alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (id = auth.uid() or exists (select 1 from public.team_members mine join public.team_members theirs using (team_id) where mine.user_id = auth.uid() and theirs.user_id = profiles.id));
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy teams_read on public.teams for select to authenticated using (public.is_team_member(id));
create policy teams_insert on public.teams for insert to authenticated with check (owner_id = auth.uid());
create policy teams_update on public.teams for update to authenticated using (public.has_team_role(id, array['owner']::public.team_role[]));
create policy members_read on public.team_members for select to authenticated using (public.is_team_member(team_id));
create policy members_manage on public.team_members for all to authenticated using (public.has_team_role(team_id, array['owner','leader']::public.team_role[])) with check (public.has_team_role(team_id, array['owner','leader']::public.team_role[]));
create policy invitations_read on public.invitations for select to authenticated using (inviter_id = auth.uid() or invitee_id = auth.uid() or public.is_team_member(team_id));
create policy invitations_manage on public.invitations for all to authenticated using (inviter_id = auth.uid() or public.has_team_role(team_id, array['owner','leader']::public.team_role[])) with check (inviter_id = auth.uid() or public.has_team_role(team_id, array['owner','leader']::public.team_role[]));
create policy tasks_read on public.tasks for select to authenticated using (public.is_team_member(team_id));
create policy tasks_manage on public.tasks for all to authenticated using (public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[]) or created_by = auth.uid()) with check (public.is_team_member(team_id));
create policy assignees_read on public.task_assignees for select to authenticated using (exists (select 1 from public.tasks where id = task_id and public.is_team_member(team_id)));
create policy assignees_manage on public.task_assignees for all to authenticated using (exists (select 1 from public.tasks where id = task_id and public.has_team_role(team_id, array['owner','supervisor','leader']::public.team_role[]))) with check (exists (select 1 from public.tasks where id = task_id and public.is_team_member(team_id)));

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$ begin insert into public.profiles (id, full_name) values (new.id, coalesce(new.raw_user_meta_data->>'full_name', '')); return new; end; $$;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

create or replace function public.create_team(
  team_name text,
  team_description text default '',
  team_university text default null,
  team_department text default null,
  team_category text default null,
  team_start_date date default null,
  team_target_date date default null
)
returns public.teams language plpgsql security definer set search_path = public
as $$
declare created_team public.teams;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.teams (name, description, university, department, category, start_date, target_date, owner_id)
  values (team_name, team_description, team_university, team_department, team_category, team_start_date, team_target_date, auth.uid())
  returning * into created_team;
  insert into public.team_members (team_id, user_id, role) values (created_team.id, auth.uid(), 'owner');
  return created_team;
end;
$$;

create or replace function public.accept_invitation(invitation_id uuid)
returns public.team_members language plpgsql security definer set search_path = public
as $$
declare invite public.invitations; membership public.team_members; current_email text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select email into current_email from auth.users where id = auth.uid();
  select * into invite from public.invitations where id = invitation_id and status = 'pending' and expires_at > now() for update;
  if invite.id is null then raise exception 'Invitation is unavailable'; end if;
  if invite.invitee_id is not null and invite.invitee_id <> auth.uid() then raise exception 'Invitation recipient mismatch'; end if;
  if invite.invitee_id is null and lower(invite.invitee_email) <> lower(coalesce(current_email, '')) then raise exception 'Invitation recipient mismatch'; end if;
  insert into public.team_members (team_id, user_id, role) values (invite.team_id, auth.uid(), invite.role)
  on conflict (team_id, user_id) do update set role = excluded.role returning * into membership;
  update public.invitations set status = 'accepted', invitee_id = auth.uid(), accepted_at = now() where id = invite.id;
  return membership;
end;
$$;

revoke all on function public.create_team(text, text, text, text, text, date, date) from public;
grant execute on function public.create_team(text, text, text, text, text, date, date) to authenticated;
revoke all on function public.accept_invitation(uuid) from public;
grant execute on function public.accept_invitation(uuid) to authenticated;
