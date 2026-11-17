-- Build 5.1: cancellation windows, hotel completion and scheduled completion.
begin;

alter table public.wellweb_bookings
  add column completion_method text check (completion_method in ('MANUAL_HOTEL','MANUAL_PROFESSIONAL','AUTOMATIC','ADMIN')),
  add column completed_by uuid references public.app_users(id),
  add column completed_at timestamptz;

alter table public.wellweb_booking_history alter column actor_user_id drop not null;

create or replace function public.cancel_wellweb_booking(p_booking_id uuid,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype; v_pro_user_id uuid; v_hotel_member boolean;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type not in ('HOTEL','PROFESSIONAL') then raise exception 'Only booking participants can cancel'; end if;
  if p_reason is null or nullif(trim(p_reason),'') is null then raise exception 'A cancellation reason is required'; end if;
  if length(trim(p_reason))>1000 then raise exception 'Reason is too long'; end if;
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select p.user_id into v_pro_user_id from public.professional_profiles p where p.id=v_booking.professional_profile_id;
  select exists(select 1 from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.user_id=v_actor.id and hm.status='ACTIVE') into v_hotel_member;
  if v_actor.account_type='HOTEL' and not v_hotel_member then raise exception 'This reservation belongs to another hotel'; end if;
  if v_actor.account_type='PROFESSIONAL' and v_actor.id is distinct from v_pro_user_id then raise exception 'This reservation belongs to another professional'; end if;

  if v_actor.account_type='PROFESSIONAL' then
    if v_booking.status<>'CONFIRMED' then raise exception 'Professionals can cancel confirmed reservations only'; end if;
    if now()>v_booking.starts_at-interval '24 hours' then raise exception 'Professional cancellation requires at least 24 hours notice'; end if;
  else
    if v_booking.status not in ('PENDING','CONFIRMED') then raise exception 'Only pending or confirmed reservations can be cancelled'; end if;
    if now()>v_booking.starts_at-interval '12 hours' then raise exception 'Hotel cancellation requires at least 12 hours notice'; end if;
  end if;

  update public.wellweb_bookings set status='CANCELLED' where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
    values(v_booking.id,v_booking.status,'CANCELLED',v_actor.id,trim(p_reason));
  if v_actor.account_type='PROFESSIONAL' then
    insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
    select hm.user_id,v_booking.id,'BOOKING_CANCELLED','Reserva cancelada','Reserva '||v_booking.booking_reference||' foi cancelada pelo profissional. Motivo: '||left(trim(p_reason),300)
    from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
  else
    insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
    values(v_pro_user_id,v_booking.id,'BOOKING_CANCELLED','Reserva cancelada','Reserva '||v_booking.booking_reference||' foi cancelada pelo alojamento. Motivo: '||left(trim(p_reason),300));
  end if;
end;
$$;
revoke all on function public.cancel_wellweb_booking(uuid,text) from public, anon;
grant execute on function public.cancel_wellweb_booking(uuid,text) to authenticated;

create or replace function public.complete_wellweb_booking(p_booking_id uuid,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype; v_pro_user_id uuid; v_is_hotel_member boolean;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type not in ('HOTEL','PROFESSIONAL') then raise exception 'Only booking participants can complete this reservation'; end if;
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select exists(select 1 from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.user_id=v_actor.id and hm.status='ACTIVE') into v_is_hotel_member;
  select user_id into v_pro_user_id from public.professional_profiles where id=v_booking.professional_profile_id;
  if v_actor.account_type='HOTEL' and not v_is_hotel_member then raise exception 'This reservation belongs to another hotel'; end if;
  if v_actor.account_type='PROFESSIONAL' and v_actor.id is distinct from v_pro_user_id then raise exception 'This reservation belongs to another professional'; end if;
  if v_booking.status<>'CONFIRMED' then raise exception 'Only confirmed reservations can be completed'; end if;
  if now()<v_booking.ends_at then raise exception 'The reservation cannot be completed before it ends'; end if;
  update public.wellweb_bookings set status='COMPLETED',completion_method=case when v_actor.account_type='HOTEL' then 'MANUAL_HOTEL' else 'MANUAL_PROFESSIONAL' end,completed_by=v_actor.id,completed_at=now() where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
  values(v_booking.id,v_booking.status,'COMPLETED',v_actor.id,case when v_actor.account_type='HOTEL' then 'Concluída manualmente pelo hotel.' else 'Concluída manualmente pelo profissional.' end);
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  values(v_pro_user_id,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','A reserva '||v_booking.booking_reference||' foi concluída manualmente.');
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  select hm.user_id,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','A reserva '||v_booking.booking_reference||' foi concluída manualmente.'
  from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE' and hm.user_id<>v_actor.id;
end;
$$;
revoke all on function public.complete_wellweb_booking(uuid,text) from public, anon;
grant execute on function public.complete_wellweb_booking(uuid,text) to authenticated;

create or replace function public.complete_due_wellweb_bookings()
returns integer language plpgsql security definer set search_path = ''
as $$
declare v_booking public.wellweb_bookings%rowtype; v_professional_user uuid; v_count integer:=0;
begin
  for v_booking in
    select * from public.wellweb_bookings
    where status='CONFIRMED' and ends_at<=now()-interval '1 hour'
    order by ends_at for update skip locked
  loop
    select user_id into v_professional_user from public.professional_profiles where id=v_booking.professional_profile_id;
    update public.wellweb_bookings set status='COMPLETED',completion_method='AUTOMATIC',completed_by=null,completed_at=now()
    where id=v_booking.id and status='CONFIRMED';
    if found then
      insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
      values(v_booking.id,'CONFIRMED','COMPLETED',null,'Concluída automaticamente pelo sistema após uma hora.');
      insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
      values(v_professional_user,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','A reserva '||v_booking.booking_reference||' foi concluída automaticamente.');
      insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
      select hm.user_id,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','A reserva '||v_booking.booking_reference||' foi concluída automaticamente.'
      from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.complete_due_wellweb_bookings() from public, anon, authenticated;

-- Supabase's supported pg_cron extension runs without a browser session.
create extension if not exists pg_cron;
do $$
declare prior_job bigint;
begin
  select jobid into prior_job from cron.job where jobname='wellweb-complete-bookings' limit 1;
  if prior_job is not null then perform cron.unschedule(prior_job); end if;
  perform cron.schedule('wellweb-complete-bookings','* * * * *','select public.complete_due_wellweb_bookings();');
end $$;

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
      b.price_type_snapshot,b.max_students_snapshot,b.students_count,b.total_price_snapshot,b.completion_method,b.completed_by,b.completed_at,
      b.starts_at,b.ends_at,b.participants,b.guest_name,b.notes,b.status::text as status,b.created_at,b.updated_at
    from public.wellweb_bookings b join public.hotels h on h.id=b.hotel_id join public.professional_profiles p on p.id=b.professional_profile_id
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
    select e.id,e.from_status::text,e.to_status::text,e.reason,e.created_at,
      coalesce(u.display_name,'WellWeb') as actor_name,coalesce(u.account_type::text,'SYSTEM') as actor_type
    from public.wellweb_booking_history e left join public.app_users u on u.id=e.actor_user_id
    where e.booking_id=p_booking_id order by e.created_at
  ) x;
end;
$$;
revoke all on function public.my_wellweb_booking_history(uuid) from public, anon;
grant execute on function public.my_wellweb_booking_history(uuid) to authenticated;

create or replace function public.admin_list_wellweb_bookings(
  p_status text default null,p_hotel_id uuid default null,p_professional_profile_id uuid default null,p_from date default null,p_to date default null
)
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  if p_status is not null and p_status not in ('PENDING','CONFIRMED','REJECTED','CANCELLED','COMPLETED') then raise exception 'Invalid status filter'; end if;
  return query select to_jsonb(x) from (
    select b.id,b.booking_reference,b.hotel_id,h.name as hotel_name,b.professional_profile_id,p.public_name as professional_name,
      b.service_id,b.service_name_snapshot,b.service_duration_minutes_snapshot,b.service_price_snapshot,b.service_currency_snapshot,
      b.price_type_snapshot,b.max_students_snapshot,b.students_count,b.total_price_snapshot,b.completion_method,b.completed_by,b.completed_at,
      b.starts_at,b.ends_at,b.participants,b.guest_name,b.notes,b.status::text as status,b.created_at,b.updated_at
    from public.wellweb_bookings b join public.hotels h on h.id=b.hotel_id join public.professional_profiles p on p.id=b.professional_profile_id
    where (p_status is null or b.status::text=p_status) and (p_hotel_id is null or b.hotel_id=p_hotel_id)
      and (p_professional_profile_id is null or b.professional_profile_id=p_professional_profile_id)
      and (p_from is null or b.starts_at>=p_from::timestamp at time zone 'Europe/Lisbon')
      and (p_to is null or b.starts_at<(p_to+1)::timestamp at time zone 'Europe/Lisbon')
    order by b.starts_at desc
  ) x;
end;
$$;
revoke all on function public.admin_list_wellweb_bookings(text,uuid,uuid,date,date) from public,anon;
grant execute on function public.admin_list_wellweb_bookings(text,uuid,uuid,date,date) to authenticated;

create or replace function public.admin_complete_wellweb_booking(p_booking_id uuid,p_reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor public.app_users%rowtype; booking public.wellweb_bookings%rowtype; professional_user uuid;
begin
  actor:=public.wellweb_actor(); if actor.account_type<>'ADMIN' then raise exception 'Administrator access required'; end if;
  select * into booking from public.wellweb_bookings where id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  if booking.status<>'CONFIRMED' or now()<booking.ends_at then raise exception 'Only completed confirmed reservations can be closed'; end if;
  select user_id into professional_user from public.professional_profiles where id=booking.professional_profile_id;
  update public.wellweb_bookings set status='COMPLETED',completion_method='ADMIN',completed_by=actor.id,completed_at=now() where id=booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
  values(booking.id,'CONFIRMED','COMPLETED',actor.id,coalesce(nullif(trim(p_reason),''),'Conclusão registada pela administração.'));
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  values(professional_user,booking.id,'BOOKING_COMPLETED','Experiência concluída','A reserva '||booking.booking_reference||' foi concluída pela administração.');
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  select hm.user_id,booking.id,'BOOKING_COMPLETED','Experiência concluída','A reserva '||booking.booking_reference||' foi concluída pela administração.'
  from public.hotel_members hm where hm.hotel_id=booking.hotel_id and hm.status='ACTIVE';
end;
$$;
revoke all on function public.admin_complete_wellweb_booking(uuid,text) from public,anon;
grant execute on function public.admin_complete_wellweb_booking(uuid,text) to authenticated;

notify pgrst, 'reload schema';
commit;
