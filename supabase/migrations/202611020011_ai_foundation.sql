-- Project-scoped AI knowledge and usage foundation.
-- Vector search is optional at runtime: full-text retrieval remains available
-- until an embedding provider is configured.

create extension if not exists vector with schema extensions;

create table if not exists public.ai_knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams(id) on delete cascade,
  source_type text not null check (source_type in ('task', 'roadmap', 'message', 'meeting', 'file', 'announcement', 'manual')),
  source_id uuid,
  title text not null default '',
  content text not null check (char_length(content) between 1 and 12000),
  metadata jsonb not null default '{}'::jsonb,
  content_hash text not null,
  embedding extensions.vector(1536),
  search_document tsvector generated always as (
    to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, source_type, source_id, content_hash)
);

create index if not exists ai_knowledge_team_idx on public.ai_knowledge_chunks(team_id, source_type, created_at desc);
create index if not exists ai_knowledge_search_idx on public.ai_knowledge_chunks using gin(search_document);
create index if not exists ai_knowledge_embedding_idx on public.ai_knowledge_chunks using hnsw (embedding extensions.vector_cosine_ops);

alter table public.ai_knowledge_chunks enable row level security;

drop policy if exists ai_knowledge_read on public.ai_knowledge_chunks;
create policy ai_knowledge_read on public.ai_knowledge_chunks for select to authenticated
  using (public.is_team_member(team_id));

drop policy if exists ai_knowledge_manage on public.ai_knowledge_chunks;
create policy ai_knowledge_manage on public.ai_knowledge_chunks for all to authenticated
  using (public.has_team_role(team_id, array['owner', 'supervisor', 'leader']::public.team_role[]) or created_by = auth.uid())
  with check (public.is_team_member(team_id));

create or replace function public.search_ai_knowledge(
  target_team uuid,
  query_text text,
  query_embedding extensions.vector(1536) default null,
  result_limit int default 8
)
returns table (
  id uuid,
  source_type text,
  source_id uuid,
  title text,
  content text,
  metadata jsonb,
  score real
)
language sql stable security definer set search_path = public, extensions
as $$
  select
    chunk.id,
    chunk.source_type,
    chunk.source_id,
    chunk.title,
    chunk.content,
    chunk.metadata,
    case
      when query_embedding is not null and chunk.embedding is not null
        then (1 - (chunk.embedding <=> query_embedding))::real
      else ts_rank_cd(chunk.search_document, websearch_to_tsquery('simple', query_text))::real
    end as score
  from public.ai_knowledge_chunks chunk
  where chunk.team_id = target_team
    and public.is_team_member(target_team)
    and (
      (query_embedding is not null and chunk.embedding is not null)
      or chunk.search_document @@ websearch_to_tsquery('simple', query_text)
    )
  order by score desc, chunk.updated_at desc
  limit greatest(1, least(result_limit, 20));
$$;

revoke all on function public.search_ai_knowledge(uuid, text, extensions.vector, int) from public;
grant execute on function public.search_ai_knowledge(uuid, text, extensions.vector, int) to authenticated;

create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  team_id uuid references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  feature text not null check (char_length(feature) between 1 and 80),
  provider text not null check (char_length(provider) between 1 and 40),
  model text not null check (char_length(model) between 1 and 120),
  input_tokens integer,
  output_tokens integer,
  source_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_team_idx on public.ai_usage_events(team_id, feature, created_at desc);
alter table public.ai_usage_events enable row level security;

drop policy if exists ai_usage_read on public.ai_usage_events;
create policy ai_usage_read on public.ai_usage_events for select to authenticated
  using (user_id = auth.uid() or public.is_team_member(team_id));

notify pgrst, 'reload schema';
