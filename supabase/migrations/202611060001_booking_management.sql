-- Build 5: partner services, availability, reservations and in-app notifications.
-- Every booking state change is performed by a permission-checking RPC.

begin;

create type public.wellweb_booking_status as enum
  ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED');
create type public.wellweb_availability_override_type as enum ('AVAILABLE', 'BLOCKED');

alter table public.professional_services
  add column modality_slug text references public.modality_catalog(slug) on update cascade,
  add column currency char(3) not null default 'EUR';
alter table public.professional_services
  add constraint professional_services_duration_valid
    check (duration_minutes is null or duration_minutes between 5 and 1440),
  add constraint professional_services_price_valid
    check (price is null or price >= 0),
  add constraint professional_services_currency_eur
    check (currency = 'EUR');
create index professional_services_profile_active_idx
  on public.professional_services (professional_profile_id, active);

create table public.professional_weekly_availability (
  id uuid primary key default gen_random_uuid(),
  professional_profile_id uuid not null references public.professional_profiles(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  constraint professional_weekly_availability_range check (end_time > start_time)
);
create index professional_weekly_availability_lookup_idx
  on public.professional_weekly_availability (professional_profile_id, day_of_week, start_time);

create table public.professional_availability_overrides (
  id uuid primary key default gen_random_uuid(),
  professional_profile_id uuid not null references public.professional_profiles(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  override_type public.wellweb_availability_override_type not null,
  reason text,
  created_at timestamptz not null default now(),
  constraint professional_availability_overrides_range check (ends_at > starts_at),
  constraint professional_availability_overrides_reason_length check (reason is null or length(reason) <= 500)
);
create index professional_availability_overrides_lookup_idx
  on public.professional_availability_overrides (professional_profile_id, starts_at, ends_at);

create table public.wellweb_bookings (
  id uuid primary key default gen_random_uuid(),
  booking_reference text not null unique default
    ('WW-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))),
  hotel_id uuid not null references public.hotels(id),
  professional_profile_id uuid not null references public.professional_profiles(id),
  service_id uuid references public.professional_services(id) on delete set null,
  service_name_snapshot text not null,
  service_duration_minutes_snapshot integer not null check (service_duration_minutes_snapshot between 5 and 1440),
  service_price_snapshot numeric(10,2) check (service_price_snapshot is null or service_price_snapshot >= 0),
  service_currency_snapshot char(3) not null default 'EUR' check (service_currency_snapshot = 'EUR'),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  participants integer not null check (participants between 1 and 100),
  guest_name text check (guest_name is null or length(guest_name) <= 200),
  notes text check (notes is null or length(notes) <= 3000),
  status public.wellweb_booking_status not null default 'PENDING',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint wellweb_bookings_range check (ends_at > starts_at),
  constraint wellweb_bookings_service_snapshot_name check (length(trim(service_name_snapshot)) > 0)
);
create index wellweb_bookings_hotel_status_start_idx
  on public.wellweb_bookings (hotel_id, status, starts_at desc);
create index wellweb_bookings_professional_status_start_idx
  on public.wellweb_bookings (professional_profile_id, status, starts_at);
create index wellweb_bookings_confirmed_range_idx
  on public.wellweb_bookings (professional_profile_id, starts_at, ends_at) where status = 'CONFIRMED';
create trigger wellweb_bookings_set_updated_at
before update on public.wellweb_bookings
for each row execute function public.set_updated_at();

create table public.wellweb_booking_history (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.wellweb_bookings(id) on delete cascade,
  from_status public.wellweb_booking_status,
  to_status public.wellweb_booking_status not null,
  actor_user_id uuid not null references public.app_users(id),
  reason text check (reason is null or length(reason) <= 1000),
  created_at timestamptz not null default now()
);
create index wellweb_booking_history_booking_created_idx
  on public.wellweb_booking_history (booking_id, created_at);

create table public.wellweb_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.app_users(id) on delete cascade,
  booking_id uuid not null references public.wellweb_bookings(id) on delete cascade,
  event_type text not null check (event_type in
    ('BOOKING_REQUESTED', 'BOOKING_CONFIRMED', 'BOOKING_REJECTED', 'BOOKING_CANCELLED', 'BOOKING_COMPLETED')),
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint wellweb_notifications_title_length check (length(title) <= 160),
  constraint wellweb_notifications_body_length check (length(body) <= 500)
);
create index wellweb_notifications_recipient_unread_idx
  on public.wellweb_notifications (recipient_user_id, created_at desc) where read_at is null;

alter table public.professional_weekly_availability enable row level security;
alter table public.professional_availability_overrides enable row level security;
alter table public.wellweb_bookings enable row level security;
alter table public.wellweb_booking_history enable row level security;
alter table public.wellweb_notifications enable row level security;

create policy "professional_read_own_weekly_availability"
on public.professional_weekly_availability for select to authenticated
using (exists (
  select 1 from public.professional_profiles p join public.app_users u on u.id = p.user_id
  where p.id = professional_profile_id and u.auth_user_id = (select auth.uid())
    and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE'
));
create policy "professional_read_own_availability_overrides"
on public.professional_availability_overrides for select to authenticated
using (exists (
  select 1 from public.professional_profiles p join public.app_users u on u.id = p.user_id
  where p.id = professional_profile_id and u.auth_user_id = (select auth.uid())
    and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE'
));
create policy "admin_read_all_weekly_availability"
on public.professional_weekly_availability for select to authenticated using ((select public.is_wellweb_admin()));
create policy "admin_read_all_availability_overrides"
on public.professional_availability_overrides for select to authenticated using ((select public.is_wellweb_admin()));

create policy "booking_participants_and_admin_read_bookings"
on public.wellweb_bookings for select to authenticated
using (
  (select public.is_wellweb_admin())
  or exists (
    select 1 from public.hotel_members hm join public.app_users u on u.id = hm.user_id
    where hm.hotel_id = wellweb_bookings.hotel_id and hm.status = 'ACTIVE'
      and u.auth_user_id = (select auth.uid()) and u.account_type = 'HOTEL' and u.status = 'ACTIVE'
  )
  or exists (
    select 1 from public.professional_profiles p join public.app_users u on u.id = p.user_id
    where p.id = wellweb_bookings.professional_profile_id and u.auth_user_id = (select auth.uid())
      and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE'
  )
);
create policy "booking_participants_and_admin_read_history"
on public.wellweb_booking_history for select to authenticated
using (exists (
  select 1 from public.wellweb_bookings b
  where b.id = booking_id and (
    (select public.is_wellweb_admin())
    or exists (select 1 from public.hotel_members hm join public.app_users u on u.id=hm.user_id
      where hm.hotel_id=b.hotel_id and hm.status='ACTIVE' and u.auth_user_id=(select auth.uid()) and u.account_type='HOTEL' and u.status='ACTIVE')
    or exists (select 1 from public.professional_profiles p join public.app_users u on u.id=p.user_id
      where p.id=b.professional_profile_id and u.auth_user_id=(select auth.uid()) and u.account_type='PROFESSIONAL' and u.status='ACTIVE')
  )
));
create policy "recipients_read_own_notifications"
on public.wellweb_notifications for select to authenticated
using (exists (select 1 from public.app_users u where u.id=recipient_user_id and u.auth_user_id=(select auth.uid()) and u.status='ACTIVE'));

grant select on public.professional_weekly_availability, public.professional_availability_overrides,
  public.wellweb_bookings, public.wellweb_booking_history, public.wellweb_notifications to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.professional_weekly_availability,
  public.professional_availability_overrides, public.wellweb_bookings, public.wellweb_booking_history,
  public.wellweb_notifications from anon, authenticated;

-- A hotel can see the booking details of a listed professional's active services,
-- but cannot mutate them; writes go through save_wellweb_professional_service.
create policy "approved_hotels_read_published_services"
on public.professional_services for select to authenticated
using (exists (
  select 1 from public.professional_profiles p
  join public.app_users pro_user on pro_user.id=p.user_id
  where p.id=professional_profile_id and p.approval_status='APPROVED' and p.is_public
    and pro_user.account_type='PROFESSIONAL' and pro_user.status='ACTIVE'
    and exists (
      select 1 from public.app_users hotel_user
      join public.hotel_members hm on hm.user_id=hotel_user.id and hm.status='ACTIVE'
      join public.hotels h on h.id=hm.hotel_id and h.approval_status='APPROVED' and h.status='ACTIVE'
      where hotel_user.auth_user_id=(select auth.uid()) and hotel_user.account_type='HOTEL' and hotel_user.status='ACTIVE'
    )
));

create or replace function public.wellweb_actor()
returns public.app_users
language plpgsql stable security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype;
begin
  select * into v_actor from public.app_users
  where auth_user_id=(select auth.uid()) and status='ACTIVE';
  if not found then raise exception 'An active WellWeb account is required'; end if;
  return v_actor;
end;
$$;
revoke all on function public.wellweb_actor() from public, anon, authenticated;

create or replace function public.wellweb_booking_interval_is_available(
  p_profile_id uuid, p_starts_at timestamptz, p_ends_at timestamptz
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  with local_time as (
    select p_starts_at at time zone 'Europe/Lisbon' as local_start,
           p_ends_at at time zone 'Europe/Lisbon' as local_end
  ), covered as (
    select (exists (
      select 1 from public.professional_weekly_availability a cross join local_time t
      where a.professional_profile_id=p_profile_id
        and a.day_of_week=extract(dow from t.local_start)::smallint
        and t.local_start::date=t.local_end::date
        and a.start_time <= t.local_start::time and a.end_time >= t.local_end::time
    ) or exists (
      select 1 from public.professional_availability_overrides o
      where o.professional_profile_id=p_profile_id and o.override_type='AVAILABLE'
        and o.starts_at <= p_starts_at and o.ends_at >= p_ends_at
    )) as is_covered
  )
  select (select is_covered from covered)
    and not exists (
      select 1 from public.professional_availability_overrides o
      where o.professional_profile_id=p_profile_id and o.override_type='BLOCKED'
        and tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')
    );
$$;
revoke all on function public.wellweb_booking_interval_is_available(uuid,timestamptz,timestamptz) from public, anon, authenticated;

create or replace function public.save_wellweb_professional_service(
  p_service_id uuid, p_name text, p_description text, p_modality_slug text,
  p_duration_minutes integer, p_price numeric, p_active boolean
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid; v_id uuid;
begin
  v_actor := public.wellweb_actor();
  if v_actor.account_type <> 'PROFESSIONAL' then raise exception 'Only professionals can manage services'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  if v_profile_id is null then raise exception 'Professional profile not found'; end if;
  if nullif(trim(p_name),'') is null or length(trim(p_name))>120 then raise exception 'Service name is required'; end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 1440 then raise exception 'Invalid service duration'; end if;
  if p_price is not null and p_price < 0 then raise exception 'Invalid service price'; end if;
  if p_modality_slug is not null and not exists(select 1 from public.modality_catalog where slug=p_modality_slug and active) then
    raise exception 'Selected modality is unavailable';
  end if;
  if p_service_id is null then
    insert into public.professional_services(professional_profile_id,name,description,modality_slug,duration_minutes,price,currency,active)
    values(v_profile_id,trim(p_name),nullif(trim(p_description),''),p_modality_slug,p_duration_minutes,p_price,'EUR',coalesce(p_active,true))
    returning id into v_id;
  else
    update public.professional_services set name=trim(p_name),description=nullif(trim(p_description),''),
      modality_slug=p_modality_slug,duration_minutes=p_duration_minutes,price=p_price,currency='EUR',active=coalesce(p_active,false)
    where id=p_service_id and professional_profile_id=v_profile_id returning id into v_id;
    if v_id is null then raise exception 'Service not found for this professional'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_wellweb_professional_service(uuid,text,text,text,integer,numeric,boolean) from public, anon;
grant execute on function public.save_wellweb_professional_service(uuid,text,text,text,integer,numeric,boolean) to authenticated;

create or replace function public.save_wellweb_weekly_availability(
  p_slot_id uuid, p_day_of_week smallint, p_start_time time, p_end_time time
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid; v_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  if v_profile_id is null then raise exception 'Professional profile not found'; end if;
  if p_day_of_week not between 0 and 6 or p_end_time<=p_start_time then raise exception 'Invalid weekly interval'; end if;
  if exists(select 1 from public.professional_weekly_availability a where a.professional_profile_id=v_profile_id
    and a.day_of_week=p_day_of_week and a.id is distinct from p_slot_id
    and p_start_time<a.end_time and p_end_time>a.start_time) then raise exception 'Weekly intervals cannot overlap'; end if;
  if p_slot_id is null then
    insert into public.professional_weekly_availability(professional_profile_id,day_of_week,start_time,end_time)
    values(v_profile_id,p_day_of_week,p_start_time,p_end_time) returning id into v_id;
  else
    update public.professional_weekly_availability set day_of_week=p_day_of_week,start_time=p_start_time,end_time=p_end_time
    where id=p_slot_id and professional_profile_id=v_profile_id returning id into v_id;
    if v_id is null then raise exception 'Availability interval not found'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_wellweb_weekly_availability(uuid,smallint,time,time) from public, anon;
grant execute on function public.save_wellweb_weekly_availability(uuid,smallint,time,time) to authenticated;

create or replace function public.delete_wellweb_weekly_availability(p_slot_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  delete from public.professional_weekly_availability where id=p_slot_id and professional_profile_id=v_profile_id;
  if not found then raise exception 'Availability interval not found'; end if;
end;
$$;
revoke all on function public.delete_wellweb_weekly_availability(uuid) from public, anon;
grant execute on function public.delete_wellweb_weekly_availability(uuid) to authenticated;

create or replace function public.save_wellweb_availability_override(
  p_override_id uuid, p_starts_at timestamptz, p_ends_at timestamptz,
  p_override_type public.wellweb_availability_override_type, p_reason text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid; v_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  if v_profile_id is null then raise exception 'Professional profile not found'; end if;
  if p_ends_at<=p_starts_at or p_ends_at-p_starts_at>interval '31 days' then raise exception 'Invalid exception interval'; end if;
  if p_reason is not null and length(p_reason)>500 then raise exception 'Reason is too long'; end if;
  if exists(select 1 from public.professional_availability_overrides o where o.professional_profile_id=v_profile_id
    and o.id is distinct from p_override_id and tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then
    raise exception 'Availability exceptions cannot overlap';
  end if;
  if p_override_type='BLOCKED' and exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=v_profile_id
    and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then
    raise exception 'A confirmed reservation occupies this interval';
  end if;
  if p_override_id is null then
    insert into public.professional_availability_overrides(professional_profile_id,starts_at,ends_at,override_type,reason)
    values(v_profile_id,p_starts_at,p_ends_at,p_override_type,nullif(trim(p_reason),'')) returning id into v_id;
  else
    update public.professional_availability_overrides set starts_at=p_starts_at,ends_at=p_ends_at,
      override_type=p_override_type,reason=nullif(trim(p_reason),'')
    where id=p_override_id and professional_profile_id=v_profile_id returning id into v_id;
    if v_id is null then raise exception 'Availability exception not found'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_wellweb_availability_override(uuid,timestamptz,timestamptz,public.wellweb_availability_override_type,text) from public, anon;
grant execute on function public.save_wellweb_availability_override(uuid,timestamptz,timestamptz,public.wellweb_availability_override_type,text) to authenticated;

create or replace function public.delete_wellweb_availability_override(p_override_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  delete from public.professional_availability_overrides where id=p_override_id and professional_profile_id=v_profile_id;
  if not found then raise exception 'Availability exception not found'; end if;
end;
$$;
revoke all on function public.delete_wellweb_availability_override(uuid) from public, anon;
grant execute on function public.delete_wellweb_availability_override(uuid) to authenticated;

create or replace function public.wellweb_available_booking_slots(
  p_professional_profile_id uuid, p_service_id uuid, p_from date, p_to date
)
returns table(starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_hotel_ok boolean; v_duration integer;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'HOTEL' then raise exception 'Only hotels can inspect bookable times'; end if;
  select exists(select 1 from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id
    where hm.user_id=v_actor.id and hm.status='ACTIVE' and h.status='ACTIVE' and h.approval_status='APPROVED') into v_hotel_ok;
  if not v_hotel_ok then raise exception 'An approved hotel is required to request reservations'; end if;
  if p_from is null or p_to is null or p_to<p_from or p_to>p_from+31 then raise exception 'Date range must be within 31 days'; end if;
  select s.duration_minutes into v_duration from public.professional_services s
    join public.professional_profiles p on p.id=s.professional_profile_id
    join public.app_users u on u.id=p.user_id
    where s.id=p_service_id and s.professional_profile_id=p_professional_profile_id and s.active
      and p.approval_status='APPROVED' and p.is_public and u.status='ACTIVE' and u.account_type='PROFESSIONAL';
  if v_duration is null then raise exception 'Active approved service not found'; end if;

  return query
  with dates as (select d::date as local_date from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d),
  weekly_candidates as (
    select (series.local_start at time zone 'Europe/Lisbon') as start_utc
    from dates d join public.professional_weekly_availability a
      on a.professional_profile_id=p_professional_profile_id and a.day_of_week=extract(dow from d.local_date)::smallint
    cross join lateral generate_series(d.local_date+a.start_time,
      d.local_date+a.end_time-make_interval(mins=>v_duration),interval '30 minutes') series(local_start)
  ),
  exception_candidates as (
    select (series.local_start at time zone 'Europe/Lisbon') as start_utc
    from public.professional_availability_overrides o
    cross join lateral generate_series(o.starts_at at time zone 'Europe/Lisbon',
      (o.ends_at at time zone 'Europe/Lisbon')-make_interval(mins=>v_duration),interval '30 minutes') series(local_start)
    where o.professional_profile_id=p_professional_profile_id and o.override_type='AVAILABLE'
      and (o.starts_at at time zone 'Europe/Lisbon')::date between p_from and p_to
  ), candidates as (
    select distinct start_utc from weekly_candidates union select distinct start_utc from exception_candidates
  )
  select c.start_utc, c.start_utc+make_interval(mins=>v_duration)
  from candidates c
  where c.start_utc>now()
    and public.wellweb_booking_interval_is_available(p_professional_profile_id,c.start_utc,c.start_utc+make_interval(mins=>v_duration))
    and not exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=p_professional_profile_id
      and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(c.start_utc,c.start_utc+make_interval(mins=>v_duration),'[)'))
  order by c.start_utc;
end;
$$;
revoke all on function public.wellweb_available_booking_slots(uuid,uuid,date,date) from public, anon;
grant execute on function public.wellweb_available_booking_slots(uuid,uuid,date,date) to authenticated;

create or replace function public.request_wellweb_booking(
  p_hotel_id uuid, p_professional_profile_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_participants integer, p_guest_name text default null, p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_actor public.app_users%rowtype; v_service public.professional_services%rowtype;
  v_pro_user_id uuid; v_ends_at timestamptz; v_booking public.wellweb_bookings%rowtype;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'HOTEL' then raise exception 'Only hotel accounts can request reservations'; end if;
  if p_participants is null or p_participants not between 1 and 100 then raise exception 'Participant count must be between 1 and 100'; end if;
  if p_guest_name is not null and length(trim(p_guest_name))>200 then raise exception 'Guest name is too long'; end if;
  if p_notes is not null and length(trim(p_notes))>3000 then raise exception 'Notes are too long'; end if;
  if p_starts_at is null or p_starts_at<=now() then raise exception 'Choose a future time'; end if;
  if not exists(select 1 from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id
    where hm.user_id=v_actor.id and hm.hotel_id=p_hotel_id and hm.status='ACTIVE'
      and h.status='ACTIVE' and h.approval_status='APPROVED') then
    raise exception 'An approved hotel associated with your account is required';
  end if;
  select s.* into v_service from public.professional_services s
    join public.professional_profiles p on p.id=s.professional_profile_id
    join public.app_users u on u.id=p.user_id
    where s.id=p_service_id and s.professional_profile_id=p_professional_profile_id and s.active
      and p.approval_status='APPROVED' and p.is_public and u.status='ACTIVE' and u.account_type='PROFESSIONAL';
  if not found or v_service.duration_minutes is null then raise exception 'Active service from an approved professional is required'; end if;
  select user_id into v_pro_user_id from public.professional_profiles where id=p_professional_profile_id;
  v_ends_at:=p_starts_at+make_interval(mins=>v_service.duration_minutes);
  if not public.wellweb_booking_interval_is_available(p_professional_profile_id,p_starts_at,v_ends_at) then
    raise exception 'The requested time is outside availability or is blocked';
  end if;

  insert into public.wellweb_bookings(hotel_id,professional_profile_id,service_id,service_name_snapshot,
    service_duration_minutes_snapshot,service_price_snapshot,service_currency_snapshot,starts_at,ends_at,
    participants,guest_name,notes,status)
  values(p_hotel_id,p_professional_profile_id,v_service.id,v_service.name,v_service.duration_minutes,
    v_service.price,v_service.currency,p_starts_at,v_ends_at,p_participants,nullif(trim(p_guest_name),''),
    nullif(trim(p_notes),''),'PENDING') returning * into v_booking;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id)
  values(v_booking.id,null,'PENDING',v_actor.id);
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  values(v_pro_user_id,v_booking.id,'BOOKING_REQUESTED','Novo pedido de reserva',
    'Pedido '||v_booking.booking_reference||' aguarda a tua resposta.');
  return jsonb_build_object('id',v_booking.id,'reference',v_booking.booking_reference,
    'status',v_booking.status,'starts_at',v_booking.starts_at,'ends_at',v_booking.ends_at);
end;
$$;
revoke all on function public.request_wellweb_booking(uuid,uuid,uuid,timestamptz,integer,text,text) from public, anon;
grant execute on function public.request_wellweb_booking(uuid,uuid,uuid,timestamptz,integer,text,text) to authenticated;

create or replace function public.decide_wellweb_booking(p_booking_id uuid,p_accept boolean,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype;
  v_pro_user_id uuid; v_hotel_user_id uuid; v_next public.wellweb_booking_status;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' then raise exception 'Only the professional can accept or reject a request'; end if;
  if p_reason is not null and length(trim(p_reason))>1000 then raise exception 'Reason is too long'; end if;
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select p.user_id into v_pro_user_id from public.professional_profiles p where p.id=v_booking.professional_profile_id;
  if v_pro_user_id is distinct from v_actor.id then raise exception 'This reservation belongs to another professional'; end if;
  if v_booking.status<>'PENDING' then raise exception 'Only pending requests can be accepted or rejected'; end if;

  if p_accept then
    perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||v_booking.professional_profile_id::text));
    if not public.wellweb_booking_interval_is_available(v_booking.professional_profile_id,v_booking.starts_at,v_booking.ends_at) then
      raise exception 'The requested time is no longer available';
    end if;
    if exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=v_booking.professional_profile_id
      and b.id<>v_booking.id and b.status='CONFIRMED'
      and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(v_booking.starts_at,v_booking.ends_at,'[)')) then
      raise exception 'A confirmed reservation now occupies this time';
    end if;
    v_next:='CONFIRMED';
  else v_next:='REJECTED'; end if;

  update public.wellweb_bookings set status=v_next where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
  values(v_booking.id,v_booking.status,v_next,v_actor.id,nullif(trim(p_reason),''));
  select hm.user_id into v_hotel_user_id from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE' limit 1;
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  values(v_hotel_user_id,v_booking.id,case when p_accept then 'BOOKING_CONFIRMED' else 'BOOKING_REJECTED' end,
    case when p_accept then 'Pedido aceite' else 'Pedido rejeitado' end,
    'Pedido '||v_booking.booking_reference||case when p_accept then ' foi confirmado.' else ' foi rejeitado.' end);
end;
$$;
revoke all on function public.decide_wellweb_booking(uuid,boolean,text) from public, anon;
grant execute on function public.decide_wellweb_booking(uuid,boolean,text) to authenticated;

create or replace function public.cancel_wellweb_booking(p_booking_id uuid,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype; v_pro_user_id uuid; v_hotel_user_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type not in ('HOTEL','PROFESSIONAL') then raise exception 'Only booking participants can cancel'; end if;
  if p_reason is not null and length(trim(p_reason))>1000 then raise exception 'Reason is too long'; end if;
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select p.user_id into v_pro_user_id from public.professional_profiles p where p.id=v_booking.professional_profile_id;
  select hm.user_id into v_hotel_user_id from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE' limit 1;
  if (v_actor.account_type='HOTEL' and v_actor.id is distinct from v_hotel_user_id)
    or (v_actor.account_type='PROFESSIONAL' and v_actor.id is distinct from v_pro_user_id) then
    raise exception 'This reservation belongs to another account';
  end if;
  if v_booking.status not in ('PENDING','CONFIRMED') then raise exception 'Only pending or confirmed reservations can be cancelled'; end if;
  update public.wellweb_bookings set status='CANCELLED' where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
  values(v_booking.id,v_booking.status,'CANCELLED',v_actor.id,nullif(trim(p_reason),''));
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  values(case when v_actor.id=v_pro_user_id then v_hotel_user_id else v_pro_user_id end,
    v_booking.id,'BOOKING_CANCELLED','Reserva cancelada','Reserva '||v_booking.booking_reference||' foi cancelada.');
end;
$$;
revoke all on function public.cancel_wellweb_booking(uuid,text) from public, anon;
grant execute on function public.cancel_wellweb_booking(uuid,text) to authenticated;

create or replace function public.complete_wellweb_booking(p_booking_id uuid,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype; v_pro_user_id uuid; v_hotel_user_id uuid;
begin
  v_actor:=public.wellweb_actor();
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select p.user_id into v_pro_user_id from public.professional_profiles p where p.id=v_booking.professional_profile_id;
  if (v_actor.account_type='PROFESSIONAL' and v_actor.id is distinct from v_pro_user_id)
    or v_actor.account_type not in ('PROFESSIONAL','ADMIN') then raise exception 'Only the assigned professional or admin can complete this reservation'; end if;
  if v_booking.status<>'CONFIRMED' then raise exception 'Only confirmed reservations can be completed'; end if;
  if now()<v_booking.ends_at then raise exception 'The reservation cannot be completed before it ends'; end if;
  update public.wellweb_bookings set status='COMPLETED' where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
  values(v_booking.id,v_booking.status,'COMPLETED',v_actor.id,nullif(trim(p_reason),''));
  select hm.user_id into v_hotel_user_id from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE' limit 1;
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  values(case when v_actor.id=v_pro_user_id then v_hotel_user_id else v_pro_user_id end,
    v_booking.id,'BOOKING_COMPLETED','Experiência concluída','Reserva '||v_booking.booking_reference||' foi concluída.');
end;
$$;
revoke all on function public.complete_wellweb_booking(uuid,text) from public, anon;
grant execute on function public.complete_wellweb_booking(uuid,text) to authenticated;

create or replace function public.my_list_wellweb_bookings()
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type not in ('HOTEL','PROFESSIONAL') then raise exception 'Partner account required'; end if;
  return query select to_jsonb(x) from (
    select b.id,b.booking_reference,b.hotel_id,h.name as hotel_name,b.professional_profile_id,p.public_name as professional_name,
      b.service_id,b.service_name_snapshot,b.service_duration_minutes_snapshot,b.service_price_snapshot,b.service_currency_snapshot,
      b.starts_at,b.ends_at,b.participants,b.guest_name,b.notes,b.status::text as status,b.created_at,b.updated_at
    from public.wellweb_bookings b join public.hotels h on h.id=b.hotel_id
      join public.professional_profiles p on p.id=b.professional_profile_id
    where (v_actor.account_type='HOTEL' and exists(select 1 from public.hotel_members hm where hm.user_id=v_actor.id and hm.hotel_id=b.hotel_id and hm.status='ACTIVE'))
      or (v_actor.account_type='PROFESSIONAL' and p.user_id=v_actor.id)
    order by b.starts_at desc
  ) x;
end;
$$;
revoke all on function public.my_list_wellweb_bookings() from public, anon;
grant execute on function public.my_list_wellweb_bookings() to authenticated;

create or replace function public.my_wellweb_booking_history(p_booking_id uuid)
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor:=public.wellweb_actor();
  if not exists(select 1 from public.wellweb_bookings b where b.id=p_booking_id and (
    (v_actor.account_type='HOTEL' and exists(select 1 from public.hotel_members hm where hm.user_id=v_actor.id and hm.hotel_id=b.hotel_id and hm.status='ACTIVE'))
    or (v_actor.account_type='PROFESSIONAL' and exists(select 1 from public.professional_profiles p where p.id=b.professional_profile_id and p.user_id=v_actor.id))
    or v_actor.account_type='ADMIN')) then raise exception 'Reservation history is not available to this account'; end if;
  return query select to_jsonb(x) from (
    select e.id,e.from_status::text,e.to_status::text,e.reason,e.created_at,u.display_name as actor_name,u.account_type::text as actor_type
    from public.wellweb_booking_history e join public.app_users u on u.id=e.actor_user_id
    where e.booking_id=p_booking_id order by e.created_at
  ) x;
end;
$$;
revoke all on function public.my_wellweb_booking_history(uuid) from public, anon;
grant execute on function public.my_wellweb_booking_history(uuid) to authenticated;

create or replace function public.mark_wellweb_notification_read(p_notification_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor:=public.wellweb_actor();
  update public.wellweb_notifications set read_at=coalesce(read_at,now())
  where id=p_notification_id and recipient_user_id=v_actor.id;
  if not found then raise exception 'Notification not found'; end if;
end;
$$;
revoke all on function public.mark_wellweb_notification_read(uuid) from public, anon;
grant execute on function public.mark_wellweb_notification_read(uuid) to authenticated;

create or replace function public.admin_list_wellweb_bookings(
  p_status text default null, p_hotel_id uuid default null, p_professional_profile_id uuid default null,
  p_from date default null, p_to date default null
)
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  if p_status is not null and p_status not in ('PENDING','CONFIRMED','REJECTED','CANCELLED','COMPLETED') then raise exception 'Invalid status filter'; end if;
  return query select to_jsonb(x) from (
    select b.id,b.booking_reference,b.hotel_id,h.name as hotel_name,b.professional_profile_id,p.public_name as professional_name,
      b.service_id,b.service_name_snapshot,b.service_duration_minutes_snapshot,b.service_price_snapshot,b.service_currency_snapshot,
      b.starts_at,b.ends_at,b.participants,b.guest_name,b.notes,b.status::text as status,b.created_at,b.updated_at
    from public.wellweb_bookings b join public.hotels h on h.id=b.hotel_id
      join public.professional_profiles p on p.id=b.professional_profile_id
    where (p_status is null or b.status::text=p_status)
      and (p_hotel_id is null or b.hotel_id=p_hotel_id)
      and (p_professional_profile_id is null or b.professional_profile_id=p_professional_profile_id)
      and (p_from is null or b.starts_at >= p_from::timestamp at time zone 'Europe/Lisbon')
      and (p_to is null or b.starts_at < (p_to+1)::timestamp at time zone 'Europe/Lisbon')
    order by b.starts_at desc
  ) x;
end;
$$;
revoke all on function public.admin_list_wellweb_bookings(text,uuid,uuid,date,date) from public, anon;
grant execute on function public.admin_list_wellweb_bookings(text,uuid,uuid,date,date) to authenticated;

create or replace function public.admin_complete_wellweb_booking(p_booking_id uuid,p_reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype; v_pro_user_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'ADMIN' then raise exception 'Administrator access required'; end if;
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if v_booking.status<>'CONFIRMED' or now()<v_booking.ends_at then raise exception 'Only completed confirmed reservations can be closed'; end if;
  update public.wellweb_bookings set status='COMPLETED' where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
  values(v_booking.id,v_booking.status,'COMPLETED',v_actor.id,nullif(trim(p_reason),''));
  select user_id into v_pro_user_id from public.professional_profiles where id=v_booking.professional_profile_id;
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  values(v_pro_user_id,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','Reserva '||v_booking.booking_reference||' foi concluída pela administração.');
end;
$$;
revoke all on function public.admin_complete_wellweb_booking(uuid,text) from public, anon;
grant execute on function public.admin_complete_wellweb_booking(uuid,text) to authenticated;

drop view public.public_professional_directory;
create view public.public_professional_directory with (security_barrier = true) as
select p.id,p.user_id,p.public_name,p.city,p.service_area,p.description,
  coalesce((select array_agg(s.name order by s.name) from public.professional_services s where s.professional_profile_id=p.id and s.active),'{}'::text[]) as services,
  coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'description',s.description,'modality_slug',s.modality_slug,
    'duration_minutes',s.duration_minutes,'price',s.price,'currency',s.currency) order by s.name)
    from public.professional_services s where s.professional_profile_id=p.id and s.active),'[]'::jsonb) as service_details,
  coalesce((select array_agg(m.name order by m.name) from public.professional_modalities pm join public.modality_catalog m on m.slug=pm.modality_slug and m.active where pm.professional_profile_id=p.id),'{}'::text[]) as modalities,
  p.languages,p.primary_photo_path,p.gallery_photo_paths
from public.professional_profiles p join public.app_users u on u.id=p.user_id
where p.is_public and p.approval_status='APPROVED' and u.account_type='PROFESSIONAL' and u.status='ACTIVE';
grant select on public.public_professional_directory to anon,authenticated;

notify pgrst, 'reload schema';
commit;
