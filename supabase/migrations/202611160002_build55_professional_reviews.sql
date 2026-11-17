-- Build 5.5: public guest reviews, one editable hotel review per partner pair,
-- separately aggregated ratings, reporting, moderation and server-side guards.
begin;

create schema if not exists wellweb_private;
revoke all on schema wellweb_private from public, anon, authenticated;

create table wellweb_private.review_rate_secret (
  singleton boolean primary key default true check (singleton),
  secret bytea not null
);
insert into wellweb_private.review_rate_secret(singleton, secret)
values (true, extensions.gen_random_bytes(32))
on conflict (singleton) do nothing;

create table wellweb_private.review_rate_limits (
  source_digest bytea primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);

create table public.review_invitations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.wellweb_bookings(id) on delete restrict,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  submission_count integer not null default 0 check (submission_count >= 0),
  submission_limit integer not null check (submission_limit between 1 and 100),
  created_at timestamptz not null default now()
);
create unique index review_invitations_one_active_per_booking_idx
  on public.review_invitations(booking_id) where revoked_at is null;
create index review_invitations_expiry_idx on public.review_invitations(expires_at) where revoked_at is null;

create table public.professional_reviews (
  id uuid primary key default gen_random_uuid(),
  professional_profile_id uuid not null references public.professional_profiles(id) on delete restrict,
  booking_id uuid not null references public.wellweb_bookings(id) on delete restrict,
  hotel_id uuid not null references public.hotels(id) on delete restrict,
  review_invitation_id uuid references public.review_invitations(id) on delete restrict,
  source_type text not null check (source_type in ('GUEST','HOTEL')),
  submitted_by_user_id uuid references public.app_users(id) on delete restrict,
  idempotency_key uuid,
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or length(comment) <= 500),
  status text not null default 'PUBLISHED' check (status in ('PUBLISHED','HIDDEN','INVALIDATED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint professional_reviews_source_fields_chk check (
    (source_type='GUEST' and review_invitation_id is not null and submitted_by_user_id is null and idempotency_key is not null)
    or (source_type='HOTEL' and review_invitation_id is null and submitted_by_user_id is not null and idempotency_key is null)
  )
);
create unique index professional_reviews_guest_idempotency_idx
  on public.professional_reviews(review_invitation_id,idempotency_key) where source_type='GUEST';
create unique index professional_reviews_hotel_active_pair_idx
  on public.professional_reviews(hotel_id,professional_profile_id)
  where source_type='HOTEL' and status in ('PUBLISHED','HIDDEN');
create index professional_reviews_public_summary_idx
  on public.professional_reviews(professional_profile_id,source_type,status,created_at desc);
create index professional_reviews_booking_idx on public.professional_reviews(booking_id,source_type);

create or replace function wellweb_private.validate_professional_review_relationship()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare booking public.wellweb_bookings%rowtype; invitation_booking_id uuid;
begin
  select * into booking from public.wellweb_bookings where id=new.booking_id;
  if not found or booking.professional_profile_id<>new.professional_profile_id or booking.hotel_id<>new.hotel_id
    or booking.status<>'COMPLETED' then
    raise exception 'A review must match a completed booking and its hotel and professional';
  end if;
  if new.source_type='GUEST' then
    select i.booking_id into invitation_booking_id from public.review_invitations i where i.id=new.review_invitation_id;
    if invitation_booking_id is distinct from new.booking_id then raise exception 'Review invitation does not match the booking'; end if;
  end if;
  return new;
end;
$$;
revoke all on function wellweb_private.validate_professional_review_relationship() from public,anon,authenticated;
create trigger professional_reviews_validate_relationship
before insert or update of professional_profile_id,booking_id,hotel_id,review_invitation_id,source_type
on public.professional_reviews for each row execute function wellweb_private.validate_professional_review_relationship();

create trigger professional_reviews_set_updated_at
before update on public.professional_reviews
for each row execute function public.set_updated_at();

create table public.professional_review_reports (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.professional_reviews(id) on delete restrict,
  reporter_professional_profile_id uuid not null references public.professional_profiles(id) on delete restrict,
  reason text not null check (reason in ('OFFENSIVE','FALSE_INFORMATION','SPAM','PRIVACY','OTHER')),
  details text check (details is null or length(details) <= 500),
  status text not null default 'OPEN' check (status in ('OPEN','REVIEWED','DISMISSED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.app_users(id) on delete restrict,
  resolution_reason text check (resolution_reason is null or length(resolution_reason) <= 1000)
);
create unique index professional_review_reports_one_open_idx
  on public.professional_review_reports(review_id,reporter_professional_profile_id) where status='OPEN';
create index professional_review_reports_status_created_idx
  on public.professional_review_reports(status,created_at desc);

create table public.professional_review_audit (
  id uuid primary key default gen_random_uuid(),
  review_id uuid references public.professional_reviews(id) on delete restrict,
  invitation_id uuid references public.review_invitations(id) on delete restrict,
  report_id uuid references public.professional_review_reports(id) on delete restrict,
  action text not null check (action in ('HOTEL_CREATED','HOTEL_EDITED','ADMIN_HIDDEN','ADMIN_RESTORED','ADMIN_INVALIDATED','INVITATION_REVOKED','REPORT_RESOLVED')),
  actor_user_id uuid references public.app_users(id) on delete restrict,
  previous_state jsonb,
  new_state jsonb,
  reason text check (reason is null or length(reason) <= 1000),
  created_at timestamptz not null default now(),
  constraint professional_review_audit_subject_chk check (num_nonnulls(review_id,invitation_id,report_id)=1)
);
create index professional_review_audit_review_created_idx on public.professional_review_audit(review_id,created_at desc);

alter table public.review_invitations enable row level security;
alter table public.professional_reviews enable row level security;
alter table public.professional_review_reports enable row level security;
alter table public.professional_review_audit enable row level security;

create policy "public_read_published_reviews_for_public_profiles"
on public.professional_reviews for select to anon,authenticated
using (status='PUBLISHED' and exists (
  select 1 from public.public_professional_directory d where d.id=professional_profile_id
));

revoke all on public.review_invitations, public.professional_reviews,
  public.professional_review_reports, public.professional_review_audit from public,anon,authenticated;
grant select (id,professional_profile_id,source_type,rating,comment,status,created_at)
  on public.professional_reviews to anon,authenticated;
grant select on public.professional_reviews to service_role;

-- Internal aggregates: no direct Data API exposure. Bayesian ranking is used
-- only for sorting: (n/(n+5))*R + (5/(n+5))*C, with C the global guest mean.
create view wellweb_private.professional_review_aggregates as
with guest_prior as (
  select avg(rating)::numeric as global_guest_average
  from public.professional_reviews where source_type='GUEST' and status='PUBLISHED'
), aggregate_rows as (
  select professional_profile_id,
    avg(rating) filter (where source_type='GUEST')::numeric as guest_rating_average,
    count(*) filter (where source_type='GUEST')::bigint as guest_rating_count,
    avg(rating) filter (where source_type='HOTEL')::numeric as hotel_rating_average,
    count(*) filter (where source_type='HOTEL')::bigint as hotel_rating_count
  from public.professional_reviews where status='PUBLISHED'
  group by professional_profile_id
)
select a.professional_profile_id,a.guest_rating_average,a.guest_rating_count,
  a.hotel_rating_average,a.hotel_rating_count,
  case when a.guest_rating_count=0 then null else
    (a.guest_rating_count::numeric/(a.guest_rating_count+5))*a.guest_rating_average
      +(5::numeric/(a.guest_rating_count+5))*prior.global_guest_average end as guest_rating_bayesian
from aggregate_rows a cross join guest_prior prior;
revoke all on wellweb_private.professional_review_aggregates from public,anon,authenticated;

-- Extend the existing allowlisted public directory by appending rating columns.
create or replace view public.public_professional_directory
with (security_barrier = true) as
select p.id,p.public_name,p.city,p.service_area,p.description,
  coalesce((select array_agg(s.name order by s.name) from public.professional_services s where s.professional_profile_id=p.id and s.active),'{}'::text[]) as services,
  coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'description',s.description,'modality_slug',s.modality_slug,
    'duration_minutes',s.duration_minutes,'price',s.price,'currency',s.currency,'has_material',s.has_material,
    'allows_group',s.allows_group,'max_students',s.max_students,'price_per_student',s.price_per_student) order by s.name)
    from public.professional_services s where s.professional_profile_id=p.id and s.active),'[]'::jsonb) as service_details,
  coalesce((select array_agg(m.name order by m.name) from public.professional_modalities pm join public.modality_catalog m on m.slug=pm.modality_slug and m.active where pm.professional_profile_id=p.id),'{}'::text[]) as modalities,
  p.languages,p.primary_photo_path,p.gallery_photo_paths,p.published_at,
  a.guest_rating_average,coalesce(a.guest_rating_count,0)::bigint as guest_rating_count,
  a.hotel_rating_average,coalesce(a.hotel_rating_count,0)::bigint as hotel_rating_count,
  a.guest_rating_bayesian
from public.professional_profiles p
join public.app_users u on u.id=p.user_id
left join wellweb_private.professional_review_aggregates a on a.professional_profile_id=p.id
where p.is_public and p.approval_status='APPROVED' and p.published_at is not null
  and u.account_type='PROFESSIONAL' and u.status='ACTIVE';
grant select on public.public_professional_directory to anon,authenticated;

create or replace function public.hotel_create_review_invitation(p_booking_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor public.app_users%rowtype; booking public.wellweb_bookings%rowtype;
  completed_at timestamptz; invitation_id uuid; plain_token text; expiry timestamptz; participant_limit integer; existing_count integer;
begin
  actor:=public.wellweb_actor();
  if actor.account_type<>'HOTEL' then raise exception 'Hotel account required'; end if;
  select * into booking from public.wellweb_bookings where id=p_booking_id for update;
  if not found or booking.status<>'COMPLETED' then raise exception 'Only completed reservations can receive a review link'; end if;
  if not exists(select 1 from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id
    where hm.hotel_id=booking.hotel_id and hm.user_id=actor.id and hm.status='ACTIVE'
      and h.status='ACTIVE' and h.approval_status='APPROVED') then
    raise exception 'Active hotel membership required';
  end if;
  completed_at:=coalesce(booking.completed_at,booking.ends_at);
  expiry:=completed_at+interval '14 days';
  if completed_at>statement_timestamp() or statement_timestamp()>=expiry then
    raise exception 'The 14-day review period has expired';
  end if;
  participant_limit:=coalesce(booking.students_count,booking.participants);
  if participant_limit not between 1 and 100 then raise exception 'Reservation participant limit is unavailable'; end if;
  select count(*)::integer into existing_count from public.professional_reviews
    where booking_id=booking.id and source_type='GUEST';
  if existing_count>=participant_limit then raise exception 'The reservation has reached its guest review limit'; end if;
  update public.review_invitations set revoked_at=statement_timestamp()
    where booking_id=booking.id and revoked_at is null;
  plain_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  insert into public.review_invitations(booking_id,token_hash,expires_at,submission_limit)
  values(booking.id,encode(extensions.digest(convert_to(plain_token,'UTF8'),'sha256'),'hex'),expiry,participant_limit)
  returning id into invitation_id;
  return jsonb_build_object('invitation_id',invitation_id,'token',plain_token,'expires_at',expiry,'submission_limit',participant_limit);
end;
$$;
revoke all on function public.hotel_create_review_invitation(uuid) from public,anon;
grant execute on function public.hotel_create_review_invitation(uuid) to authenticated;

create or replace function public.hotel_save_professional_review(p_professional_profile_id uuid,p_hotel_id uuid,p_rating integer,p_comment text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare actor public.app_users%rowtype; v_hotel_id uuid; completed_booking_id uuid; old_review public.professional_reviews%rowtype; review_id uuid;
  clean_comment text:=nullif(pg_catalog.btrim(p_comment),'');
begin
  actor:=public.wellweb_actor();
  if actor.account_type<>'HOTEL' then raise exception 'Hotel account required'; end if;
  if p_rating not between 1 and 5 then raise exception 'Rating must be between 1 and 5'; end if;
  if clean_comment is not null and length(clean_comment)>500 then raise exception 'Comment must be at most 500 characters'; end if;
  if not exists(select 1 from public.professional_profiles p join public.app_users u on u.id=p.user_id
    where p.id=p_professional_profile_id and u.account_type='PROFESSIONAL') then raise exception 'Professional not found'; end if;
  select hm.hotel_id into v_hotel_id from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id
    where hm.user_id=actor.id and hm.hotel_id=p_hotel_id and hm.status='ACTIVE'
      and h.status='ACTIVE' and h.approval_status='APPROVED' limit 1;
  if v_hotel_id is null then raise exception 'An active approved hotel membership is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wellweb-review-'||v_hotel_id::text||'-'||p_professional_profile_id::text));
  select b.id into completed_booking_id from public.wellweb_bookings b
    where b.hotel_id=v_hotel_id and b.professional_profile_id=p_professional_profile_id and b.status='COMPLETED'
    order by coalesce(b.completed_at,b.ends_at) desc limit 1;
  if completed_booking_id is null then raise exception 'A completed reservation with this professional is required'; end if;
  select * into old_review from public.professional_reviews r
    where r.hotel_id=v_hotel_id and r.professional_profile_id=p_professional_profile_id
      and r.source_type='HOTEL' and r.status in ('PUBLISHED','HIDDEN') for update;
  if found and old_review.status='HIDDEN' then raise exception 'This review is hidden and cannot be edited'; end if;
  if found then
    update public.professional_reviews set booking_id=completed_booking_id,rating=p_rating,comment=clean_comment,
      submitted_by_user_id=actor.id where id=old_review.id returning id into review_id;
    insert into public.professional_review_audit(review_id,action,actor_user_id,previous_state,new_state)
      values(review_id,'HOTEL_EDITED',actor.id,jsonb_build_object('rating',old_review.rating,'comment',old_review.comment),
        jsonb_build_object('rating',p_rating,'comment',clean_comment));
  else
    insert into public.professional_reviews(professional_profile_id,booking_id,hotel_id,source_type,submitted_by_user_id,rating,comment)
      values(p_professional_profile_id,completed_booking_id,v_hotel_id,'HOTEL',actor.id,p_rating,clean_comment) returning id into review_id;
    insert into public.professional_review_audit(review_id,action,actor_user_id,new_state)
      values(review_id,'HOTEL_CREATED',actor.id,jsonb_build_object('rating',p_rating,'comment',clean_comment));
  end if;
  return review_id;
end;
$$;
revoke all on function public.hotel_save_professional_review(uuid,uuid,integer,text) from public,anon;
grant execute on function public.hotel_save_professional_review(uuid,uuid,integer,text) to authenticated;

create or replace function public.my_hotel_professional_review(p_professional_profile_id uuid,p_hotel_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare actor public.app_users%rowtype; v_hotel_id uuid; result jsonb;
begin
  actor:=public.wellweb_actor();
  if actor.account_type<>'HOTEL' then raise exception 'Hotel account required'; end if;
  select hm.hotel_id into v_hotel_id from public.hotel_members hm join public.hotels h on h.id=hm.hotel_id
    where hm.user_id=actor.id and hm.hotel_id=p_hotel_id and hm.status='ACTIVE'
      and h.status='ACTIVE' and h.approval_status='APPROVED' limit 1;
  if v_hotel_id is null then raise exception 'Active hotel membership required'; end if;
  if not exists(select 1 from public.wellweb_bookings b where b.hotel_id=v_hotel_id
    and b.professional_profile_id=p_professional_profile_id and b.status='COMPLETED') then
    return jsonb_build_object('eligible',false);
  end if;
  select jsonb_build_object('id',r.id,'rating',r.rating,'comment',r.comment,'status',r.status,'updated_at',r.updated_at)
    into result from public.professional_reviews r
    where r.hotel_id=v_hotel_id and r.professional_profile_id=p_professional_profile_id and r.source_type='HOTEL'
      and r.status in ('PUBLISHED','HIDDEN');
  return coalesce(result,'{}'::jsonb)||jsonb_build_object('eligible',true);
end;
$$;
revoke all on function public.my_hotel_professional_review(uuid,uuid) from public,anon;
grant execute on function public.my_hotel_professional_review(uuid,uuid) to authenticated;

create or replace function public.submit_guest_professional_review(
  p_token_hash text,p_request_id uuid,p_rating integer,p_comment text,p_source_ip text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare inv public.review_invitations%rowtype; booking public.wellweb_bookings%rowtype;
  source_digest bytea; rate_row wellweb_private.review_rate_limits%rowtype; secret bytea;
  review_id uuid; clean_comment text:=nullif(pg_catalog.btrim(p_comment),''); participant_limit integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend service role required'; end if;
  delete from wellweb_private.review_rate_limits where updated_at < statement_timestamp()-interval '24 hours';
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_request_id is null then
    return jsonb_build_object('ok',false,'code','UNAVAILABLE');
  end if;
  if p_source_ip is not null and pg_catalog.btrim(p_source_ip)<>'' then
    select s.secret into secret from wellweb_private.review_rate_secret s where s.singleton;
    source_digest:=extensions.hmac(convert_to(pg_catalog.left(pg_catalog.btrim(p_source_ip),128),'UTF8'),secret,'sha256');
    insert into wellweb_private.review_rate_limits as rate(source_digest,window_started_at,request_count)
      values(source_digest,statement_timestamp(),1)
      on conflict(source_digest) do update set
        window_started_at=case when rate.window_started_at<=statement_timestamp()-interval '1 hour' then statement_timestamp() else rate.window_started_at end,
        request_count=case when rate.window_started_at<=statement_timestamp()-interval '1 hour' then 1 else rate.request_count+1 end,
        updated_at=statement_timestamp()
      returning * into rate_row;
    if rate_row.request_count>20 then return jsonb_build_object('ok',false,'code','RATE_LIMIT'); end if;
  end if;
  if p_rating is null or p_rating not between 1 and 5 or (clean_comment is not null and length(clean_comment)>500) then
    return jsonb_build_object('ok',false,'code','INVALID_INPUT');
  end if;

  select * into inv from public.review_invitations where token_hash=p_token_hash;
  if not found then return jsonb_build_object('ok',false,'code','UNAVAILABLE'); end if;
  select * into booking from public.wellweb_bookings where id=inv.booking_id for update;
  if not found or booking.status<>'COMPLETED' then return jsonb_build_object('ok',false,'code','UNAVAILABLE'); end if;
  select * into inv from public.review_invitations where id=inv.id for update;
  if not found or inv.token_hash<>p_token_hash then return jsonb_build_object('ok',false,'code','UNAVAILABLE'); end if;
  select r.id into review_id from public.professional_reviews r
    where r.review_invitation_id=inv.id and r.idempotency_key=p_request_id;
  if review_id is not null then return jsonb_build_object('ok',true); end if;
  if inv.revoked_at is not null or statement_timestamp()>=inv.expires_at then
    return jsonb_build_object('ok',false,'code','UNAVAILABLE');
  end if;
  if statement_timestamp()>=coalesce(booking.completed_at,booking.ends_at)+interval '14 days' then
    return jsonb_build_object('ok',false,'code','UNAVAILABLE');
  end if;
  if not exists(select 1 from public.public_professional_directory d where d.id=booking.professional_profile_id) then
    return jsonb_build_object('ok',false,'code','UNAVAILABLE');
  end if;
  participant_limit:=coalesce(booking.students_count,booking.participants);
  if inv.submission_limit>participant_limit then return jsonb_build_object('ok',false,'code','UNAVAILABLE'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('wellweb-guest-review-'||booking.id::text));
  select count(*)::integer into inv.submission_count from public.professional_reviews r
    where r.booking_id=booking.id and r.source_type='GUEST';
  if inv.submission_count>=least(inv.submission_limit,participant_limit) then return jsonb_build_object('ok',false,'code','LIMIT_REACHED'); end if;
  insert into public.professional_reviews(professional_profile_id,booking_id,hotel_id,review_invitation_id,
    source_type,idempotency_key,rating,comment)
    values(booking.professional_profile_id,booking.id,booking.hotel_id,inv.id,'GUEST',p_request_id,p_rating,clean_comment)
    returning id into review_id;
  update public.review_invitations set submission_count=submission_count+1 where id=inv.id;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.submit_guest_professional_review(text,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.submit_guest_professional_review(text,uuid,integer,text,text) to service_role;

create or replace function public.get_guest_professional_review_context(p_token_hash text,p_source_ip text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare inv public.review_invitations%rowtype; booking public.wellweb_bookings%rowtype; remaining integer;
  profile_name text; profile_photo text; source_digest bytea; rate_row wellweb_private.review_rate_limits%rowtype; secret bytea;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend service role required'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('available',false); end if;
  delete from wellweb_private.review_rate_limits where updated_at < statement_timestamp()-interval '24 hours';
  if p_source_ip is not null and pg_catalog.btrim(p_source_ip)<>'' then
    select s.secret into secret from wellweb_private.review_rate_secret s where s.singleton;
    source_digest:=extensions.hmac(convert_to(pg_catalog.left(pg_catalog.btrim(p_source_ip),128),'UTF8'),secret,'sha256');
    insert into wellweb_private.review_rate_limits as rate(source_digest,window_started_at,request_count)
      values(source_digest,statement_timestamp(),1)
      on conflict(source_digest) do update set
        window_started_at=case when rate.window_started_at<=statement_timestamp()-interval '1 hour' then statement_timestamp() else rate.window_started_at end,
        request_count=case when rate.window_started_at<=statement_timestamp()-interval '1 hour' then 1 else rate.request_count+1 end,
        updated_at=statement_timestamp()
      returning * into rate_row;
    if rate_row.request_count>20 then return jsonb_build_object('available',false); end if;
  end if;
  select * into inv from public.review_invitations where token_hash=p_token_hash;
  if not found or inv.revoked_at is not null or statement_timestamp()>=inv.expires_at then return jsonb_build_object('available',false); end if;
  select * into booking from public.wellweb_bookings where id=inv.booking_id;
  if not found or booking.status<>'COMPLETED' or statement_timestamp()>=coalesce(booking.completed_at,booking.ends_at)+interval '14 days' then
    return jsonb_build_object('available',false);
  end if;
  select p.public_name,p.primary_photo_path into profile_name,profile_photo
    from public.public_professional_directory p where p.id=booking.professional_profile_id;
  if profile_name is null then return jsonb_build_object('available',false); end if;
  select greatest(0,least(inv.submission_limit,coalesce(booking.students_count,booking.participants))-
    (select count(*)::integer from public.professional_reviews r where r.booking_id=booking.id and r.source_type='GUEST')) into remaining;
  if remaining=0 then return jsonb_build_object('available',false); end if;
  return jsonb_build_object('available',true,'professional_name',profile_name,'photo_path',profile_photo,
    'service_name',booking.service_name_snapshot,'expires_at',least(inv.expires_at,coalesce(booking.completed_at,booking.ends_at)+interval '14 days'));
end;
$$;
revoke all on function public.get_guest_professional_review_context(text,text) from public,anon,authenticated;
grant execute on function public.get_guest_professional_review_context(text,text) to service_role;

create or replace function public.professional_report_review(p_review_id uuid,p_reason text,p_details text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare actor public.app_users%rowtype; profile_id uuid; report_id uuid; clean_details text:=nullif(pg_catalog.btrim(p_details),'');
begin
  actor:=public.wellweb_actor();
  if actor.account_type<>'PROFESSIONAL' then raise exception 'Professional account required'; end if;
  if p_reason not in ('OFFENSIVE','FALSE_INFORMATION','SPAM','PRIVACY','OTHER') then raise exception 'Invalid report reason'; end if;
  if clean_details is not null and length(clean_details)>500 then raise exception 'Report details must be at most 500 characters'; end if;
  select p.id into profile_id from public.professional_profiles p where p.user_id=actor.id;
  if profile_id is null then raise exception 'Professional profile required'; end if;
  if not exists(select 1 from public.professional_reviews r where r.id=p_review_id and r.professional_profile_id=profile_id and r.status='PUBLISHED') then
    raise exception 'Only a published review on your profile can be reported';
  end if;
  insert into public.professional_review_reports(review_id,reporter_professional_profile_id,reason,details)
    values(p_review_id,profile_id,p_reason,clean_details) returning id into report_id;
  return report_id;
end;
$$;
revoke all on function public.professional_report_review(uuid,text,text) from public,anon;
grant execute on function public.professional_report_review(uuid,text,text) to authenticated;

create or replace function public.admin_list_professional_reviews(
  p_professional_profile_id uuid default null,p_source_type text default null,p_status text default null
)
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  if p_source_type is not null and p_source_type not in ('GUEST','HOTEL') then raise exception 'Invalid source filter'; end if;
  if p_status is not null and p_status not in ('PUBLISHED','HIDDEN','INVALIDATED') then raise exception 'Invalid status filter'; end if;
  return query select jsonb_build_object('id',r.id,'professional_profile_id',r.professional_profile_id,
    'professional_name',p.public_name,'booking_reference',b.booking_reference,'hotel_id',r.hotel_id,'hotel_name',h.name,
    'source_type',r.source_type,'rating',r.rating,'comment',r.comment,'status',r.status,'created_at',r.created_at,'updated_at',r.updated_at)
    from public.professional_reviews r join public.professional_profiles p on p.id=r.professional_profile_id
      join public.wellweb_bookings b on b.id=r.booking_id join public.hotels h on h.id=r.hotel_id
    where (p_professional_profile_id is null or r.professional_profile_id=p_professional_profile_id)
      and (p_source_type is null or r.source_type=p_source_type) and (p_status is null or r.status=p_status)
    order by r.created_at desc limit 500;
end;
$$;
revoke all on function public.admin_list_professional_reviews(uuid,text,text) from public,anon;
grant execute on function public.admin_list_professional_reviews(uuid,text,text) to authenticated;

create or replace function public.admin_list_professional_review_reports()
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  return query select jsonb_build_object('id',d.id,'review_id',d.review_id,'rating',r.rating,'comment',r.comment,
    'professional_profile_id',d.reporter_professional_profile_id,'professional_name',p.public_name,
    'reason',d.reason,'details',d.details,'status',d.status,'created_at',d.created_at,
    'resolution_reason',d.resolution_reason)
    from public.professional_review_reports d join public.professional_reviews r on r.id=d.review_id
      join public.professional_profiles p on p.id=d.reporter_professional_profile_id
    order by (d.status='OPEN') desc,d.created_at desc limit 500;
end;
$$;
revoke all on function public.admin_list_professional_review_reports() from public,anon;
grant execute on function public.admin_list_professional_review_reports() to authenticated;

create or replace function public.admin_moderate_professional_review(p_review_id uuid,p_new_status text,p_reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor public.app_users%rowtype; old_review public.professional_reviews%rowtype;
begin
  actor:=public.wellweb_actor();
  if actor.account_type<>'ADMIN' then raise exception 'Administrator access required'; end if;
  if p_new_status not in ('PUBLISHED','HIDDEN','INVALIDATED') or nullif(pg_catalog.btrim(p_reason),'') is null or length(p_reason)>1000 then
    raise exception 'Valid moderation status and reason are required';
  end if;
  select * into old_review from public.professional_reviews where id=p_review_id for update;
  if not found then raise exception 'Review not found'; end if;
  if old_review.status=p_new_status then return; end if;
  update public.professional_reviews set status=p_new_status where id=p_review_id;
  insert into public.professional_review_audit(review_id,action,actor_user_id,previous_state,new_state,reason)
  values(p_review_id,case p_new_status when 'PUBLISHED' then 'ADMIN_RESTORED' when 'HIDDEN' then 'ADMIN_HIDDEN' else 'ADMIN_INVALIDATED' end,
    actor.id,jsonb_build_object('status',old_review.status),jsonb_build_object('status',p_new_status),pg_catalog.btrim(p_reason));
end;
$$;
revoke all on function public.admin_moderate_professional_review(uuid,text,text) from public,anon;
grant execute on function public.admin_moderate_professional_review(uuid,text,text) to authenticated;

create or replace function public.admin_resolve_professional_review_report(p_report_id uuid,p_status text,p_reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor public.app_users%rowtype; old_report public.professional_review_reports%rowtype;
begin
  actor:=public.wellweb_actor();
  if actor.account_type<>'ADMIN' then raise exception 'Administrator access required'; end if;
  if p_status not in ('REVIEWED','DISMISSED') or nullif(pg_catalog.btrim(p_reason),'') is null or length(p_reason)>1000 then
    raise exception 'Valid report decision and reason are required';
  end if;
  select * into old_report from public.professional_review_reports where id=p_report_id for update;
  if not found then raise exception 'Report not found'; end if;
  update public.professional_review_reports set status=p_status,resolved_at=statement_timestamp(),resolved_by=actor.id,
    resolution_reason=pg_catalog.btrim(p_reason) where id=p_report_id;
  insert into public.professional_review_audit(review_id,report_id,action,actor_user_id,
    previous_state,new_state,reason)
  values(old_report.review_id,p_report_id,'REPORT_RESOLVED',actor.id,
    jsonb_build_object('status',old_report.status),jsonb_build_object('status',p_status),pg_catalog.btrim(p_reason));
end;
$$;
revoke all on function public.admin_resolve_professional_review_report(uuid,text,text) from public,anon;
grant execute on function public.admin_resolve_professional_review_report(uuid,text,text) to authenticated;

create or replace function public.admin_list_review_invitations()
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  return query select jsonb_build_object('id',i.id,'booking_reference',b.booking_reference,
    'professional_profile_id',b.professional_profile_id,'professional_name',p.public_name,
    'expires_at',i.expires_at,'revoked_at',i.revoked_at,'submission_count',i.submission_count,'submission_limit',i.submission_limit)
    from public.review_invitations i join public.wellweb_bookings b on b.id=i.booking_id
      join public.professional_profiles p on p.id=b.professional_profile_id
    order by i.created_at desc limit 500;
end;
$$;
revoke all on function public.admin_list_review_invitations() from public,anon;
grant execute on function public.admin_list_review_invitations() to authenticated;

create or replace function public.admin_block_review_invitation(p_invitation_id uuid,p_reason text)
returns void language plpgsql security definer set search_path = ''
as $$
declare actor public.app_users%rowtype; inv public.review_invitations%rowtype;
begin
  actor:=public.wellweb_actor();
  if actor.account_type<>'ADMIN' then raise exception 'Administrator access required'; end if;
  if nullif(pg_catalog.btrim(p_reason),'') is null or length(p_reason)>1000 then raise exception 'A reason is required'; end if;
  select * into inv from public.review_invitations where id=p_invitation_id for update;
  if not found then raise exception 'Review link not found'; end if;
  if inv.revoked_at is not null then return; end if;
  update public.review_invitations set revoked_at=statement_timestamp() where id=inv.id;
  insert into public.professional_review_audit(invitation_id,action,actor_user_id,previous_state,new_state,reason)
  values(inv.id,'INVITATION_REVOKED',actor.id,jsonb_build_object('revoked_at',null),
    jsonb_build_object('revoked_at',statement_timestamp()),pg_catalog.btrim(p_reason));
end;
$$;
revoke all on function public.admin_block_review_invitation(uuid,text) from public,anon;
grant execute on function public.admin_block_review_invitation(uuid,text) to authenticated;

create or replace function public.admin_list_professional_review_audit(p_review_id uuid)
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  return query select jsonb_build_object('action',a.action,'actor_user_id',a.actor_user_id,
    'previous_state',a.previous_state,'new_state',a.new_state,'reason',a.reason,'created_at',a.created_at)
    from public.professional_review_audit a where a.review_id=p_review_id order by a.created_at desc;
end;
$$;
revoke all on function public.admin_list_professional_review_audit(uuid) from public,anon;
grant execute on function public.admin_list_professional_review_audit(uuid) to authenticated;

create or replace function public.wellweb_search_public_professionals_ranked(
  p_search text,p_city text,p_modality text,p_language text,p_has_material boolean,p_sort text,
  p_cursor_published_at timestamptz,p_cursor_id uuid,p_cursor_bayesian numeric,
  p_cursor_guest_average numeric,p_cursor_guest_count bigint,p_page_size integer
)
returns setof public.public_professional_directory language sql stable security invoker set search_path = ''
as $$
  select p.* from public.public_professional_directory p
  where (
      nullif(pg_catalog.btrim(p_search),'') is null
      or pg_catalog.strpos(pg_catalog.lower(pg_catalog.concat_ws(' ',p.public_name,p.city,p.service_area,
        p.description,pg_catalog.array_to_string(p.services,' '),pg_catalog.array_to_string(p.modalities,' '))),
        pg_catalog.lower(pg_catalog.btrim(p_search)))>0
    )
    and (nullif(pg_catalog.btrim(p_city),'') is null or pg_catalog.strpos(pg_catalog.lower(p.city),pg_catalog.lower(pg_catalog.btrim(p_city)))>0)
    and (nullif(pg_catalog.btrim(p_modality),'') is null or p.modalities @> array[p_modality]::text[])
    and (nullif(pg_catalog.btrim(p_language),'') is null or p.languages @> array[p_language]::text[])
    and (not coalesce(p_has_material,false) or exists(
      select 1 from pg_catalog.jsonb_array_elements(coalesce(p.service_details,'[]'::jsonb)) as svc(value)
      where svc.value->>'has_material'='true' and (
        nullif(pg_catalog.btrim(p_modality),'') is null or svc.value->>'modality_slug'=(
          select m.slug from public.modality_catalog m where m.active and m.name=p_modality limit 1))))
    and (p_sort in ('RECENT','BEST_RATED'))
    and (p_cursor_id is null
      or (p_sort='RECENT' and (p.published_at<p_cursor_published_at or (p.published_at=p_cursor_published_at and p.id>p_cursor_id)))
      or (p_sort='BEST_RATED' and case when coalesce(p_cursor_guest_count,0)=0 then
          coalesce(p.guest_rating_count,0)=0 and (p.published_at<p_cursor_published_at or (p.published_at=p_cursor_published_at and p.id>p_cursor_id))
        else coalesce(p.guest_rating_count,0)=0
          or p.guest_rating_bayesian<p_cursor_bayesian
          or (p.guest_rating_bayesian=p_cursor_bayesian and p.guest_rating_average<p_cursor_guest_average)
          or (p.guest_rating_bayesian=p_cursor_bayesian and p.guest_rating_average=p_cursor_guest_average and p.guest_rating_count<p_cursor_guest_count)
          or (p.guest_rating_bayesian=p_cursor_bayesian and p.guest_rating_average=p_cursor_guest_average and p.guest_rating_count=p_cursor_guest_count
            and (p.published_at<p_cursor_published_at or (p.published_at=p_cursor_published_at and p.id>p_cursor_id)))
        end))
  order by
    case when p_sort='BEST_RATED' and p.guest_rating_count>0 then 1 else 0 end desc,
    case when p_sort='BEST_RATED' then p.guest_rating_bayesian end desc nulls last,
    case when p_sort='BEST_RATED' then p.guest_rating_average end desc nulls last,
    case when p_sort='BEST_RATED' then p.guest_rating_count end desc nulls last,
    p.published_at desc,p.id asc
  limit (least(greatest(coalesce(p_page_size,10),1),30)+1);
$$;
revoke all on function public.wellweb_search_public_professionals_ranked(text,text,text,text,boolean,text,timestamptz,uuid,numeric,numeric,bigint,integer) from public;
grant execute on function public.wellweb_search_public_professionals_ranked(text,text,text,text,boolean,text,timestamptz,uuid,numeric,numeric,bigint,integer) to anon,authenticated;

notify pgrst,'reload schema';
commit;
