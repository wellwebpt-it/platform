-- Close the request/accept race and notify/authorize every active hotel member.
-- Forward-only patch; 202611060001 has already been applied locally.

begin;

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

  -- Requests and accepts share this lock. If an accept commits first, a stale
  -- client cannot create a new request over that confirmed period. Requests
  -- that arrive first may still overlap other pending requests, by design.
  perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p_professional_profile_id::text));
  if not public.wellweb_booking_interval_is_available(p_professional_profile_id,p_starts_at,v_ends_at) then
    raise exception 'The requested time is outside availability or is blocked';
  end if;
  if exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=p_professional_profile_id
    and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,v_ends_at,'[)')) then
    raise exception 'A confirmed reservation occupies this time';
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

create or replace function public.decide_wellweb_booking(p_booking_id uuid,p_accept boolean,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype;
  v_pro_user_id uuid; v_next public.wellweb_booking_status;
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
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  select hm.user_id,v_booking.id,case when p_accept then 'BOOKING_CONFIRMED' else 'BOOKING_REJECTED' end,
    case when p_accept then 'Pedido aceite' else 'Pedido rejeitado' end,
    'Pedido '||v_booking.booking_reference||case when p_accept then ' foi confirmado.' else ' foi rejeitado.' end
  from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
end;
$$;

create or replace function public.cancel_wellweb_booking(p_booking_id uuid,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype; v_pro_user_id uuid;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type not in ('HOTEL','PROFESSIONAL') then raise exception 'Only booking participants can cancel'; end if;
  if p_reason is not null and length(trim(p_reason))>1000 then raise exception 'Reason is too long'; end if;
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select p.user_id into v_pro_user_id from public.professional_profiles p where p.id=v_booking.professional_profile_id;
  if v_actor.account_type='HOTEL' and not exists(select 1 from public.hotel_members hm
    where hm.hotel_id=v_booking.hotel_id and hm.user_id=v_actor.id and hm.status='ACTIVE') then
    raise exception 'This reservation belongs to another hotel';
  end if;
  if v_actor.account_type='PROFESSIONAL' and v_actor.id is distinct from v_pro_user_id then
    raise exception 'This reservation belongs to another professional';
  end if;
  if v_booking.status not in ('PENDING','CONFIRMED') then raise exception 'Only pending or confirmed reservations can be cancelled'; end if;
  update public.wellweb_bookings set status='CANCELLED' where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
  values(v_booking.id,v_booking.status,'CANCELLED',v_actor.id,nullif(trim(p_reason),''));
  if v_actor.id=v_pro_user_id then
    insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
    select hm.user_id,v_booking.id,'BOOKING_CANCELLED','Reserva cancelada','Reserva '||v_booking.booking_reference||' foi cancelada.'
    from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
  else
    insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
    values(v_pro_user_id,v_booking.id,'BOOKING_CANCELLED','Reserva cancelada','Reserva '||v_booking.booking_reference||' foi cancelada.');
  end if;
end;
$$;

create or replace function public.complete_wellweb_booking(p_booking_id uuid,p_reason text default null)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype; v_pro_user_id uuid;
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
  if v_actor.account_type='ADMIN' then
    insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
    values(v_pro_user_id,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','Reserva '||v_booking.booking_reference||' foi concluída pela administração.');
  end if;
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  select hm.user_id,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','Reserva '||v_booking.booking_reference||' foi concluída.'
  from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
end;
$$;

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
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  select hm.user_id,v_booking.id,'BOOKING_COMPLETED','Experiência concluída','Reserva '||v_booking.booking_reference||' foi concluída pela administração.'
  from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
end;
$$;

notify pgrst, 'reload schema';
commit;
