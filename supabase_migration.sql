-- ClearPath Health — Supabase migration
-- Run this once in Supabase Dashboard → SQL Editor → New Query → paste all → Run

-- ═══════════════════════════════════════════════════════════
-- 1. OUTCOMES — each user can only see/insert/delete their OWN rows
-- ═══════════════════════════════════════════════════════════
create table if not exists public.outcomes (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id),
  user_email text,
  user_name text,
  patient text,
  insurer text,
  dx text,
  icd text,
  outcome text not null check (outcome in ('approved','denied','pending','appealed')),
  notes text,
  flag_count int not null default 0,
  critical_flags int not null default 0,
  flag_titles text[] not null default '{}'
);

alter table public.outcomes enable row level security;

create policy "select own outcomes" on public.outcomes
  for select to authenticated using (auth.uid() = user_id);
create policy "insert own outcomes" on public.outcomes
  for insert to authenticated with check (auth.uid() = user_id);
create policy "delete own outcomes" on public.outcomes
  for delete to authenticated using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════
-- 2. AGGREGATE FUNCTIONS — cross-user learning WITHOUT exposing
--    any individual user's raw rows to other users
-- ═══════════════════════════════════════════════════════════

-- Per-payer intelligence (used when generating a note/appeal)
create or replace function public.payer_insight(insurer_filter text)
returns table(
  sample_size int,
  approved int,
  denied int,
  approval_rate int,
  top_gap_titles text[]
)
language sql
security definer
set search_path = public
as $$
  with scoped as (
    select * from outcomes
    where insurer = insurer_filter
    order by created_at desc
    limit 30
  ),
  fallback as (
    select * from outcomes
    order by created_at desc
    limit 30
  ),
  pool as (
    select * from scoped where (select count(*) from scoped) >= 5
    union all
    select * from fallback where (select count(*) from scoped) < 5
  ),
  titles as (
    select unnest(flag_titles) as title from pool where outcome = 'denied'
  ),
  title_counts as (
    select title, count(*) as c from titles group by title order by c desc limit 5
  )
  select
    (select count(*) from pool)::int,
    (select count(*) from pool where outcome='approved')::int,
    (select count(*) from pool where outcome='denied')::int,
    case when (select count(*) from pool where outcome in ('approved','denied')) > 0
      then round(100.0 * (select count(*) from pool where outcome='approved')
           / (select count(*) from pool where outcome in ('approved','denied')))::int
      else null end,
    (select coalesce(array_agg(title), '{}') from title_counts);
$$;
grant execute on function public.payer_insight(text) to authenticated;

-- Org-wide stats (used for Dashboard + Patterns pages)
create or replace function public.org_stats()
returns table(
  total_cases int,
  approved int,
  denied int,
  pending int,
  approval_rate int,
  top_gap_titles text[],
  by_insurer jsonb
)
language sql
security definer
set search_path = public
as $$
  select
    count(*)::int,
    count(*) filter (where outcome='approved')::int,
    count(*) filter (where outcome='denied')::int,
    count(*) filter (where outcome='pending')::int,
    case when count(*) filter (where outcome in ('approved','denied')) > 0
      then round(100.0*count(*) filter (where outcome='approved')
           / count(*) filter (where outcome in ('approved','denied')))::int
      else null end,
    (select coalesce(array_agg(title), '{}') from (
      select unnest(flag_titles) as title from outcomes where outcome='denied'
      group by title order by count(*) desc limit 5
    ) t),
    (select coalesce(jsonb_object_agg(insurer, stats), '{}'::jsonb) from (
      select insurer,
        jsonb_build_object(
          'total', count(*),
          'approved', count(*) filter (where outcome='approved'),
          'denied', count(*) filter (where outcome='denied'),
          'rate', case when count(*) filter (where outcome in ('approved','denied'))>0
            then round(100.0*count(*) filter (where outcome='approved')
                 / count(*) filter (where outcome in ('approved','denied')))
            else null end
        ) as stats
      from outcomes group by insurer
    ) s)
  from outcomes;
$$;
grant execute on function public.org_stats() to authenticated;

-- ═══════════════════════════════════════════════════════════
-- 3. API RATE LIMITING — tracks primary AI-generation actions
--    per user (5/hour, enforced server-side in api/generate.js)
-- ═══════════════════════════════════════════════════════════
create table if not exists public.api_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id),
  action text not null
);
alter table public.api_usage enable row level security;
create policy "insert own usage" on public.api_usage
  for insert to authenticated with check (auth.uid() = user_id);
create policy "select own usage" on public.api_usage
  for select to authenticated using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════
-- 4. ERROR LOGGING + ALERT THROTTLE — powers the email alert system
-- ═══════════════════════════════════════════════════════════
create table if not exists public.error_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_email text,
  context text,
  message text
);
alter table public.error_logs enable row level security;
create policy "insert error logs" on public.error_logs
  for insert to authenticated with check (true);
create policy "select error logs" on public.error_logs
  for select to authenticated using (true);

create table if not exists public.alert_state (
  id int primary key default 1,
  last_alert_at timestamptz
);
insert into public.alert_state (id, last_alert_at) values (1, null)
  on conflict (id) do nothing;
alter table public.alert_state enable row level security;
create policy "read alert state" on public.alert_state
  for select to authenticated using (true);
create policy "update alert state" on public.alert_state
  for update to authenticated using (true) with check (true);
