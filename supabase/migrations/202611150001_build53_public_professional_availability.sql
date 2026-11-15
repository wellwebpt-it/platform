-- Build 5.3: track public publication recency and expose only aggregate
-- availability summaries for already-public professional profiles.

begin;

alter table public.professional_profiles
  add column published_at timestamptz;

-- Existing public profiles become the baseline cohort. Their true historical
-- publication times are unknown, so use this migration's timestamp and a
-- stable profile-id tie-breaker in the client.
update public.professional_profiles p
set published_at = statement_timestamp()
from public.app_users u
where u.id = p.user_id
  and u.account_type = 'PROFESSIONAL'
  and u.status = 'ACTIVE'
  and p.approval_status = 'APPROVED'
  and p.is_public;

create or replace function public.set_professional_published_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.approval_status = 'APPROVED' and new.is_public then
    if tg_op = 'INSERT' then
      new.published_at := statement_timestamp();
    elsif old.approval_status is distinct from new.approval_status
       or old.is_public is distinct from new.is_public
       or old.published_at is null then
      new.published_at := statement_timestamp();
    else
      new.published_at := old.published_at;
    end if;
  else
    new.published_at := null;
  end if;
  return new;
end;
$$;
revoke all on function public.set_professional_published_at() from public, anon, authenticated;

create trigger professional_profiles_set_published_at
before insert or update of approval_status, is_public on public.professional_profiles
for each row execute function public.set_professional_published_at();

create or replace function public.sync_professional_publication_account_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'ACTIVE' then
    update public.professional_profiles p
    set published_at = statement_timestamp()
    where p.user_id = new.id
      and p.approval_status = 'APPROVED'
      and p.is_public
      and p.published_at is null;
  else
    update public.professional_profiles p
    set published_at = null
    where p.user_id = new.id
      and p.published_at is not null;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_professional_publication_account_status() from public, anon, authenticated;

create trigger app_users_sync_professional_publication
after update of status on public.app_users
for each row
when (old.status is distinct from new.status)
execute function public.sync_professional_publication_account_status();

-- Add the publication timestamp at the end of the public allowlist view. No
-- private account, booking, availability-block, or contact fields are added.
create or replace view public.public_professional_directory
with (security_barrier = true) as
select p.id,p.public_name,p.city,p.service_area,p.description,
  coalesce((select array_agg(s.name order by s.name) from public.professional_services s where s.professional_profile_id=p.id and s.active),'{}'::text[]) as services,
  coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'description',s.description,'modality_slug',s.modality_slug,
    'duration_minutes',s.duration_minutes,'price',s.price,'currency',s.currency,'has_material',s.has_material,
    'allows_group',s.allows_group,'max_students',s.max_students,'price_per_student',s.price_per_student) order by s.name)
    from public.professional_services s where s.professional_profile_id=p.id and s.active),'[]'::jsonb) as service_details,
  coalesce((select array_agg(m.name order by m.name) from public.professional_modalities pm join public.modality_catalog m on m.slug=pm.modality_slug and m.active where pm.professional_profile_id=p.id),'{}'::text[]) as modalities,
  p.languages,p.primary_photo_path,p.gallery_photo_paths,p.published_at
from public.professional_profiles p
join public.app_users u on u.id=p.user_id
where p.is_public
  and p.approval_status='APPROVED'
  and p.published_at is not null
  and u.account_type='PROFESSIONAL'
  and u.status='ACTIVE';

create or replace function public.wellweb_local_datetime_to_utc(p_local timestamp without time zone)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select p_local at time zone 'Europe/Lisbon';
$$;
revoke all on function public.wellweb_local_datetime_to_utc(timestamp without time zone) from public, anon, authenticated;

create or replace function public.wellweb_public_professional_availability(p_profile_ids uuid[])
returns table(professional_profile_id uuid, summary_code text, days_until smallint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := statement_timestamp();
  v_today date := (statement_timestamp() at time zone 'Europe/Lisbon')::date;
  v_week_end timestamptz := (((date_trunc('week', statement_timestamp() at time zone 'Europe/Lisbon')::date + 7)::timestamp) at time zone 'Europe/Lisbon');
  v_horizon timestamptz := statement_timestamp() + interval '7 days';
begin
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 then
    return;
  end if;
  if cardinality(p_profile_ids) > 50 then
    raise exception 'At most 50 professional profiles can be summarized at once';
  end if;

  return query
  with eligible as (
    select p.id
    from public.professional_profiles p
    join public.app_users u on u.id=p.user_id
    where p.id = any(p_profile_ids)
      and p.is_public
      and p.approval_status='APPROVED'
      and p.published_at is not null
      and u.account_type='PROFESSIONAL'
      and u.status='ACTIVE'
  ),
  services as (
    select s.professional_profile_id, s.duration_minutes
    from public.professional_services s
    join eligible e on e.id=s.professional_profile_id
    where s.active and s.duration_minutes between 5 and 1440
  ),
  dates as (
    select d::date as local_date
    from generate_series(v_today::timestamp, ((v_horizon at time zone 'Europe/Lisbon')::date)::timestamp, interval '1 day') d
  ),
  weekly_candidates as (
    select s.professional_profile_id,
      public.wellweb_local_datetime_to_utc(series.local_start) as starts_at,
      public.wellweb_local_datetime_to_utc(series.local_start) + make_interval(mins=>s.duration_minutes) as ends_at
    from dates d
    join public.professional_weekly_availability a
      on a.day_of_week=extract(dow from d.local_date)::smallint
    join services s on s.professional_profile_id=a.professional_profile_id
    cross join lateral generate_series(
      d.local_date+a.start_time,
      d.local_date+a.end_time-make_interval(mins=>s.duration_minutes),
      interval '30 minutes'
    ) series(local_start)
  ),
  available_override_candidates as (
    select s.professional_profile_id,
      public.wellweb_local_datetime_to_utc(series.local_start) as starts_at,
      public.wellweb_local_datetime_to_utc(series.local_start) + make_interval(mins=>s.duration_minutes) as ends_at
    from public.professional_availability_overrides o
    join services s on s.professional_profile_id=o.professional_profile_id
    cross join lateral generate_series(
      o.starts_at at time zone 'Europe/Lisbon',
      (o.ends_at at time zone 'Europe/Lisbon')-make_interval(mins=>s.duration_minutes),
      interval '30 minutes'
    ) series(local_start)
    where o.override_type='AVAILABLE'
      and o.ends_at>=(v_now+interval '4 hours')
      and o.starts_at<v_horizon
  ),
  candidates as (
    select * from weekly_candidates
    union
    select * from available_override_candidates
  ),
  bookable as (
    select c.professional_profile_id,c.starts_at,c.ends_at
    from candidates c
    where c.starts_at>=v_now+interval '4 hours'
      and c.starts_at<v_horizon
      and public.wellweb_booking_interval_is_available(c.professional_profile_id,c.starts_at,c.ends_at)
      and not exists (
        select 1 from public.wellweb_bookings b
        where b.professional_profile_id=c.professional_profile_id
          and b.status='CONFIRMED'
          and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(c.starts_at,c.ends_at,'[)')
      )
  ),
  per_profile as (
    select e.id,
      exists(select 1 from services s where s.professional_profile_id=e.id) as has_service,
      exists(select 1 from bookable b where b.professional_profile_id=e.id and b.starts_at<v_week_end) as has_this_week,
      min(b.starts_at) as next_starts_at
    from eligible e
    left join bookable b on b.professional_profile_id=e.id
    group by e.id
  )
  select p.id,
    case
      when not p.has_service then 'NO_ACTIVE_SERVICE'
      when p.has_this_week then 'AVAILABLE_THIS_WEEK'
      when p.next_starts_at is null then 'NONE_NEXT_7_DAYS'
      else 'NEXT_SLOT'
    end,
    case when p.next_starts_at is null then null
      else ((p.next_starts_at at time zone 'Europe/Lisbon')::date-v_today)::smallint
    end
  from per_profile p;
end;
$$;
revoke all on function public.wellweb_public_professional_availability(uuid[]) from public;
grant execute on function public.wellweb_public_professional_availability(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
