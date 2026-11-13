-- Build 5.2: immediate availability, service proposal history and booking lead time.
begin;

alter table public.professional_profiles
  add column if not exists service_review_history jsonb not null default '[]'::jsonb;

-- New professional registrations express publication intent by default. Approval remains mandatory.
alter table public.professional_profiles alter column is_public set default true;

create or replace function public.wellweb_schedule_has_booking_conflict(
  p_profile_id uuid, p_weekly jsonb, p_overrides jsonb
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.wellweb_bookings b
    where b.professional_profile_id=p_profile_id and b.status='CONFIRMED' and b.ends_at>now()
      and not (
        exists (
          select 1 from jsonb_array_elements(coalesce(p_overrides,'[]'::jsonb)) o
          where o->>'override_type'='AVAILABLE'
            and (o->>'starts_at')::timestamptz<=b.starts_at and (o->>'ends_at')::timestamptz>=b.ends_at
        ) or (
          not exists (
            select 1 from jsonb_array_elements(coalesce(p_overrides,'[]'::jsonb)) o
            where o->>'override_type'='BLOCKED'
              and tstzrange((o->>'starts_at')::timestamptz,(o->>'ends_at')::timestamptz,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')
          ) and exists (
            select 1 from jsonb_array_elements(coalesce(p_weekly,'[]'::jsonb)) w
            where (w->>'day_of_week')::int=extract(dow from timezone('Europe/Lisbon',b.starts_at))::int
              and (w->>'start_time')::time<=timezone('Europe/Lisbon',b.starts_at)::time
              and (w->>'end_time')::time>=timezone('Europe/Lisbon',b.ends_at)::time
              and timezone('Europe/Lisbon',b.starts_at)::date=timezone('Europe/Lisbon',b.ends_at)::date
          )
        )
      )
  );
$$;
revoke all on function public.wellweb_schedule_has_booking_conflict(uuid,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.save_wellweb_weekly_availability(p_slot_id uuid,p_day_of_week smallint,p_start_time time,p_end_time time)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb; sid uuid; item jsonb; weekly jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p.id::text));
  if p_day_of_week is null or p_day_of_week not between 0 and 6 or p_start_time is null or p_end_time is null or p_end_time<=p_start_time then raise exception 'Invalid weekly interval'; end if;
  if extract(minute from p_start_time)::int%15<>0 or extract(minute from p_end_time)::int%15<>0 or extract(second from p_start_time)<>0 or extract(second from p_end_time)<>0 then raise exception 'Times must use 15-minute increments'; end if;
  cfg:=public.wellweb_base_professional_configuration(p.id); weekly:=cfg->'weekly'; sid:=coalesce(p_slot_id,gen_random_uuid());
  if p_slot_id is not null and not exists(select 1 from jsonb_array_elements(weekly) e where e->>'id'=sid::text) then raise exception 'Availability interval not found'; end if;
  if exists(select 1 from jsonb_array_elements(weekly) e where e->>'id'<>sid::text and (e->>'day_of_week')::int=p_day_of_week and p_start_time<(e->>'end_time')::time and p_end_time>(e->>'start_time')::time) then raise exception 'Weekly intervals cannot overlap'; end if;
  item:=jsonb_build_object('id',sid,'day_of_week',p_day_of_week,'start_time',p_start_time,'end_time',p_end_time);
  weekly:=case when p_slot_id is null then weekly||jsonb_build_array(item) else (select coalesce(jsonb_agg(case when e->>'id'=sid::text then item else e end),'[]'::jsonb) from jsonb_array_elements(weekly) e) end;
  if public.wellweb_schedule_has_booking_conflict(p.id,weekly,cfg->'overrides') then raise exception 'This change would make a confirmed reservation unavailable'; end if;
  delete from public.professional_weekly_availability where professional_profile_id=p.id;
  insert into public.professional_weekly_availability(id,professional_profile_id,day_of_week,start_time,end_time)
  select (e->>'id')::uuid,p.id,(e->>'day_of_week')::smallint,(e->>'start_time')::time,(e->>'end_time')::time from jsonb_array_elements(weekly) e;
  if p.pending_configuration is not null then update public.professional_profiles set pending_configuration=jsonb_set(p.pending_configuration,'{weekly}',weekly,true) where id=p.id; end if;
  return sid;
end; $$;
revoke all on function public.save_wellweb_weekly_availability(uuid,smallint,time,time) from public,anon;
grant execute on function public.save_wellweb_weekly_availability(uuid,smallint,time,time) to authenticated;

create or replace function public.delete_wellweb_weekly_availability(p_slot_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb; weekly jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p.id::text));
  cfg:=public.wellweb_base_professional_configuration(p.id); weekly:=cfg->'weekly';
  if not exists(select 1 from jsonb_array_elements(weekly) e where e->>'id'=p_slot_id::text) then raise exception 'Availability interval not found'; end if;
  weekly:=(select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(weekly) e where e->>'id'<>p_slot_id::text);
  if public.wellweb_schedule_has_booking_conflict(p.id,weekly,cfg->'overrides') then raise exception 'This change would make a confirmed reservation unavailable'; end if;
  delete from public.professional_weekly_availability where id=p_slot_id and professional_profile_id=p.id;
  if p.pending_configuration is not null then update public.professional_profiles set pending_configuration=jsonb_set(p.pending_configuration,'{weekly}',weekly,true) where id=p.id; end if;
end; $$;
revoke all on function public.delete_wellweb_weekly_availability(uuid) from public,anon;
grant execute on function public.delete_wellweb_weekly_availability(uuid) to authenticated;

create or replace function public.save_wellweb_availability_override(p_override_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_override_type public.wellweb_availability_override_type,p_reason text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb; oid uuid; item jsonb; overrides jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p.id::text));
  if p_starts_at is null or p_ends_at is null or p_override_type is null or p_ends_at<=p_starts_at or p_ends_at-p_starts_at>interval '31 days' then raise exception 'Invalid exception interval'; end if;
  if p_reason is not null and length(p_reason)>500 then raise exception 'Reason is too long'; end if;
  cfg:=public.wellweb_base_professional_configuration(p.id); overrides:=cfg->'overrides'; oid:=coalesce(p_override_id,gen_random_uuid());
  if p_override_id is not null and not exists(select 1 from jsonb_array_elements(overrides) e where e->>'id'=oid::text) then raise exception 'Availability exception not found'; end if;
  if exists(select 1 from jsonb_array_elements(overrides) e where e->>'id'<>oid::text and e->>'override_type'=p_override_type::text and tstzrange((e->>'starts_at')::timestamptz,(e->>'ends_at')::timestamptz,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'Overlapping exceptions of the same type are not allowed'; end if;
  item:=jsonb_build_object('id',oid,'starts_at',p_starts_at,'ends_at',p_ends_at,'override_type',p_override_type::text,'reason',nullif(trim(p_reason),''));
  overrides:=case when p_override_id is null then overrides||jsonb_build_array(item) else (select coalesce(jsonb_agg(case when e->>'id'=oid::text then item else e end),'[]'::jsonb) from jsonb_array_elements(overrides) e) end;
  if public.wellweb_schedule_has_booking_conflict(p.id,cfg->'weekly',overrides) then raise exception 'This change would make a confirmed reservation unavailable'; end if;
  delete from public.professional_availability_overrides where professional_profile_id=p.id;
  insert into public.professional_availability_overrides(id,professional_profile_id,starts_at,ends_at,override_type,reason)
  select (e->>'id')::uuid,p.id,(e->>'starts_at')::timestamptz,(e->>'ends_at')::timestamptz,(e->>'override_type')::public.wellweb_availability_override_type,e->>'reason' from jsonb_array_elements(overrides) e;
  if p.pending_configuration is not null then update public.professional_profiles set pending_configuration=jsonb_set(p.pending_configuration,'{overrides}',overrides,true) where id=p.id; end if;
  return oid;
end; $$;
revoke all on function public.save_wellweb_availability_override(uuid,timestamptz,timestamptz,public.wellweb_availability_override_type,text) from public,anon;
grant execute on function public.save_wellweb_availability_override(uuid,timestamptz,timestamptz,public.wellweb_availability_override_type,text) to authenticated;

create or replace function public.delete_wellweb_availability_override(p_override_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb; overrides jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p.id::text));
  cfg:=public.wellweb_base_professional_configuration(p.id); overrides:=cfg->'overrides';
  if not exists(select 1 from jsonb_array_elements(overrides) e where e->>'id'=p_override_id::text) then raise exception 'Availability exception not found'; end if;
  overrides:=(select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(overrides) e where e->>'id'<>p_override_id::text);
  if public.wellweb_schedule_has_booking_conflict(p.id,cfg->'weekly',overrides) then raise exception 'This change would make a confirmed reservation unavailable'; end if;
  delete from public.professional_availability_overrides where id=p_override_id and professional_profile_id=p.id;
  if p.pending_configuration is not null then update public.professional_profiles set pending_configuration=jsonb_set(p.pending_configuration,'{overrides}',overrides,true) where id=p.id; end if;
end; $$;
revoke all on function public.delete_wellweb_availability_override(uuid) from public,anon;
grant execute on function public.delete_wellweb_availability_override(uuid) to authenticated;

create or replace function public.admin_review_professional_configuration(p_profile_id uuid,p_approve boolean,p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare reviewer uuid; p public.professional_profiles%rowtype; cfg jsonb; s jsonb; recipient text; queue_id uuid;
begin
  select id into reviewer from public.app_users where auth_user_id=(select auth.uid()) and account_type='ADMIN' and status='ACTIVE';
  if reviewer is null then raise exception 'Administrator access required'; end if;
  if not p_approve and nullif(trim(p_note),'') is null then raise exception 'A rejection reason is required'; end if;
  select * into p from public.professional_profiles where id=p_profile_id for update;
  if not found or p.pending_configuration is null or not (p.pending_configuration ? 'services') then raise exception 'No service configuration is pending review'; end if;
  cfg:=p.pending_configuration;
  if p_approve then
    for s in select value from jsonb_array_elements(coalesce(cfg->'services','[]'::jsonb)) loop
      insert into public.professional_services(id,professional_profile_id,name,description,modality_slug,duration_minutes,price,currency,active,has_material,allows_group,max_students,price_per_student)
      values((s->>'id')::uuid,p.id,s->>'name',s->>'description',s->>'modality_slug',(s->>'duration_minutes')::int,(s->>'price')::numeric,coalesce(s->>'currency','EUR'),coalesce((s->>'active')::boolean,false),coalesce((s->>'has_material')::boolean,false),coalesce((s->>'allows_group')::boolean,false),(s->>'max_students')::int,coalesce((s->>'price_per_student')::boolean,false))
      on conflict(id) do update set name=excluded.name,description=excluded.description,modality_slug=excluded.modality_slug,duration_minutes=excluded.duration_minutes,price=excluded.price,currency=excluded.currency,active=excluded.active,has_material=excluded.has_material,allows_group=excluded.allows_group,max_students=excluded.max_students,price_per_student=excluded.price_per_student where public.professional_services.professional_profile_id=p.id;
    end loop;
    update public.professional_services set active=false where professional_profile_id=p.id and not exists(select 1 from jsonb_array_elements(coalesce(cfg->'services','[]'::jsonb)) x where x->>'id'=professional_services.id::text);
  else
    select email into recipient from public.app_users where id=p.user_id;
    insert into public.partner_rejection_email_outbox(partner_id,reviewer_id,recipient_email,reason) values(p.user_id,reviewer,recipient,trim(p_note)) returning id into queue_id;
    update public.professional_profiles set service_review_history=service_review_history||jsonb_build_array(jsonb_build_object('status','REJECTED','services',cfg->'services','reason',trim(p_note),'reviewed_at',now())) where id=p.id;
  end if;
  update public.professional_profiles set pending_configuration=null where id=p.id;
  insert into public.partner_review_events(partner_id,reviewer_id,decision,note) values(p.user_id,reviewer,case when p_approve then 'APPROVED' else 'REJECTED' end,nullif(left(trim(coalesce(p_note,'')),1000),''));
  return queue_id;
end; $$;
revoke all on function public.admin_review_professional_configuration(uuid,boolean,text) from public,anon;
grant execute on function public.admin_review_professional_configuration(uuid,boolean,text) to authenticated;

create or replace function public.admin_list_pending_professional_configurations()
returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  return query select to_jsonb(x) from (
    select p.id as profile_id,u.id as partner_id,u.display_name,u.email,
      jsonb_set(jsonb_set(p.pending_configuration,'{weekly}',base.configuration->'weekly',true),'{overrides}',base.configuration->'overrides',true) as pending_configuration,
      base.configuration as current_configuration,p.updated_at
    from public.professional_profiles p join public.app_users u on u.id=p.user_id
    cross join lateral (select public.wellweb_base_professional_configuration(p.id) as configuration) base
    where p.pending_configuration is not null order by p.updated_at
  ) x;
end; $$;
revoke all on function public.admin_list_pending_professional_configurations() from public,anon;
grant execute on function public.admin_list_pending_professional_configurations() to authenticated;

-- Four hours is enforced in the RPC as well as in slot discovery.
create or replace function public.request_wellweb_booking(
  p_hotel_id uuid,p_professional_profile_id uuid,p_service_id uuid,p_starts_at timestamptz,p_participants integer,p_guest_name text default null,p_notes text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_service public.professional_services%rowtype; v_pro_user_id uuid; v_ends_at timestamptz; v_booking public.wellweb_bookings%rowtype; v_total numeric(12,2); v_students integer;
begin
  v_actor:=public.wellweb_actor(); if v_actor.account_type<>'HOTEL' then raise exception 'Only hotel accounts can request reservations'; end if;
  if p_guest_name is not null and length(trim(p_guest_name))>200 then raise exception 'Guest name is too long'; end if;
  if p_notes is not null and length(trim(p_notes))>3000 then raise exception 'Notes are too long'; end if;
  if p_starts_at is null or p_starts_at<now()+interval '4 hours' then raise exception 'Reservation requests require at least 4 hours notice'; end if;
  if not exists(select 1 from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id where hm.user_id=v_actor.id and hm.hotel_id=p_hotel_id and hm.status='ACTIVE' and h.status='ACTIVE' and h.approval_status='APPROVED') then raise exception 'An approved hotel associated with your account is required'; end if;
  select s.* into v_service from public.professional_services s join public.professional_profiles p on p.id=s.professional_profile_id join public.app_users u on u.id=p.user_id where s.id=p_service_id and s.professional_profile_id=p_professional_profile_id and s.active and s.duration_minutes between 5 and 1440 and p.approval_status='APPROVED' and p.is_public and u.status='ACTIVE' and u.account_type='PROFESSIONAL';
  if not found then raise exception 'Active service from an approved professional is required'; end if;
  if v_service.allows_group then if p_participants is null or p_participants not between 1 and v_service.max_students then raise exception 'Student count exceeds the service capacity'; end if; elsif p_participants is distinct from 1 then raise exception 'Individual services accept one participant'; end if;
  v_students:=case when v_service.allows_group then p_participants else 1 end;
  if v_service.price is null then v_total:=null; elsif v_service.allows_group and v_service.price_per_student then v_total:=round(v_service.price*v_students,2); else v_total:=v_service.price; end if;
  select user_id into v_pro_user_id from public.professional_profiles where id=p_professional_profile_id; v_ends_at:=p_starts_at+make_interval(mins=>v_service.duration_minutes);
  perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p_professional_profile_id::text));
  if not public.wellweb_booking_interval_is_available(p_professional_profile_id,p_starts_at,v_ends_at) then raise exception 'The requested time is outside availability or is blocked'; end if;
  if exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=p_professional_profile_id and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,v_ends_at,'[)')) then raise exception 'A confirmed reservation occupies this time'; end if;
  insert into public.wellweb_bookings(hotel_id,professional_profile_id,service_id,service_name_snapshot,service_duration_minutes_snapshot,service_price_snapshot,service_currency_snapshot,starts_at,ends_at,participants,guest_name,notes,status,price_type_snapshot,max_students_snapshot,students_count,total_price_snapshot)
  values(p_hotel_id,p_professional_profile_id,v_service.id,v_service.name,v_service.duration_minutes,v_service.price,v_service.currency,p_starts_at,v_ends_at,v_students,nullif(trim(p_guest_name),''),nullif(trim(p_notes),''),'PENDING',case when v_service.allows_group and v_service.price_per_student then 'PER_STUDENT' else 'SERVICE' end,case when v_service.allows_group then v_service.max_students else null end,v_students,v_total) returning * into v_booking;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id) values(v_booking.id,null,'PENDING',v_actor.id);
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body) values(v_pro_user_id,v_booking.id,'BOOKING_REQUESTED','Novo pedido de reserva','Pedido '||v_booking.booking_reference||' aguarda a tua resposta.');
  return jsonb_build_object('id',v_booking.id,'reference',v_booking.booking_reference,'status',v_booking.status,'starts_at',v_booking.starts_at,'ends_at',v_booking.ends_at,'total_price',v_total);
end; $$;
revoke all on function public.request_wellweb_booking(uuid,uuid,uuid,timestamptz,integer,text,text) from public,anon;
grant execute on function public.request_wellweb_booking(uuid,uuid,uuid,timestamptz,integer,text,text) to authenticated;

create or replace function public.wellweb_available_booking_slots(p_professional_profile_id uuid,p_service_id uuid,p_from date,p_to date)
returns table(starts_at timestamptz,ends_at timestamptz) language plpgsql stable security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_hotel_ok boolean; v_duration integer;
begin
  v_actor:=public.wellweb_actor(); if v_actor.account_type<>'HOTEL' then raise exception 'Only hotels can inspect bookable times'; end if;
  select exists(select 1 from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id where hm.user_id=v_actor.id and hm.status='ACTIVE' and h.status='ACTIVE' and h.approval_status='APPROVED') into v_hotel_ok;
  if not v_hotel_ok then raise exception 'An approved hotel is required to request reservations'; end if;
  if p_from is null or p_to is null or p_to<p_from or p_to>p_from+31 then raise exception 'Date range must be within 31 days'; end if;
  select s.duration_minutes into v_duration from public.professional_services s join public.professional_profiles p on p.id=s.professional_profile_id join public.app_users u on u.id=p.user_id
  where s.id=p_service_id and s.professional_profile_id=p_professional_profile_id and s.active and s.duration_minutes between 5 and 1440 and p.approval_status='APPROVED' and p.is_public and u.status='ACTIVE' and u.account_type='PROFESSIONAL';
  if v_duration is null then raise exception 'Active approved service not found'; end if;
  return query
  with dates as (select d::date as local_date from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') d),
  weekly_candidates as (
    select series.local_start at time zone 'Europe/Lisbon' as start_utc from dates d
    join public.professional_weekly_availability a on a.professional_profile_id=p_professional_profile_id and a.day_of_week=extract(dow from d.local_date)::smallint
    cross join lateral generate_series(d.local_date+a.start_time,d.local_date+a.end_time-make_interval(mins=>v_duration),interval '30 minutes') series(local_start)
  ), exception_candidates as (
    select series.local_start at time zone 'Europe/Lisbon' as start_utc from public.professional_availability_overrides o
    cross join lateral generate_series(o.starts_at at time zone 'Europe/Lisbon',(o.ends_at at time zone 'Europe/Lisbon')-make_interval(mins=>v_duration),interval '30 minutes') series(local_start)
    where o.professional_profile_id=p_professional_profile_id and o.override_type='AVAILABLE' and (o.starts_at at time zone 'Europe/Lisbon')::date between p_from and p_to
  ), candidates as (select distinct start_utc from weekly_candidates union select distinct start_utc from exception_candidates)
  select c.start_utc,c.start_utc+make_interval(mins=>v_duration) from candidates c
  where c.start_utc>=now()+interval '4 hours'
    and public.wellweb_booking_interval_is_available(p_professional_profile_id,c.start_utc,c.start_utc+make_interval(mins=>v_duration))
    and not exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=p_professional_profile_id and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(c.start_utc,c.start_utc+make_interval(mins=>v_duration),'[)'))
  order by c.start_utc;
end; $$;
revoke all on function public.wellweb_available_booking_slots(uuid,uuid,date,date) from public,anon;
grant execute on function public.wellweb_available_booking_slots(uuid,uuid,date,date) to authenticated;

notify pgrst,'reload schema';
commit;
