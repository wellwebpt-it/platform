-- Build 5.1: auditable rejection reasons and a private email outbox.
begin;

create table public.partner_rejection_email_outbox (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.app_users(id) on delete cascade,
  reviewer_id uuid not null references public.app_users(id),
  recipient_email text not null,
  reason text not null check (length(trim(reason)) between 1 and 1000),
  status text not null default 'PENDING' check (status in ('PENDING','SENDING','SENT','FAILED')),
  attempts integer not null default 0 check (attempts>=0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index partner_rejection_email_outbox_partner_created_idx on public.partner_rejection_email_outbox(partner_id,created_at desc);
alter table public.partner_rejection_email_outbox enable row level security;
revoke all on public.partner_rejection_email_outbox from anon,authenticated;

create or replace function public.admin_reject_partner_with_reason(p_partner_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare reviewer uuid; recipient text; queue_id uuid;
begin
  select id into reviewer from public.app_users where auth_user_id=(select auth.uid()) and account_type='ADMIN' and status='ACTIVE';
  if reviewer is null then raise exception 'Administrator access required'; end if;
  if nullif(trim(p_reason),'') is null or length(trim(p_reason))>1000 then raise exception 'A rejection reason is required'; end if;
  select email into recipient from public.app_users where id=p_partner_id and account_type in ('HOTEL','PROFESSIONAL');
  if recipient is null then raise exception 'Partner email not found'; end if;
  perform public.admin_review_partner(p_partner_id,false,trim(p_reason));
  insert into public.partner_rejection_email_outbox(partner_id,reviewer_id,recipient_email,reason)
  values(p_partner_id,reviewer,recipient,trim(p_reason)) returning id into queue_id;
  return queue_id;
end;
$$;
revoke all on function public.admin_reject_partner_with_reason(uuid,text) from public,anon;
grant execute on function public.admin_reject_partner_with_reason(uuid,text) to authenticated;

create or replace function public.admin_list_partner_rejection_email(p_outbox_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  select jsonb_build_object('id',id,'status',status,'attempts',attempts,'last_error',last_error,'sent_at',sent_at)
    into result from public.partner_rejection_email_outbox where id=p_outbox_id;
  if result is null then raise exception 'Email record not found'; end if;
  return result;
end;
$$;
revoke all on function public.admin_list_partner_rejection_email(uuid) from public,anon;
grant execute on function public.admin_list_partner_rejection_email(uuid) to authenticated;

create or replace function public.admin_prepare_rejection_email_retry(p_outbox_id uuid)
returns text language plpgsql security definer set search_path = ''
as $$
declare current_status text;
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  update public.partner_rejection_email_outbox set status='FAILED',last_error='Envio interrompido; tentativa segura disponível.',updated_at=now()
  where id=p_outbox_id and status='SENDING' and updated_at<now()-interval '5 minutes';
  select status into current_status from public.partner_rejection_email_outbox where id=p_outbox_id;
  if current_status is null then raise exception 'Email record not found'; end if;
  return current_status;
end;
$$;
revoke all on function public.admin_prepare_rejection_email_retry(uuid) from public,anon;
grant execute on function public.admin_prepare_rejection_email_retry(uuid) to authenticated;

create or replace function public.admin_list_partner_reviews()
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  return query select to_jsonb(x) from (
    select u.id as partner_id,u.account_type::text as account_type,u.email,u.display_name,u.phone_e164,
      p.approval_status::text as approval_status,p.is_public,
      jsonb_build_object('public_name',p.public_name,'city',p.city,'service_area',p.service_area,'bio',p.bio,'description',p.description,
        'services',coalesce((select jsonb_agg(s.name order by s.name) from public.professional_services s where s.professional_profile_id=p.id and s.active),'[]'::jsonb),
        'modalities',coalesce((select jsonb_agg(m.name order by m.name) from public.professional_modalities pm join public.modality_catalog m on m.slug=pm.modality_slug where pm.professional_profile_id=p.id),'[]'::jsonb),
        'languages',to_jsonb(p.languages),'primary_photo_path',p.primary_photo_path,'gallery_photo_paths',to_jsonb(p.gallery_photo_paths),'is_public',p.is_public) as profile,
      p.pending_profile,u.created_at
    from public.app_users u join public.professional_profiles p on p.user_id=u.id
    union all
    select u.id,u.account_type::text,u.email,u.display_name,u.phone_e164,h.approval_status::text,h.is_public,
      jsonb_build_object('name',h.name,'address_line1',h.address_line1,'city',h.city,'description',h.description,
        'public_contact_email',h.public_contact_email,'public_phone',h.public_phone,'website_url',h.website_url,
        'primary_photo_path',h.primary_photo_path,'gallery_photo_paths',to_jsonb(h.gallery_photo_paths),'is_public',h.is_public),
      h.pending_profile,u.created_at
    from public.app_users u join public.hotel_members hm on hm.user_id=u.id and hm.status='ACTIVE' join public.hotels h on h.id=hm.hotel_id
  ) x order by x.created_at desc;
end;
$$;
revoke all on function public.admin_list_partner_reviews() from public,anon;
grant execute on function public.admin_list_partner_reviews() to authenticated;

notify pgrst, 'reload schema';
commit;
