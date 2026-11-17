-- Build 6: response SLA, autonomous expiry, private notification outbox,
-- and versioned professional WhatsApp consent. Historical bookings keep NULL
-- response_deadline_at and are not expired retroactively.
begin;

alter table public.wellweb_bookings
  add column response_deadline_at timestamptz,
  add column resolution_code text;
alter table public.wellweb_bookings
  add constraint wellweb_bookings_resolution_code_check
    check (resolution_code is null or resolution_code in (
      'PROFESSIONAL_REJECTED','PROFESSIONAL_RESPONSE_TIMEOUT',
      'HOTEL_CANCELLED','PROFESSIONAL_CANCELLED'
    ));
create index wellweb_bookings_pending_deadline_idx
  on public.wellweb_bookings(response_deadline_at,id)
  where status='PENDING' and response_deadline_at is not null;

create or replace function public.assign_wellweb_booking_response_deadline()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='INSERT' and new.status='PENDING' and new.response_deadline_at is null then
    new.response_deadline_at:=clock_timestamp()+interval '4 hours';
  end if;
  return new;
end;
$$;
revoke all on function public.assign_wellweb_booking_response_deadline() from public,anon,authenticated;
create trigger wellweb_bookings_assign_response_deadline
before insert on public.wellweb_bookings
for each row execute function public.assign_wellweb_booking_response_deadline();

create schema if not exists wellweb_private;
revoke all on schema wellweb_private from public,anon,authenticated;

create table wellweb_private.professional_notification_preferences (
  professional_profile_id uuid primary key references public.professional_profiles(id) on delete cascade,
  whatsapp_enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
insert into wellweb_private.professional_notification_preferences(professional_profile_id)
select p.id from public.professional_profiles p
on conflict(professional_profile_id) do nothing;

create table wellweb_private.professional_whatsapp_consent_events (
  id bigint generated always as identity primary key,
  professional_profile_id uuid not null references public.professional_profiles(id) on delete cascade,
  phone_e164 text not null check(phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  event_type text not null check(event_type in ('GRANTED','REVOKED','PHONE_CHANGED')),
  source text not null check(source in ('REGISTRATION','PROFILE_SETTINGS','PHONE_CHANGE')),
  text_version text,
  actor_user_id uuid references public.app_users(id) on delete set null,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint whatsapp_consent_event_version_check
    check(event_type='PHONE_CHANGED' or nullif(text_version,'') is not null)
);
create index professional_whatsapp_consent_latest_idx
  on wellweb_private.professional_whatsapp_consent_events(professional_profile_id,phone_e164,id desc);

create table wellweb_private.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.wellweb_notifications(id) on delete cascade,
  recipient_user_id uuid not null references public.app_users(id) on delete cascade,
  channel text not null check(channel in ('EMAIL','WHATSAPP')),
  status text not null default 'PENDING' check(status in ('PENDING','PROCESSING','SENT','DELIVERED','READ','FAILED','SKIPPED')),
  attempts integer not null default 0 check(attempts>=0),
  next_attempt_at timestamptz default clock_timestamp(),
  processing_started_at timestamptz,
  provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  unique(notification_id,channel)
);
create index notification_outbox_pending_idx
  on wellweb_private.notification_outbox(next_attempt_at,created_at)
  where status in ('PENDING','FAILED','PROCESSING');
create unique index notification_outbox_provider_message_idx
  on wellweb_private.notification_outbox(provider_message_id)
  where provider_message_id is not null;
alter table wellweb_private.professional_notification_preferences enable row level security;
alter table wellweb_private.professional_whatsapp_consent_events enable row level security;
alter table wellweb_private.notification_outbox enable row level security;
revoke all on wellweb_private.professional_notification_preferences from public,anon,authenticated;
revoke all on wellweb_private.professional_whatsapp_consent_events from public,anon,authenticated;
revoke all on wellweb_private.notification_outbox from public,anon,authenticated;

alter table public.wellweb_notifications
  drop constraint if exists wellweb_notifications_event_type_check;
alter table public.wellweb_notifications
  add constraint wellweb_notifications_event_type_check check(event_type in (
    'BOOKING_REQUESTED','BOOKING_CONFIRMED','BOOKING_REJECTED','BOOKING_CANCELLED',
    'BOOKING_COMPLETED','BOOKING_EXPIRED'
  ));

create or replace function wellweb_private.enqueue_wellweb_notification_channels()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.event_type in ('BOOKING_REQUESTED','BOOKING_CONFIRMED','BOOKING_REJECTED','BOOKING_CANCELLED','BOOKING_EXPIRED') then
    insert into wellweb_private.notification_outbox(notification_id,recipient_user_id,channel)
    values(new.id,new.recipient_user_id,'EMAIL'),(new.id,new.recipient_user_id,'WHATSAPP')
    on conflict(notification_id,channel) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.enqueue_wellweb_notification_channels() from public,anon,authenticated;
create trigger wellweb_notifications_enqueue_channels
after insert on public.wellweb_notifications
for each row execute function wellweb_private.enqueue_wellweb_notification_channels();

-- Consent captured at registration is accepted only for the exact current
-- text version and is attached to the normalized phone on the new profile.
create or replace function wellweb_private.capture_registration_whatsapp_consent()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user public.app_users%rowtype; v_meta jsonb; v_version constant text:='wellweb-whatsapp-operations-v1-2026-11-15';
begin
  select * into v_user from public.app_users where id=new.user_id;
  if not found then return new; end if;
  select raw_user_meta_data into v_meta from auth.users where id=v_user.auth_user_id;
  insert into wellweb_private.professional_notification_preferences(professional_profile_id)
  values(new.id) on conflict(professional_profile_id) do nothing;
  if v_meta->>'whatsapp_operational_consent'='true'
     and v_meta->>'whatsapp_consent_text_version'=v_version
     and v_user.phone_e164 ~ '^[+][1-9][0-9]{7,14}$' then
    update wellweb_private.professional_notification_preferences
      set whatsapp_enabled=true,updated_at=clock_timestamp() where professional_profile_id=new.id;
    insert into wellweb_private.professional_whatsapp_consent_events(
      professional_profile_id,phone_e164,event_type,source,text_version,actor_user_id
    ) values(new.id,v_user.phone_e164,'GRANTED','REGISTRATION',v_version,v_user.id);
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.capture_registration_whatsapp_consent() from public,anon,authenticated;
create trigger professional_profiles_capture_whatsapp_consent
after insert on public.professional_profiles
for each row execute function wellweb_private.capture_registration_whatsapp_consent();

create or replace function wellweb_private.disable_whatsapp_on_phone_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid;
begin
  if old.phone_e164 is distinct from new.phone_e164 and new.account_type='PROFESSIONAL' then
    select id into v_profile_id from public.professional_profiles where user_id=new.id;
    if v_profile_id is not null then
      update wellweb_private.professional_notification_preferences
        set whatsapp_enabled=false,updated_at=clock_timestamp() where professional_profile_id=v_profile_id;
      if old.phone_e164 ~ '^[+][1-9][0-9]{7,14}$' then
        insert into wellweb_private.professional_whatsapp_consent_events(
          professional_profile_id,phone_e164,event_type,source,text_version,actor_user_id
        ) values(v_profile_id,old.phone_e164,'PHONE_CHANGED','PHONE_CHANGE',null,new.id);
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.disable_whatsapp_on_phone_change() from public,anon,authenticated;
create trigger app_users_disable_whatsapp_on_phone_change
after update of phone_e164 on public.app_users
for each row execute function wellweb_private.disable_whatsapp_on_phone_change();

create or replace function wellweb_private.guard_app_user_phone_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.phone_e164 is distinct from new.phone_e164
     and coalesce(current_setting('wellweb.contact_update',true),'')<>'rpc' then
    raise exception 'Phone numbers must be changed through the verified contact settings function';
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.guard_app_user_phone_change() from public,anon,authenticated;
create trigger app_users_guard_phone_change
before update of phone_e164 on public.app_users
for each row execute function wellweb_private.guard_app_user_phone_change();

create or replace function public.my_update_contact_details(p_display_name text,p_phone text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_phone text;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type not in ('HOTEL','PROFESSIONAL') or v_actor.status<>'ACTIVE' then
    raise exception 'Active partner account required';
  end if;
  v_phone:=regexp_replace(pg_catalog.btrim(coalesce(p_phone,'')),'[[:space:]().-]','','g');
  if nullif(pg_catalog.btrim(p_display_name),'') is null or length(pg_catalog.btrim(p_display_name))>160 then
    raise exception 'A valid display name is required';
  end if;
  if v_phone !~ '^[+][1-9][0-9]{7,14}$' then raise exception 'Use a valid international phone number in E.164 format'; end if;
  perform set_config('wellweb.contact_update','rpc',true);
  update public.app_users set display_name=pg_catalog.btrim(p_display_name),phone_e164=v_phone where id=v_actor.id;
  return v_phone;
end;
$$;
revoke all on function public.my_update_contact_details(text,text) from public,anon;
grant execute on function public.my_update_contact_details(text,text) to authenticated;
revoke update(phone_e164) on public.app_users from authenticated;

create or replace function public.my_save_professional_whatsapp_preference(
  p_enabled boolean,p_explicit_consent boolean default false,p_text_version text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid; v_pref wellweb_private.professional_notification_preferences%rowtype;
  v_phone text; v_version constant text:='wellweb-whatsapp-operations-v1-2026-11-15';
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' or v_actor.status<>'ACTIVE' then raise exception 'Active professional account required'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  if v_profile_id is null then raise exception 'Professional profile required'; end if;
  v_phone:=v_actor.phone_e164;
  if v_phone is null or v_phone !~ '^[+][1-9][0-9]{7,14}$' then raise exception 'Save a valid international phone number before enabling WhatsApp'; end if;
  insert into wellweb_private.professional_notification_preferences(professional_profile_id)
    values(v_profile_id) on conflict(professional_profile_id) do nothing;
  select * into v_pref from wellweb_private.professional_notification_preferences
    where professional_profile_id=v_profile_id for update;
  if p_enabled then
    if p_explicit_consent is distinct from true or p_text_version is distinct from v_version then
      raise exception 'Explicit consent to the current WhatsApp notice is required';
    end if;
    insert into wellweb_private.professional_whatsapp_consent_events(
      professional_profile_id,phone_e164,event_type,source,text_version,actor_user_id
    ) values(v_profile_id,v_phone,'GRANTED','PROFILE_SETTINGS',v_version,v_actor.id);
    update wellweb_private.professional_notification_preferences set whatsapp_enabled=true,updated_at=clock_timestamp()
      where professional_profile_id=v_profile_id;
  else
    if v_pref.whatsapp_enabled then
      insert into wellweb_private.professional_whatsapp_consent_events(
        professional_profile_id,phone_e164,event_type,source,text_version,actor_user_id
      ) values(v_profile_id,v_phone,'REVOKED','PROFILE_SETTINGS',v_version,v_actor.id);
    end if;
    update wellweb_private.professional_notification_preferences set whatsapp_enabled=false,updated_at=clock_timestamp()
      where professional_profile_id=v_profile_id;
  end if;
  return public.my_professional_whatsapp_preference();
end;
$$;

create or replace function public.my_professional_whatsapp_preference()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_profile_id uuid; v_pref wellweb_private.professional_notification_preferences%rowtype;
  v_latest wellweb_private.professional_whatsapp_consent_events%rowtype;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' or v_actor.status<>'ACTIVE' then raise exception 'Active professional account required'; end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_actor.id;
  select * into v_pref from wellweb_private.professional_notification_preferences where professional_profile_id=v_profile_id;
  select * into v_latest from wellweb_private.professional_whatsapp_consent_events
    where professional_profile_id=v_profile_id and phone_e164=v_actor.phone_e164 order by id desc limit 1;
  return jsonb_build_object('phone_e164',v_actor.phone_e164,'whatsapp_enabled',coalesce(v_pref.whatsapp_enabled,false),
    'consent_active',coalesce(v_pref.whatsapp_enabled,false) and v_latest.event_type='GRANTED',
    'consented_at',case when v_latest.event_type='GRANTED' then v_latest.occurred_at else null end,
    'text_version',case when v_latest.event_type='GRANTED' then v_latest.text_version else null end);
end;
$$;
revoke all on function public.my_save_professional_whatsapp_preference(boolean,boolean,text) from public,anon;
revoke all on function public.my_professional_whatsapp_preference() from public,anon;
grant execute on function public.my_save_professional_whatsapp_preference(boolean,boolean,text) to authenticated;
grant execute on function public.my_professional_whatsapp_preference() to authenticated;

create or replace function public.decide_wellweb_booking(p_booking_id uuid,p_accept boolean,p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_booking public.wellweb_bookings%rowtype;
  v_pro_user_id uuid; v_next public.wellweb_booking_status;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'PROFESSIONAL' then raise exception 'Only the professional can accept or reject a request'; end if;
  if p_reason is not null and length(pg_catalog.btrim(p_reason))>1000 then raise exception 'Reason is too long'; end if;
  select b.* into v_booking from public.wellweb_bookings b where b.id=p_booking_id for update;
  if not found then raise exception 'Reservation not found'; end if;
  select p.user_id into v_pro_user_id from public.professional_profiles p where p.id=v_booking.professional_profile_id;
  if v_pro_user_id is distinct from v_actor.id then raise exception 'This reservation belongs to another professional'; end if;
  if v_booking.status<>'PENDING' then raise exception 'Only pending requests can be accepted or rejected'; end if;
  if v_booking.response_deadline_at is not null and clock_timestamp()>=v_booking.response_deadline_at then
    raise exception 'The professional response deadline has passed';
  end if;
  if p_accept then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wellweb-booking-'||v_booking.professional_profile_id::text));
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
  update public.wellweb_bookings set status=v_next,
    resolution_code=case when p_accept then null else 'PROFESSIONAL_REJECTED' end
    where id=v_booking.id;
  insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
    values(v_booking.id,v_booking.status,v_next,v_actor.id,nullif(pg_catalog.btrim(p_reason),''));
  insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
  select hm.user_id,v_booking.id,case when p_accept then 'BOOKING_CONFIRMED' else 'BOOKING_REJECTED' end,
    case when p_accept then 'Pedido aceite' else 'Pedido rejeitado' end,
    'Pedido '||v_booking.booking_reference||case when p_accept then ' foi confirmado.' else ' foi rejeitado pelo profissional.' end
  from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
end;
$$;
revoke all on function public.decide_wellweb_booking(uuid,boolean,text) from public,anon;
grant execute on function public.decide_wellweb_booking(uuid,boolean,text) to authenticated;

create or replace function public.expire_unanswered_wellweb_bookings(p_batch_size integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_booking public.wellweb_bookings%rowtype; v_professional_user_id uuid; v_count integer:=0;
begin
  if auth.role() is distinct from 'service_role' and session_user not in ('postgres','supabase_admin') then
    raise exception 'Backend scheduler access required';
  end if;
  for v_booking in
    select * from public.wellweb_bookings
    where status='PENDING' and response_deadline_at is not null and response_deadline_at<=clock_timestamp()
    order by response_deadline_at,id
    for update skip locked
    limit greatest(1,least(coalesce(p_batch_size,100),500))
  loop
    select p.user_id into v_professional_user_id from public.professional_profiles p where p.id=v_booking.professional_profile_id;
    update public.wellweb_bookings set status='CANCELLED',resolution_code='PROFESSIONAL_RESPONSE_TIMEOUT'
      where id=v_booking.id and status='PENDING' and response_deadline_at<=clock_timestamp();
    if found then
      insert into public.wellweb_booking_history(booking_id,from_status,to_status,actor_user_id,reason)
        values(v_booking.id,'PENDING','CANCELLED',null,'PROFESSIONAL_RESPONSE_TIMEOUT: pedido cancelado automaticamente após 4 horas sem resposta.');
      insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
        values(v_professional_user_id,v_booking.id,'BOOKING_EXPIRED','Pedido expirado','O pedido '||v_booking.booking_reference||' foi cancelado automaticamente porque terminou o prazo de 4 horas sem resposta.');
      insert into public.wellweb_notifications(recipient_user_id,booking_id,event_type,title,body)
        select hm.user_id,v_booking.id,'BOOKING_EXPIRED','Pedido expirado','O pedido '||v_booking.booking_reference||' foi cancelado automaticamente porque terminou o prazo de 4 horas sem resposta.'
        from public.hotel_members hm where hm.hotel_id=v_booking.hotel_id and hm.status='ACTIVE';
      v_count:=v_count+1;
    end if;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.expire_unanswered_wellweb_bookings(integer) from public,anon,authenticated;

create or replace function public.my_list_wellweb_bookings()
returns setof jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type not in ('HOTEL','PROFESSIONAL') then raise exception 'Partner account required'; end if;
  return query select to_jsonb(x) from (
    select b.id,b.booking_reference,b.hotel_id,h.name as hotel_name,b.professional_profile_id,p.public_name as professional_name,
      b.service_id,b.service_name_snapshot,b.service_duration_minutes_snapshot,b.service_price_snapshot,b.service_currency_snapshot,
      b.price_type_snapshot,b.max_students_snapshot,b.students_count,b.total_price_snapshot,b.completion_method,b.completed_by,b.completed_at,
      b.starts_at,b.ends_at,b.participants,b.guest_name,b.notes,b.status::text as status,b.created_at,b.updated_at,
      b.response_deadline_at,b.resolution_code
    from public.wellweb_bookings b join public.hotels h on h.id=b.hotel_id join public.professional_profiles p on p.id=b.professional_profile_id
    where (v_actor.account_type='HOTEL' and exists(select 1 from public.hotel_members hm where hm.user_id=v_actor.id and hm.hotel_id=b.hotel_id and hm.status='ACTIVE'))
      or (v_actor.account_type='PROFESSIONAL' and p.user_id=v_actor.id)
    order by b.starts_at desc
  ) x;
end;
$$;
revoke all on function public.my_list_wellweb_bookings() from public,anon;
grant execute on function public.my_list_wellweb_bookings() to authenticated;

create or replace function public.claim_wellweb_notification_outbox(p_batch_size integer default 25)
returns setof jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend worker access required'; end if;
  return query
  with candidates as (
    select o.id from wellweb_private.notification_outbox o
    where o.attempts<8 and (
      (o.status='PENDING' and o.next_attempt_at<=clock_timestamp())
      or (o.status='FAILED' and o.next_attempt_at is not null and o.next_attempt_at<=clock_timestamp())
      or (o.status='PROCESSING' and o.processing_started_at<clock_timestamp()-interval '5 minutes')
    )
    order by o.next_attempt_at,o.created_at,o.id
    for update skip locked
    limit greatest(1,least(coalesce(p_batch_size,25),100))
  ), claimed as (
    update wellweb_private.notification_outbox o
      set status='PROCESSING',attempts=o.attempts+1,processing_started_at=clock_timestamp(),updated_at=clock_timestamp()
    from candidates c where o.id=c.id
    returning o.*
  )
  select jsonb_build_object(
    'id',c.id,'notification_id',c.notification_id,'recipient_user_id',c.recipient_user_id,'channel',c.channel,
    'attempts',c.attempts,'event_type',n.event_type,'title',n.title,'body',n.body,
    'email',u.email,'display_name',coalesce(u.display_name,''),'account_type',u.account_type::text,
    'phone_e164',u.phone_e164,'booking_reference',b.booking_reference,'starts_at',b.starts_at,
    'response_deadline_at',b.response_deadline_at,'resolution_code',b.resolution_code
  )
  from claimed c join public.wellweb_notifications n on n.id=c.notification_id
    join public.app_users u on u.id=c.recipient_user_id
    join public.wellweb_bookings b on b.id=n.booking_id;
end;
$$;
revoke all on function public.claim_wellweb_notification_outbox(integer) from public,anon,authenticated;
grant execute on function public.claim_wellweb_notification_outbox(integer) to service_role;

create or replace function public.check_wellweb_whatsapp_eligibility(p_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row wellweb_private.notification_outbox%rowtype; v_user public.app_users%rowtype;
  v_profile_id uuid; v_pref wellweb_private.professional_notification_preferences%rowtype;
  v_latest wellweb_private.professional_whatsapp_consent_events%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend worker access required'; end if;
  select * into v_row from wellweb_private.notification_outbox where id=p_outbox_id and channel='WHATSAPP' and status='PROCESSING';
  if not found then return jsonb_build_object('eligible',false,'reason','OUTBOX_NOT_PROCESSING'); end if;
  select * into v_user from public.app_users where id=v_row.recipient_user_id;
  if not found or v_user.status<>'ACTIVE' or v_user.account_type<>'PROFESSIONAL' then
    return jsonb_build_object('eligible',false,'reason','RECIPIENT_NOT_ELIGIBLE');
  end if;
  if v_user.phone_e164 is null or v_user.phone_e164 !~ '^[+][1-9][0-9]{7,14}$' then
    return jsonb_build_object('eligible',false,'reason','PHONE_NOT_VALID');
  end if;
  select id into v_profile_id from public.professional_profiles where user_id=v_user.id;
  select * into v_pref from wellweb_private.professional_notification_preferences where professional_profile_id=v_profile_id;
  if not coalesce(v_pref.whatsapp_enabled,false) then return jsonb_build_object('eligible',false,'reason','WHATSAPP_DISABLED'); end if;
  select * into v_latest from wellweb_private.professional_whatsapp_consent_events
    where professional_profile_id=v_profile_id and phone_e164=v_user.phone_e164 order by id desc limit 1;
  if v_latest.event_type is distinct from 'GRANTED' then return jsonb_build_object('eligible',false,'reason','CONSENT_NOT_ACTIVE'); end if;
  return jsonb_build_object('eligible',true,'phone_e164',v_user.phone_e164,'display_name',coalesce(v_user.display_name,''));
end;
$$;
revoke all on function public.check_wellweb_whatsapp_eligibility(uuid) from public,anon,authenticated;
grant execute on function public.check_wellweb_whatsapp_eligibility(uuid) to service_role;

create or replace function public.finish_wellweb_notification_outbox(
  p_outbox_id uuid,p_status text,p_error_code text default null,p_provider_message_id text default null,p_retryable boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_row wellweb_private.notification_outbox%rowtype; v_next timestamptz;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend worker access required'; end if;
  if p_status not in ('SENT','FAILED','SKIPPED') then raise exception 'Invalid outbox result'; end if;
  select * into v_row from wellweb_private.notification_outbox where id=p_outbox_id for update;
  if not found or v_row.status<>'PROCESSING' then return false; end if;
  if v_row.attempts<8 and ((p_status='FAILED' and p_retryable) or (p_status='SENT' and p_provider_message_id is not null and exists(select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='failed'))) then
    v_next:=clock_timestamp()+make_interval(secs=>least(3600,15*(2^least(v_row.attempts-1,8))::integer));
  end if;
  update wellweb_private.notification_outbox set status=
    case when p_status='SENT' and p_provider_message_id is not null and exists(
      select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='read'
    ) then 'READ'
    when p_status='SENT' and p_provider_message_id is not null and exists(
      select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='delivered'
    ) then 'DELIVERED'
    when p_status='SENT' and p_provider_message_id is not null and exists(
      select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='failed'
    ) then 'FAILED'
    else p_status end,
    next_attempt_at=v_next,processing_started_at=null,
    provider_message_id=coalesce(p_provider_message_id,provider_message_id),
    last_error_code=case when p_status='FAILED' or p_status='SKIPPED' then left(coalesce(p_error_code,p_status),80)
      when p_status='SENT' and p_provider_message_id is not null and exists(
        select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='failed'
      ) then 'META_DELIVERY_FAILED' else null end,
    sent_at=case when p_status='SENT' and not (p_provider_message_id is not null and exists(select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='failed')) then clock_timestamp() else sent_at end,
    updated_at=clock_timestamp()
  where id=p_outbox_id;
  return true;
end;
$$;
revoke all on function public.finish_wellweb_notification_outbox(uuid,text,text,text,boolean) from public,anon,authenticated;
grant execute on function public.finish_wellweb_notification_outbox(uuid,text,text,text,boolean) to service_role;

-- Delivery webhooks can arrive more than once or before the send response has
-- been saved, so retain de-duplicated receipt events and reconcile by WA message id.
create table wellweb_private.whatsapp_delivery_events (
  id bigint generated always as identity primary key,
  provider_message_id text not null,
  event_status text not null check(event_status in ('delivered','read','failed')),
  error_code text,
  received_at timestamptz not null default clock_timestamp(),
  unique(provider_message_id,event_status)
);
alter table wellweb_private.whatsapp_delivery_events enable row level security;
revoke all on wellweb_private.whatsapp_delivery_events from public,anon,authenticated;

create or replace function public.record_wellweb_whatsapp_delivery(p_provider_message_id text,p_status text,p_error_code text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend webhook access required'; end if;
  if p_provider_message_id is null or length(p_provider_message_id)>200 or p_status not in ('delivered','read','failed') then return; end if;
  insert into wellweb_private.whatsapp_delivery_events(provider_message_id,event_status,error_code)
    values(p_provider_message_id,p_status,left(p_error_code,80)) on conflict(provider_message_id,event_status) do nothing;
  select id into v_id from wellweb_private.notification_outbox where provider_message_id=p_provider_message_id for update;
  if v_id is not null then
    update wellweb_private.notification_outbox set
      status=case when exists(select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='read') then 'READ'
        when exists(select 1 from wellweb_private.whatsapp_delivery_events e where e.provider_message_id=p_provider_message_id and e.event_status='delivered') then 'DELIVERED'
        when p_status='failed' then 'FAILED' else status end,
      last_error_code=case when p_status='failed' then coalesce(left(p_error_code,80),'META_DELIVERY_FAILED') else last_error_code end,
      next_attempt_at=case when p_status='failed' and attempts<8 then clock_timestamp()+make_interval(secs=>least(3600,15*(2^least(attempts,8))::integer)) else next_attempt_at end,
      updated_at=clock_timestamp()
      where id=v_id and status not in ('SKIPPED','READ');
  end if;
end;
$$;
revoke all on function public.record_wellweb_whatsapp_delivery(text,text,text) from public,anon,authenticated;
grant execute on function public.record_wellweb_whatsapp_delivery(text,text,text) to service_role;

create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
do $$
declare old_job bigint;
begin
  select jobid into old_job from cron.job where jobname='wellweb-expire-unanswered-bookings' limit 1;
  if old_job is not null then perform cron.unschedule(old_job); end if;
  perform cron.schedule('wellweb-expire-unanswered-bookings','* * * * *','select public.expire_unanswered_wellweb_bookings(100);');
  select jobid into old_job from cron.job where jobname='wellweb-dispatch-notification-outbox' limit 1;
  if old_job is not null then perform cron.unschedule(old_job); end if;
  perform cron.schedule('wellweb-dispatch-notification-outbox','* * * * *',$job$
    select net.http_post(
      url:=(select decrypted_secret from vault.decrypted_secrets where name='wellweb_supabase_url')||'/functions/v1/process-wellweb-notification-outbox',
      headers:=jsonb_build_object('Content-Type','application/json','apikey',(select decrypted_secret from vault.decrypted_secrets where name='wellweb_service_role_key'),'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='wellweb_service_role_key')),
      body:='{"source":"cron"}'::jsonb,timeout_milliseconds:=10000
    ) where exists(select 1 from vault.decrypted_secrets where name='wellweb_supabase_url')
      and exists(select 1 from vault.decrypted_secrets where name='wellweb_service_role_key');
  $job$);
end;
$$;

notify pgrst,'reload schema';
commit;
