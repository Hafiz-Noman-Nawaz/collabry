-- Ensure roadmap storage exists even when the initial roadmap migration was
-- skipped during deployment, then refresh PostgREST's schema cache.

create table if not exists public.roadmap_phases (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text not null check (char_length(title) between 1 and 140),
  summary text not null default '',
  position int not null default 1 check (position between 1 and 50),
  status text not null default 'planned' check (status in ('planned', 'active', 'done')),
  start_date date,
  end_date date,
  source text not null default 'manual' check (source in ('manual', 'gemini')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists roadmap_phases_team_idx on public.roadmap_phases(team_id, position);

alter table public.roadmap_phases enable row level security;

drop policy if exists roadmap_phases_read on public.roadmap_phases;
create policy roadmap_phases_read on public.roadmap_phases for select to authenticated
  using (public.is_team_member(team_id));

drop policy if exists roadmap_phases_manage on public.roadmap_phases;
create policy roadmap_phases_manage on public.roadmap_phases for all to authenticated
  using (public.has_team_role(team_id, array['owner', 'supervisor', 'leader']::public.team_role[]) or created_by = auth.uid())
  with check (public.is_team_member(team_id));

alter table public.tasks add column if not exists phase_id uuid references public.roadmap_phases(id) on delete set null;
create index if not exists tasks_phase_idx on public.tasks(phase_id);

notify pgrst, 'reload schema';
