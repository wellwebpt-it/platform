-- Build 5.1: service materials, group pricing and availability precedence.
begin;

alter table public.professional_services
  add column has_material boolean not null default false,
  add column allows_group boolean not null default false,
  add column max_students integer,
  add column price_per_student boolean not null default false,
  add constraint professional_services_group_capacity check (
    (allows_group and max_students between 1 and 100)
    or (not allows_group and max_students is null)
  );

alter table public.wellweb_bookings
  add column price_type_snapshot text not null default 'SERVICE' check (price_type_snapshot in ('SERVICE','PER_STUDENT')),
  add column max_students_snapshot integer,
  add column students_count integer not null default 1 check (students_count between 1 and 100),
  add column total_price_snapshot numeric(12,2) check (total_price_snapshot is null or total_price_snapshot >= 0);
update public.wellweb_bookings
set students_count=participants,
    total_price_snapshot=service_price_snapshot,
    max_students_snapshot=null,
    price_type_snapshot='SERVICE';

create or replace function public.wellweb_booking_interval_is_available(
  p_profile_id uuid, p_starts_at timestamptz, p_ends_at timestamptz
)
returns boolean language sql stable security definer set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.professional_availability_overrides o
      where o.professional_profile_id=p_profile_id and o.override_type='AVAILABLE'
        and o.starts_at <= p_starts_at and o.ends_at >= p_ends_at
    ) then true
    when exists (
      select 1 from public.professional_availability_overrides o
      where o.professional_profile_id=p_profile_id and o.override_type='BLOCKED'
        and tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')
    ) then false
    else exists (
      select 1 from public.professional_weekly_availability a
      where a.professional_profile_id=p_profile_id
        and a.day_of_week=extract(dow from (p_starts_at at time zone 'Europe/Lisbon'))::smallint
        and (p_starts_at at time zone 'Europe/Lisbon')::date=(p_ends_at at time zone 'Europe/Lisbon')::date
        and a.start_time <= (p_starts_at at time zone 'Europe/Lisbon')::time
        and a.end_time >= (p_ends_at at time zone 'Europe/Lisbon')::time
    )
  end;
$$;
revoke all on function public.wellweb_booking_interval_is_available(uuid,timestamptz,timestamptz) from public, anon, authenticated;

create or replace function public.save_wellweb_availability_override(
  p_override_id uuid, p_starts_at timestamptz, p_ends_at timestamptz,
  p_override_type public.wellweb_availability_override_type, p_reason text
)
returns uuid language plpgsql security definer set search_path = ''
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
    and o.id is distinct from p_override_id and o.override_type=p_override_type
    and tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then
    raise exception 'Overlapping exceptions of the same type are not allowed';
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

-- Replace the service writer with a validated, backward-compatible RPC.
drop function public.save_wellweb_professional_service(uuid,text,text,text,integer,numeric,boolean);
create function public.save_wellweb_professional_service(
  p_service_id uuid, p_name text, p_description text, p_modality_slug text,
  p_duration_minutes integer, p_price numeric, p_active boolean,
  p_has_material boolean default false, p_allows_group boolean default false,
  p_max_students integer default null, p_price_per_student boolean default false
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid; v_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage services'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  if v_profile_id is null then raise exception 'Professional profile not found'; end if;
  if nullif(trim(p_name),'') is null or length(trim(p_name))>120 then raise exception 'Service name is required'; end if;
  if p_duration_minutes is null or p_duration_minutes not between 5 and 1440 then raise exception 'Invalid service duration'; end if;
  if p_price is not null and p_price < 0 then raise exception 'Invalid service price'; end if;
  if p_modality_slug is not null and not exists(select 1 from public.modality_catalog where slug=p_modality_slug and active) then raise exception 'Selected modality is unavailable'; end if;
  if p_allows_group and (p_max_students is null or p_max_students not between 1 and 100) then raise exception 'Group services require a capacity from 1 to 100'; end if;
  if not p_allows_group and p_max_students is not null then raise exception 'Individual service cannot have group capacity'; end if;
  if p_price_per_student and not p_allows_group then raise exception 'Per-student pricing requires a group service'; end if;
  if p_service_id is null then
    insert into public.professional_services(professional_profile_id,name,description,modality_slug,duration_minutes,price,currency,active,has_material,allows_group,max_students,price_per_student)
    values(v_profile_id,trim(p_name),nullif(trim(p_description),''),p_modality_slug,p_duration_minutes,p_price,'EUR',coalesce(p_active,true),coalesce(p_has_material,false),coalesce(p_allows_group,false),p_max_students,coalesce(p_price_per_student,false)) returning id into v_id;
  else
    update public.professional_services set name=trim(p_name),description=nullif(trim(p_description),''),modality_slug=p_modality_slug,
      duration_minutes=p_duration_minutes,price=p_price,currency='EUR',active=coalesce(p_active,false),has_material=coalesce(p_has_material,false),
      allows_group=coalesce(p_allows_group,false),max_students=p_max_students,price_per_student=coalesce(p_price_per_student,false)
    where id=p_service_id and professional_profile_id=v_profile_id returning id into v_id;
    if v_id is null then raise exception 'Service not found for this professional'; end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.save_wellweb_professional_service(uuid,text,text,text,integer,numeric,boolean,boolean,boolean,integer,boolean) from public, anon;
grant execute on function public.save_wellweb_professional_service(uuid,text,text,text,integer,numeric,boolean,boolean,boolean,integer,boolean) to authenticated;

-- Commercial details captured at request time cannot drift after later service edits.
create or replace function public.keep_wellweb_booking_snapshot_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  if row(new.service_name_snapshot,new.service_duration_minutes_snapshot,new.service_price_snapshot,
         new.service_currency_snapshot,new.price_type_snapshot,new.max_students_snapshot,new.students_count,
         new.total_price_snapshot,new.participants)
     is distinct from
     row(old.service_name_snapshot,old.service_duration_minutes_snapshot,old.service_price_snapshot,
         old.service_currency_snapshot,old.price_type_snapshot,old.max_students_snapshot,old.students_count,
         old.total_price_snapshot,old.participants) then
    raise exception 'Booking commercial snapshots are immutable';
  end if;
  return new;
end;
$$;
revoke all on function public.keep_wellweb_booking_snapshot_immutable() from public,anon,authenticated;
create trigger wellweb_booking_snapshot_immutable
before update on public.wellweb_bookings for each row execute function public.keep_wellweb_booking_snapshot_immutable();

-- Keep a public allowlist of service fields; private management data is not exposed.
drop view public.public_professional_directory;
create view public.public_professional_directory with (security_barrier = true) as
select p.id,p.public_name,p.city,p.service_area,p.description,
  coalesce((select array_agg(s.name order by s.name) from public.professional_services s where s.professional_profile_id=p.id and s.active),'{}'::text[]) as services,
  coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'description',s.description,'modality_slug',s.modality_slug,
    'duration_minutes',s.duration_minutes,'price',s.price,'currency',s.currency,'has_material',s.has_material,
    'allows_group',s.allows_group,'max_students',s.max_students,'price_per_student',s.price_per_student) order by s.name)
    from public.professional_services s where s.professional_profile_id=p.id and s.active),'[]'::jsonb) as service_details,
  coalesce((select array_agg(m.name order by m.name) from public.professional_modalities pm join public.modality_catalog m on m.slug=pm.modality_slug and m.active where pm.professional_profile_id=p.id),'{}'::text[]) as modalities,
  p.languages,p.primary_photo_path,p.gallery_photo_paths
from public.professional_profiles p join public.app_users u on u.id=p.user_id
where p.is_public and p.approval_status='APPROVED' and u.account_type='PROFESSIONAL' and u.status='ACTIVE';
grant select on public.public_professional_directory to anon,authenticated;

-- Persist immutable commercial snapshots while preserving existing individual services.
create or replace function public.request_wellweb_booking(
  p_hotel_id uuid, p_professional_profile_id uuid, p_service_id uuid,
  p_starts_at timestamptz, p_participants integer, p_guest_name text default null, p_notes text default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_actor public.app_users%rowtype; v_service public.professional_services%rowtype;
  v_pro_user_id uuid; v_ends_at timestamptz; v_booking public.wellweb_bookings%rowtype; v_total numeric(12,2);
  v_students integer;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'HOTEL' then raise exception 'Only hotel accounts can request reservations'; end if;
  if p_guest_name is not null and length(trim(p_guest_name))>200 then raise exception 'Guest name is too long'; end if;
  if p_notes is not null and length(trim(p_notes))>3000 then raise exception 'Notes are too long'; end if;
  if p_starts_at is null or p_starts_at<=now() then raise exception 'Choose a future time'; end if;
  if not exists(select 1 from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id where hm.user_id=v_actor.id and hm.hotel_id=p_hotel_id and hm.status='ACTIVE' and h.status='ACTIVE' and h.approval_status='APPROVED') then raise exception 'An approved hotel associated with your account is required'; end if;
  select s.* into v_service from public.professional_services s join public.professional_profiles p on p.id=s.professional_profile_id join public.app_users u on u.id=p.user_id
  where s.id=p_service_id and s.professional_profile_id=p_professional_profile_id and s.active and p.approval_status='APPROVED' and p.is_public and u.status='ACTIVE' and u.account_type='PROFESSIONAL';
  if not found or v_service.duration_minutes is null then raise exception 'Active service from an approved professional is required'; end if;
  if v_service.allows_group then
    if p_participants is null or p_participants not between 1 and v_service.max_students then raise exception 'Student count exceeds the service capacity'; end if;
  elsif p_participants is distinct from 1 then raise exception 'Individual services accept one participant'; end if;
  v_students:=case when v_service.allows_group then p_participants else 1 end;
  if v_service.price is null then v_total:=null;
  elsif v_service.allows_group and v_service.price_per_student then v_total:=round(v_service.price*v_students,2);
  else v_total:=v_service.price; end if;
  select user_id into v_pro_user_id from public.professional_profiles where id=p_professional_profile_id;
  v_ends_at:=p_starts_at+make_interval(mins=>v_service.duration_minutes);
  perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p_professional_profile_id::text));
  if not public.wellweb_booking_interval_is_available(p_professional_profile_id,p_starts_at,v_ends_at) then raise exception 'The requested time is outside availability or is blocked'; end if;
  if exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=p_professional_profile_id and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,v_ends_at,'[)')) then raise exception 'A confirmed reservation occupies this time'; end if;
  insert into public.wellweb_bookings(hotel_id,professional_profile_id,service_id,service_name_snapshot,service_duration_minutes_snapshot,
    service_price_snapshot,service_currency_snapshot,starts_at,ends_at,participants,guest_name,notes,status,price_type_snapshot,
    max_students_snapshot,students_count,total_price_snapshot)
  values(p_hotel_id,p_professional_profile_id,v_service.id,v_service.name,v_service.duration_minutes,v_service.price,v_service.currency,
    p_starts_at,v_ends_at,v_students,nullif(trim(p_guest_name),''),nullif(trim(p_notes),''),'PENDING',
    case when v_service.allows_group and v_service.price_per_student then 'PER_STUDENT' else 'SERVICE' end,
    case when v_service.allows_group then v_service.max_students else null end,v_students,v_total) returning * into v_booking;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id) values(v_booking.id,null,'PENDING',v_actor.id);
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body) values(v_pro_user_id,v_booking.id,'BOOKING_REQUESTED','Novo pedido de reserva','Pedido '||v_booking.booking_reference||' aguarda a tua resposta.');
  return jsonb_build_object('id',v_booking.id,'reference',v_booking.booking_reference,'status',v_booking.status,'starts_at',v_booking.starts_at,'ends_at',v_booking.ends_at,'total_price',v_total);
end;
$$;
revoke all on function public.request_wellweb_booking(uuid,uuid,uuid,timestamptz,integer,text,text) from public, anon;
grant execute on function public.request_wellweb_booking(uuid,uuid,uuid,timestamptz,integer,text,text) to authenticated;

notify pgrst, 'reload schema';
commit;
