-- Extend operational WhatsApp consent to HOTEL accounts and stop outbound
-- channels for response-timeout notifications. In-app expiry notices remain.
begin;

create table wellweb_private.hotel_whatsapp_notification_preferences (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  whatsapp_enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
insert into wellweb_private.hotel_whatsapp_notification_preferences(user_id)
select id from public.app_users where account_type='HOTEL'
on conflict(user_id) do nothing;

create table wellweb_private.hotel_whatsapp_consent_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.app_users(id) on delete cascade,
  phone_e164 text not null check(phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  event_type text not null check(event_type in ('GRANTED','REVOKED','PHONE_CHANGED')),
  source text not null check(source in ('REGISTRATION','PROFILE_SETTINGS','PHONE_CHANGE')),
  text_version text,
  actor_user_id uuid references public.app_users(id) on delete set null,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint hotel_whatsapp_consent_event_version_check
    check(event_type='PHONE_CHANGED' or nullif(text_version,'') is not null)
);
create index hotel_whatsapp_consent_latest_idx
  on wellweb_private.hotel_whatsapp_consent_events(user_id,phone_e164,id desc);
alter table wellweb_private.hotel_whatsapp_notification_preferences enable row level security;
alter table wellweb_private.hotel_whatsapp_consent_events enable row level security;
revoke all on wellweb_private.hotel_whatsapp_notification_preferences from public,anon,authenticated;
revoke all on wellweb_private.hotel_whatsapp_consent_events from public,anon,authenticated;

create or replace function wellweb_private.enqueue_wellweb_notification_channels()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.event_type in ('BOOKING_REQUESTED','BOOKING_CONFIRMED','BOOKING_REJECTED','BOOKING_CANCELLED') then
    insert into wellweb_private.notification_outbox(notification_id,recipient_user_id,channel)
    values(new.id,new.recipient_user_id,'EMAIL'),(new.id,new.recipient_user_id,'WHATSAPP')
    on conflict(notification_id,channel) do nothing;
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.enqueue_wellweb_notification_channels() from public,anon,authenticated;

update wellweb_private.notification_outbox o
set status='SKIPPED',next_attempt_at=null,processing_started_at=null,
    last_error_code='NOT_REQUIRED',updated_at=clock_timestamp()
from public.wellweb_notifications n
where n.id=o.notification_id and n.event_type='BOOKING_EXPIRED'
  and o.status in ('PENDING','FAILED','PROCESSING');

create or replace function wellweb_private.capture_hotel_registration_whatsapp_consent()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_meta jsonb; v_version constant text:='wellweb-hotel-whatsapp-operations-v1-2026-11-17';
begin
  if new.account_type<>'HOTEL' then return new; end if;
  insert into wellweb_private.hotel_whatsapp_notification_preferences(user_id)
    values(new.id) on conflict(user_id) do nothing;
  select u.raw_user_meta_data into v_meta from auth.users u where u.id=new.auth_user_id;
  if v_meta->>'whatsapp_operational_consent'='true'
     and v_meta->>'whatsapp_consent_text_version'=v_version
     and new.phone_e164 ~ '^[+][1-9][0-9]{7,14}$' then
    update wellweb_private.hotel_whatsapp_notification_preferences
      set whatsapp_enabled=true,updated_at=clock_timestamp() where user_id=new.id;
    insert into wellweb_private.hotel_whatsapp_consent_events(
      user_id,phone_e164,event_type,source,text_version,actor_user_id
    ) values(new.id,new.phone_e164,'GRANTED','REGISTRATION',v_version,new.id);
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.capture_hotel_registration_whatsapp_consent() from public,anon,authenticated;
create trigger app_users_capture_hotel_whatsapp_consent
after insert on public.app_users
for each row execute function wellweb_private.capture_hotel_registration_whatsapp_consent();

create or replace function wellweb_private.disable_whatsapp_on_phone_change()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_profile_id uuid; v_hotel_preference_found boolean;
begin
  if old.phone_e164 is distinct from new.phone_e164 and new.account_type='PROFESSIONAL' then
    select p.id into v_profile_id from public.professional_profiles p where p.user_id=new.id;
    if v_profile_id is not null then
      update wellweb_private.professional_notification_preferences
        set whatsapp_enabled=false,updated_at=clock_timestamp() where professional_profile_id=v_profile_id;
      if old.phone_e164 ~ '^[+][1-9][0-9]{7,14}$' then
        insert into wellweb_private.professional_whatsapp_consent_events(
          professional_profile_id,phone_e164,event_type,source,text_version,actor_user_id
        ) values(v_profile_id,old.phone_e164,'PHONE_CHANGED','PHONE_CHANGE',null,new.id);
      end if;
    end if;
  elsif old.phone_e164 is distinct from new.phone_e164 and new.account_type='HOTEL' then
    update wellweb_private.hotel_whatsapp_notification_preferences
      set whatsapp_enabled=false,updated_at=clock_timestamp() where user_id=new.id;
    v_hotel_preference_found:=found;
    if v_hotel_preference_found and old.phone_e164 ~ '^[+][1-9][0-9]{7,14}$' then
      insert into wellweb_private.hotel_whatsapp_consent_events(
        user_id,phone_e164,event_type,source,text_version,actor_user_id
      ) values(new.id,old.phone_e164,'PHONE_CHANGED','PHONE_CHANGE',null,new.id);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.disable_whatsapp_on_phone_change() from public,anon,authenticated;

create or replace function public.my_save_hotel_whatsapp_preference(
  p_enabled boolean,p_explicit_consent boolean default false,p_text_version text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_pref wellweb_private.hotel_whatsapp_notification_preferences%rowtype;
  v_phone text; v_version constant text:='wellweb-hotel-whatsapp-operations-v1-2026-11-17';
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'HOTEL' or v_actor.status<>'ACTIVE' then raise exception 'Active hotel account required'; end if;
  v_phone:=v_actor.phone_e164;
  if v_phone is null or v_phone !~ '^[+][1-9][0-9]{7,14}$' then raise exception 'Save a valid international phone number before enabling WhatsApp'; end if;
  insert into wellweb_private.hotel_whatsapp_notification_preferences(user_id)
    values(v_actor.id) on conflict(user_id) do nothing;
  select * into v_pref from wellweb_private.hotel_whatsapp_notification_preferences where user_id=v_actor.id for update;
  if p_enabled then
    if p_explicit_consent is distinct from true or p_text_version is distinct from v_version then
      raise exception 'Explicit consent to the current WhatsApp notice is required';
    end if;
    insert into wellweb_private.hotel_whatsapp_consent_events(
      user_id,phone_e164,event_type,source,text_version,actor_user_id
    ) values(v_actor.id,v_phone,'GRANTED','PROFILE_SETTINGS',v_version,v_actor.id);
    update wellweb_private.hotel_whatsapp_notification_preferences
      set whatsapp_enabled=true,updated_at=clock_timestamp() where user_id=v_actor.id;
  else
    if v_pref.whatsapp_enabled then
      insert into wellweb_private.hotel_whatsapp_consent_events(
        user_id,phone_e164,event_type,source,text_version,actor_user_id
      ) values(v_actor.id,v_phone,'REVOKED','PROFILE_SETTINGS',v_version,v_actor.id);
    end if;
    update wellweb_private.hotel_whatsapp_notification_preferences
      set whatsapp_enabled=false,updated_at=clock_timestamp() where user_id=v_actor.id;
  end if;
  return jsonb_build_object('phone_e164',v_phone,'whatsapp_enabled',p_enabled,'consent_active',p_enabled);
end;
$$;
revoke all on function public.my_save_hotel_whatsapp_preference(boolean,boolean,text) from public,anon;
grant execute on function public.my_save_hotel_whatsapp_preference(boolean,boolean,text) to authenticated;

create or replace function public.my_hotel_whatsapp_preference()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor public.app_users%rowtype; v_pref wellweb_private.hotel_whatsapp_notification_preferences%rowtype;
  v_latest wellweb_private.hotel_whatsapp_consent_events%rowtype;
begin
  v_actor:=public.wellweb_actor();
  if v_actor.account_type<>'HOTEL' or v_actor.status<>'ACTIVE' then raise exception 'Active hotel account required'; end if;
  select * into v_pref from wellweb_private.hotel_whatsapp_notification_preferences where user_id=v_actor.id;
  select * into v_latest from wellweb_private.hotel_whatsapp_consent_events
    where user_id=v_actor.id and phone_e164=v_actor.phone_e164 order by id desc limit 1;
  return jsonb_build_object('phone_e164',v_actor.phone_e164,'whatsapp_enabled',coalesce(v_pref.whatsapp_enabled,false),
    'consent_active',coalesce(v_pref.whatsapp_enabled,false) and v_latest.event_type='GRANTED',
    'consented_at',case when v_latest.event_type='GRANTED' then v_latest.occurred_at else null end,
    'text_version',case when v_latest.event_type='GRANTED' then v_latest.text_version else null end);
end;
$$;
revoke all on function public.my_hotel_whatsapp_preference() from public,anon;
grant execute on function public.my_hotel_whatsapp_preference() to authenticated;

create or replace function public.check_wellweb_whatsapp_eligibility(p_outbox_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row wellweb_private.notification_outbox%rowtype; v_user public.app_users%rowtype;
  v_profile_id uuid; v_prof_pref wellweb_private.professional_notification_preferences%rowtype;
  v_prof_latest wellweb_private.professional_whatsapp_consent_events%rowtype;
  v_hotel_pref wellweb_private.hotel_whatsapp_notification_preferences%rowtype;
  v_hotel_latest wellweb_private.hotel_whatsapp_consent_events%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend worker access required'; end if;
  select * into v_row from wellweb_private.notification_outbox
    where id=p_outbox_id and channel='WHATSAPP' and status='PROCESSING';
  if not found then return jsonb_build_object('eligible',false,'reason','OUTBOX_NOT_PROCESSING'); end if;
  select * into v_user from public.app_users where id=v_row.recipient_user_id;
  if not found or v_user.status<>'ACTIVE' or v_user.account_type not in ('PROFESSIONAL','HOTEL') then
    return jsonb_build_object('eligible',false,'reason','RECIPIENT_NOT_ELIGIBLE');
  end if;
  if v_user.phone_e164 is null or v_user.phone_e164 !~ '^[+][1-9][0-9]{7,14}$' then
    return jsonb_build_object('eligible',false,'reason','PHONE_NOT_VALID');
  end if;
  if v_user.account_type='PROFESSIONAL' then
    select p.id into v_profile_id from public.professional_profiles p where p.user_id=v_user.id;
    if v_profile_id is null then return jsonb_build_object('eligible',false,'reason','PROFESSIONAL_PROFILE_MISSING'); end if;
    select * into v_prof_pref from wellweb_private.professional_notification_preferences where professional_profile_id=v_profile_id;
    if not coalesce(v_prof_pref.whatsapp_enabled,false) then return jsonb_build_object('eligible',false,'reason','WHATSAPP_DISABLED'); end if;
    select * into v_prof_latest from wellweb_private.professional_whatsapp_consent_events
      where professional_profile_id=v_profile_id and phone_e164=v_user.phone_e164 order by id desc limit 1;
    if v_prof_latest.event_type is distinct from 'GRANTED' then return jsonb_build_object('eligible',false,'reason','CONSENT_NOT_ACTIVE'); end if;
  else
    select * into v_hotel_pref from wellweb_private.hotel_whatsapp_notification_preferences where user_id=v_user.id;
    if not coalesce(v_hotel_pref.whatsapp_enabled,false) then return jsonb_build_object('eligible',false,'reason','WHATSAPP_DISABLED'); end if;
    select * into v_hotel_latest from wellweb_private.hotel_whatsapp_consent_events
      where user_id=v_user.id and phone_e164=v_user.phone_e164 order by id desc limit 1;
    if v_hotel_latest.event_type is distinct from 'GRANTED' then return jsonb_build_object('eligible',false,'reason','CONSENT_NOT_ACTIVE'); end if;
  end if;
  return jsonb_build_object('eligible',true,'phone_e164',v_user.phone_e164,'display_name',coalesce(v_user.display_name,''));
end;
$$;
revoke all on function public.check_wellweb_whatsapp_eligibility(uuid) from public,anon,authenticated;
grant execute on function public.check_wellweb_whatsapp_eligibility(uuid) to service_role;

commit;
