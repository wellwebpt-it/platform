-- The PL/pgSQL variable used for the rate-limit digest had the same name as
-- the table column, making INSERT/ON CONFLICT references ambiguous.
create or replace function public.submit_guest_professional_review(
  p_token_hash text,p_request_id uuid,p_rating integer,p_comment text,p_source_ip text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare inv public.review_invitations%rowtype; booking public.wellweb_bookings%rowtype;
  v_source_digest bytea; rate_row wellweb_private.review_rate_limits%rowtype; secret bytea;
  review_id uuid; clean_comment text:=nullif(pg_catalog.btrim(p_comment),''); participant_limit integer;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend service role required'; end if;
  delete from wellweb_private.review_rate_limits where updated_at < statement_timestamp()-interval '24 hours';
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_request_id is null then
    return jsonb_build_object('ok',false,'code','UNAVAILABLE');
  end if;
  if p_source_ip is not null and pg_catalog.btrim(p_source_ip)<>'' then
    select s.secret into secret from wellweb_private.review_rate_secret s where s.singleton;
    v_source_digest:=extensions.hmac(convert_to(pg_catalog.left(pg_catalog.btrim(p_source_ip),128),'UTF8'),secret,'sha256');
    insert into wellweb_private.review_rate_limits as rate(source_digest,window_started_at,request_count)
      values(v_source_digest,statement_timestamp(),1)
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
  profile_name text; profile_photo text; v_source_digest bytea; rate_row wellweb_private.review_rate_limits%rowtype; secret bytea;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Backend service role required'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then return jsonb_build_object('available',false); end if;
  delete from wellweb_private.review_rate_limits where updated_at < statement_timestamp()-interval '24 hours';
  if p_source_ip is not null and pg_catalog.btrim(p_source_ip)<>'' then
    select s.secret into secret from wellweb_private.review_rate_secret s where s.singleton;
    v_source_digest:=extensions.hmac(convert_to(pg_catalog.left(pg_catalog.btrim(p_source_ip),128),'UTF8'),secret,'sha256');
    insert into wellweb_private.review_rate_limits as rate(source_digest,window_started_at,request_count)
      values(v_source_digest,statement_timestamp(),1)
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
