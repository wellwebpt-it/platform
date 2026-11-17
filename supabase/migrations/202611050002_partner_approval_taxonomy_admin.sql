-- Partner approval, managed modality taxonomy and protected administration.
-- Existing public partners remain published; new registrations start pending.

begin;

create type public.partner_approval_status as enum ('PENDING', 'APPROVED', 'REJECTED');

alter table public.professional_profiles
  add column approval_status public.partner_approval_status not null default 'PENDING',
  add column pending_profile jsonb,
  add column languages text[] not null default '{}';

alter table public.hotels
  add column approval_status public.partner_approval_status not null default 'PENDING',
  add column pending_profile jsonb;

update public.professional_profiles
set approval_status = case when is_public then 'APPROVED'::public.partner_approval_status else 'PENDING'::public.partner_approval_status end;

update public.hotels
set approval_status = case when is_public then 'APPROVED'::public.partner_approval_status else 'PENDING'::public.partner_approval_status end;

alter table public.professional_profiles
  add constraint professional_profiles_languages_valid
  check (languages <@ array['pt','en','es','fr','it','de']::text[]);

create table public.modality_catalog (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null unique check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.modality_catalog (slug, name) values
  ('yoga', 'Yoga'), ('surf', 'Surf'), ('skate', 'Skate'), ('meditacao', 'Meditação'),
  ('mindfulness', 'Mindfulness'), ('massagem', 'Massagem'), ('reiki', 'Reiki'),
  ('respiracao', 'Respiração');

create table public.professional_modalities (
  professional_profile_id uuid not null references public.professional_profiles(id) on delete cascade,
  modality_slug text not null references public.modality_catalog(slug) on update cascade,
  created_at timestamptz not null default now(),
  primary key (professional_profile_id, modality_slug)
);

create index professional_modalities_slug_idx on public.professional_modalities (modality_slug, professional_profile_id);

-- Keep the existing service text intact as legacy data while introducing a
-- separate table for actual named offers (duration/price are optional).
create table public.professional_services (
  id uuid primary key default gen_random_uuid(),
  professional_profile_id uuid not null references public.professional_profiles(id) on delete cascade,
  name text not null check (length(trim(name)) > 0),
  description text,
  duration_minutes integer check (duration_minutes is null or duration_minutes between 1 and 1440),
  price numeric(10,2) check (price is null or price >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger professional_services_set_updated_at
before update on public.professional_services
for each row execute function public.set_updated_at();

insert into public.professional_services (professional_profile_id, name)
select p.id, trim(s.name)
from public.professional_profiles p
cross join lateral unnest(p.services) as s(name)
where length(trim(s.name)) > 0;

insert into public.professional_modalities (professional_profile_id, modality_slug)
select distinct p.id, m.slug
from public.professional_profiles p
cross join lateral unnest(p.services) as legacy(name)
join public.modality_catalog m on lower(trim(legacy.name)) = lower(m.name)
on conflict do nothing;

create table public.partner_review_events (
  id uuid primary key default gen_random_uuid(),
  partner_id uuid not null references public.app_users(id) on delete cascade,
  reviewer_id uuid not null references public.app_users(id),
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  note text,
  created_at timestamptz not null default now()
);

alter table public.modality_catalog enable row level security;
alter table public.professional_modalities enable row level security;
alter table public.professional_services enable row level security;
alter table public.partner_review_events enable row level security;

create or replace function public.is_wellweb_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.app_users u
    where u.auth_user_id = (select auth.uid())
      and u.account_type = 'ADMIN'
      and u.status = 'ACTIVE'
  );
$$;
revoke all on function public.is_wellweb_admin() from public, anon;
grant execute on function public.is_wellweb_admin() to authenticated;

create policy "read_active_modality_catalog"
on public.modality_catalog for select to anon, authenticated using (active);
create policy "admin_read_all_modalities"
on public.modality_catalog for select to authenticated using ((select public.is_wellweb_admin()));
grant select on public.modality_catalog to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.modality_catalog from anon, authenticated;

create policy "read_published_professional_modalities"
on public.professional_modalities for select to anon
using (exists (
  select 1 from public.professional_profiles p
  where p.id = professional_profile_id and p.is_public and p.approval_status = 'APPROVED'
));
create policy "read_own_or_published_professional_modalities"
on public.professional_modalities for select to authenticated
using (
  exists (
    select 1 from public.professional_profiles p
    join public.app_users u on u.id = p.user_id
    where p.id = professional_profile_id and (
      (p.is_public and p.approval_status = 'APPROVED') or
      (u.auth_user_id = (select auth.uid()) and u.status = 'ACTIVE')
    )
  ) or (select public.is_wellweb_admin())
);
grant select on public.professional_modalities to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.professional_modalities from anon, authenticated;

create policy "read_own_professional_services"
on public.professional_services for select to authenticated
using (exists (
  select 1 from public.professional_profiles p join public.app_users u on u.id = p.user_id
  where p.id = professional_profile_id and u.auth_user_id = (select auth.uid()) and u.status = 'ACTIVE'
));
create policy "admin_read_professional_services"
on public.professional_services for select to authenticated using ((select public.is_wellweb_admin()));
grant select on public.professional_services to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.professional_services from anon, authenticated;

create policy "admin_read_partner_review_events"
on public.partner_review_events for select to authenticated using ((select public.is_wellweb_admin()));
grant select on public.partner_review_events to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.partner_review_events from anon, authenticated;

-- Profile changes by approved partners are staged in pending_profile. The
-- currently published fields remain untouched until an administrator approves.
revoke update on public.professional_profiles from authenticated;
revoke update (city, service_area, bio, public_name, description, services, primary_photo_path,
  gallery_photo_paths, is_public, approval_status, pending_profile, languages)
  on public.professional_profiles from authenticated;
revoke update on public.hotels from authenticated;
revoke update (name, address_line1, address_line2, postal_code, city, country_code, timezone,
  legal_name, tax_number, description, public_contact_email, public_phone, website_url,
  primary_photo_path, gallery_photo_paths, is_public, approval_status, pending_profile)
  on public.hotels from authenticated;

create or replace function public.submit_wellweb_partner_profile(
  p_profile jsonb,
  p_modalities text[] default '{}',
  p_languages text[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.app_users%rowtype;
  v_profile public.professional_profiles%rowtype;
  v_hotel public.hotels%rowtype;
  v_hotel_id uuid;
  v_payload jsonb;
  v_status public.partner_approval_status;
begin
  select * into v_user from public.app_users u
  where u.auth_user_id = (select auth.uid()) and u.status = 'ACTIVE';
  if not found or v_user.account_type not in ('HOTEL', 'PROFESSIONAL') then
    raise exception 'An active partner account is required';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then raise exception 'Profile must be an object'; end if;

  if v_user.account_type = 'PROFESSIONAL' then
    select * into v_profile from public.professional_profiles p where p.user_id = v_user.id for update;
    if not found then raise exception 'Professional profile not found'; end if;
    if exists (select 1 from unnest(coalesce(p_modalities, '{}'::text[])) as chosen(slug) where not exists (
      select 1 from public.modality_catalog c where c.slug = chosen.slug and c.active
    )) then raise exception 'One or more modalities are unavailable'; end if;
    if exists (select 1 from unnest(coalesce(p_languages, '{}'::text[])) as chosen(code) where chosen.code <> all (array['pt','en','es','fr','it','de'])) then
      raise exception 'One or more languages are unavailable';
    end if;
    v_payload := jsonb_build_object(
      'public_name', coalesce(nullif(trim(p_profile->>'public_name'), ''), v_user.display_name),
      'city', coalesce(nullif(trim(p_profile->>'city'), ''), v_profile.city),
      'service_area', coalesce(nullif(trim(p_profile->>'service_area'), ''), v_profile.service_area),
      'bio', nullif(trim(p_profile->>'bio'), ''),
      'description', left(coalesce(p_profile->>'description', ''), 5000),
      'primary_photo_path', p_profile->'primary_photo_path',
      'gallery_photo_paths', coalesce(p_profile->'gallery_photo_paths', to_jsonb(v_profile.gallery_photo_paths)),
      'is_public', coalesce((p_profile->>'is_public')::boolean, false),
      'modalities', to_jsonb(coalesce(p_modalities, '{}'::text[])),
      'languages', to_jsonb(coalesce(p_languages, '{}'::text[]))
    );
    if jsonb_array_length(v_payload->'gallery_photo_paths') > 12 then raise exception 'Gallery limit exceeded'; end if;
    if v_profile.approval_status = 'APPROVED' then
      update public.professional_profiles set pending_profile = v_payload where id = v_profile.id;
    else
      update public.professional_profiles set
        public_name = v_payload->>'public_name', city = v_payload->>'city', service_area = v_payload->>'service_area',
        bio = v_payload->>'bio', description = v_payload->>'description',
        primary_photo_path = nullif(v_payload->>'primary_photo_path','null'),
        gallery_photo_paths = array(select jsonb_array_elements_text(v_payload->'gallery_photo_paths')),
        is_public = coalesce((v_payload->>'is_public')::boolean, false), approval_status = 'PENDING', pending_profile = null,
        languages = coalesce(p_languages, '{}'::text[])
      where id = v_profile.id;
      delete from public.professional_modalities where professional_profile_id = v_profile.id;
      insert into public.professional_modalities (professional_profile_id, modality_slug)
      select v_profile.id, chosen.slug from unnest(coalesce(p_modalities, '{}'::text[])) as chosen(slug);
    end if;
    return jsonb_build_object('approval_status', v_profile.approval_status, 'pending_review', v_profile.approval_status = 'APPROVED');
  end if;

  select hm.hotel_id into v_hotel_id from public.hotel_members hm
  where hm.user_id = v_user.id and hm.status = 'ACTIVE' limit 1;
  select * into v_hotel from public.hotels h where h.id = v_hotel_id for update;
  if not found then raise exception 'Hotel profile not found'; end if;
  v_payload := jsonb_build_object(
    'name', coalesce(nullif(trim(p_profile->>'name'), ''), v_hotel.name),
    'address_line1', coalesce(nullif(trim(p_profile->>'address_line1'), ''), v_hotel.address_line1),
    'city', coalesce(nullif(trim(p_profile->>'city'), ''), v_hotel.city),
    'description', left(coalesce(p_profile->>'description', ''), 5000),
    'public_contact_email', nullif(trim(p_profile->>'public_contact_email'), ''),
    'public_phone', nullif(trim(p_profile->>'public_phone'), ''),
    'website_url', nullif(trim(p_profile->>'website_url'), ''),
    'primary_photo_path', p_profile->'primary_photo_path',
    'gallery_photo_paths', coalesce(p_profile->'gallery_photo_paths', to_jsonb(v_hotel.gallery_photo_paths)),
    'is_public', coalesce((p_profile->>'is_public')::boolean, false)
  );
  if jsonb_array_length(v_payload->'gallery_photo_paths') > 12 then raise exception 'Gallery limit exceeded'; end if;
  if v_hotel.approval_status = 'APPROVED' then
    update public.hotels set pending_profile = v_payload where id = v_hotel.id;
  else
    update public.hotels set
      name = v_payload->>'name', address_line1 = v_payload->>'address_line1', city = v_payload->>'city',
      description = v_payload->>'description', public_contact_email = v_payload->>'public_contact_email',
      public_phone = v_payload->>'public_phone', website_url = v_payload->>'website_url',
      primary_photo_path = nullif(v_payload->>'primary_photo_path','null'),
      gallery_photo_paths = array(select jsonb_array_elements_text(v_payload->'gallery_photo_paths')),
      is_public = coalesce((v_payload->>'is_public')::boolean, false), approval_status = 'PENDING', pending_profile = null
    where id = v_hotel.id;
  end if;
  return jsonb_build_object('approval_status', v_hotel.approval_status, 'pending_review', v_hotel.approval_status = 'APPROVED');
end;
$$;
revoke all on function public.submit_wellweb_partner_profile(jsonb, text[], text[]) from public, anon;
grant execute on function public.submit_wellweb_partner_profile(jsonb, text[], text[]) to authenticated;

create or replace function public.admin_list_partner_reviews()
returns setof jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  return query
  select to_jsonb(x) from (
    select u.id as partner_id, u.account_type::text as account_type, u.email, u.display_name, u.phone_e164,
      p.approval_status::text as approval_status, p.is_public,
      jsonb_build_object('public_name', p.public_name, 'city', p.city, 'service_area', p.service_area,
        'bio', p.bio, 'description', p.description, 'services', coalesce((select jsonb_agg(s.name order by s.name)
          from public.professional_services s where s.professional_profile_id = p.id and s.active), '[]'::jsonb),
        'modalities', coalesce((select jsonb_agg(m.name order by m.name)
          from public.professional_modalities pm join public.modality_catalog m on m.slug = pm.modality_slug
          where pm.professional_profile_id = p.id), '[]'::jsonb), 'languages', to_jsonb(p.languages),
        'primary_photo_path', p.primary_photo_path, 'gallery_photo_paths', to_jsonb(p.gallery_photo_paths)) as profile,
      p.pending_profile, u.created_at
    from public.app_users u join public.professional_profiles p on p.user_id = u.id
    union all
    select u.id, u.account_type::text, u.email, u.display_name, u.phone_e164,
      h.approval_status::text, h.is_public,
      jsonb_build_object('name',h.name,'address_line1',h.address_line1,'city',h.city,'description',h.description,
        'public_contact_email',h.public_contact_email,'public_phone',h.public_phone,'website_url',h.website_url,
        'primary_photo_path',h.primary_photo_path,'gallery_photo_paths',to_jsonb(h.gallery_photo_paths)),
      h.pending_profile, u.created_at
    from public.app_users u join public.hotel_members hm on hm.user_id = u.id and hm.status = 'ACTIVE'
      join public.hotels h on h.id = hm.hotel_id
  ) x order by x.created_at desc;
end;
$$;
revoke all on function public.admin_list_partner_reviews() from public, anon;
grant execute on function public.admin_list_partner_reviews() to authenticated;

create or replace function public.admin_review_partner(p_partner_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reviewer uuid;
  v_user public.app_users%rowtype;
  v_prof public.professional_profiles%rowtype;
  v_hotel public.hotels%rowtype;
  v_hotel_id uuid;
  v_payload jsonb;
begin
  select id into v_reviewer from public.app_users where auth_user_id = (select auth.uid()) and account_type = 'ADMIN' and status = 'ACTIVE';
  if v_reviewer is null then raise exception 'Administrator access required'; end if;
  select * into v_user from public.app_users where id = p_partner_id and account_type in ('HOTEL','PROFESSIONAL');
  if not found then raise exception 'Partner not found'; end if;

  if v_user.account_type = 'PROFESSIONAL' then
    select * into v_prof from public.professional_profiles where user_id = v_user.id for update;
    if v_prof.pending_profile is not null and p_approve then
      v_payload := v_prof.pending_profile;
      update public.professional_profiles set
        public_name = v_payload->>'public_name', city = v_payload->>'city', service_area = v_payload->>'service_area',
        bio = v_payload->>'bio', description = v_payload->>'description',
        primary_photo_path = nullif(v_payload->>'primary_photo_path','null'),
        gallery_photo_paths = array(select jsonb_array_elements_text(v_payload->'gallery_photo_paths')),
        languages = array(select jsonb_array_elements_text(v_payload->'languages')),
        is_public = coalesce((v_payload->>'is_public')::boolean,false), pending_profile = null,
        approval_status = 'APPROVED' where id = v_prof.id;
      delete from public.professional_modalities where professional_profile_id = v_prof.id;
      insert into public.professional_modalities (professional_profile_id, modality_slug)
      select v_prof.id, chosen.slug from jsonb_array_elements_text(v_payload->'modalities') as chosen(slug);
    elsif v_prof.approval_status = 'PENDING' and p_approve then
      update public.professional_profiles set approval_status = 'APPROVED' where id = v_prof.id;
    elsif v_prof.approval_status = 'PENDING' and not p_approve then
      update public.professional_profiles set approval_status = 'REJECTED', is_public = false where id = v_prof.id;
    elsif v_prof.approval_status = 'APPROVED' and not p_approve then
      update public.professional_profiles set pending_profile = null where id = v_prof.id;
    else raise exception 'There is no reviewable change for this partner'; end if;
  else
    select hm.hotel_id into v_hotel_id from public.hotel_members hm where hm.user_id = v_user.id and hm.status = 'ACTIVE' limit 1;
    select * into v_hotel from public.hotels where id = v_hotel_id for update;
    if v_hotel.pending_profile is not null and p_approve then
      v_payload := v_hotel.pending_profile;
      update public.hotels set name=v_payload->>'name', address_line1=v_payload->>'address_line1', city=v_payload->>'city',
        description=v_payload->>'description', public_contact_email=v_payload->>'public_contact_email',
        public_phone=v_payload->>'public_phone', website_url=v_payload->>'website_url',
        primary_photo_path=nullif(v_payload->>'primary_photo_path','null'),
        gallery_photo_paths=array(select jsonb_array_elements_text(v_payload->'gallery_photo_paths')),
        is_public=coalesce((v_payload->>'is_public')::boolean,false), pending_profile=null,
        approval_status='APPROVED' where id=v_hotel.id;
    elsif v_hotel.approval_status = 'PENDING' and p_approve then
      update public.hotels set approval_status = 'APPROVED' where id = v_hotel.id;
    elsif v_hotel.approval_status = 'PENDING' and not p_approve then
      update public.hotels set approval_status = 'REJECTED', is_public = false where id = v_hotel.id;
    elsif v_hotel.approval_status = 'APPROVED' and not p_approve then
      update public.hotels set pending_profile = null where id = v_hotel.id;
    else raise exception 'There is no reviewable change for this partner'; end if;
  end if;

  insert into public.partner_review_events (partner_id, reviewer_id, decision, note)
  values (v_user.id, v_reviewer, case when p_approve then 'APPROVED' else 'REJECTED' end, nullif(left(trim(coalesce(p_note,'')),1000),''));
end;
$$;
revoke all on function public.admin_review_partner(uuid, boolean, text) from public, anon;
grant execute on function public.admin_review_partner(uuid, boolean, text) to authenticated;

create or replace function public.admin_add_wellweb_modality(p_slug text, p_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  insert into public.modality_catalog (slug, name)
  values (lower(trim(p_slug)), trim(p_name));
end;
$$;
revoke all on function public.admin_add_wellweb_modality(text, text) from public, anon;
grant execute on function public.admin_add_wellweb_modality(text, text) to authenticated;

create or replace function public.admin_set_wellweb_modality_active(p_slug text, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  update public.modality_catalog set active = p_active where slug = p_slug;
  if not found then raise exception 'Modality not found'; end if;
end;
$$;
revoke all on function public.admin_set_wellweb_modality_active(text, boolean) from public, anon;
grant execute on function public.admin_set_wellweb_modality_active(text, boolean) to authenticated;

-- Public directory access is gated in the database, even if a client calls a
-- view directly or attempts to toggle is_public itself.
drop view public.public_professional_directory;
drop view public.public_hotel_directory;
drop policy if exists "public_read_listed_professionals" on public.professional_profiles;
drop policy if exists "public_read_listed_hotels" on public.hotels;
drop policy if exists "public_read_active_professional_names" on public.app_users;
revoke select on public.app_users from anon;

create policy "public_read_listed_professionals"
on public.professional_profiles for select to anon
using (is_public and approval_status = 'APPROVED' and exists (
  select 1 from public.app_users u
  where u.id = professional_profiles.user_id and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE'
));

create policy "public_read_listed_hotels"
on public.hotels for select to anon
using (is_public and approval_status = 'APPROVED' and status = 'ACTIVE');

create view public.public_professional_directory with (security_barrier = true) as
select p.id, p.user_id, p.public_name, p.city, p.service_area, p.description,
  coalesce((select array_agg(s.name order by s.name) from public.professional_services s
    where s.professional_profile_id = p.id and s.active), '{}'::text[]) as services,
  coalesce((select array_agg(m.name order by m.name) from public.professional_modalities pm
    join public.modality_catalog m on m.slug = pm.modality_slug and m.active
    where pm.professional_profile_id = p.id), '{}'::text[]) as modalities,
  p.languages, p.primary_photo_path, p.gallery_photo_paths
from public.professional_profiles p
join public.app_users u on u.id = p.user_id
where p.is_public and p.approval_status = 'APPROVED' and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE';

create view public.public_hotel_directory with (security_barrier = true) as
select h.id, h.name, h.city, h.country_code, h.description, h.public_contact_email,
  h.public_phone, h.website_url, h.primary_photo_path, h.gallery_photo_paths
from public.hotels h
where h.is_public and h.approval_status = 'APPROVED' and h.status = 'ACTIVE';

grant select on public.public_professional_directory, public.public_hotel_directory to anon, authenticated;

notify pgrst, 'reload schema';
commit;
