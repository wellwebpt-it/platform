-- WellWeb MVP 1.0: trusted signup provisioning and private profile management.
-- Forward-only: the four production migrations already applied are unchanged.

begin;

create table public.professional_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.app_users(id) on delete cascade,
  city text not null,
  service_area text not null,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint professional_profiles_city_not_blank check (length(trim(city)) > 0),
  constraint professional_profiles_service_area_not_blank check (length(trim(service_area)) > 0)
);

create trigger professional_profiles_set_updated_at
before update on public.professional_profiles
for each row execute function public.set_updated_at();

alter table public.professional_profiles enable row level security;

create policy "professionals_read_own_profile"
on public.professional_profiles for select to authenticated
using (exists (
  select 1 from public.app_users u
  where u.id = professional_profiles.user_id
    and u.auth_user_id = (select auth.uid())
    and u.account_type = 'PROFESSIONAL'
    and u.status = 'ACTIVE'
));

create policy "professionals_update_own_profile"
on public.professional_profiles for update to authenticated
using (exists (
  select 1 from public.app_users u
  where u.id = professional_profiles.user_id
    and u.auth_user_id = (select auth.uid())
    and u.account_type = 'PROFESSIONAL'
    and u.status = 'ACTIVE'
))
with check (exists (
  select 1 from public.app_users u
  where u.id = professional_profiles.user_id
    and u.auth_user_id = (select auth.uid())
    and u.account_type = 'PROFESSIONAL'
    and u.status = 'ACTIVE'
));

grant select on public.professional_profiles to authenticated;
revoke insert, delete, truncate, references, trigger on public.professional_profiles from anon, authenticated;
revoke update on public.professional_profiles from anon, authenticated;
grant update (city, service_area, bio) on public.professional_profiles to authenticated;

-- Keep hotel reads limited to an active account and membership, and require the
-- same relationship for edits. The client can never set hotel status/group_id.
drop policy if exists "hotel_members_read_own_hotel" on public.hotels;
create policy "hotel_members_read_own_hotel"
on public.hotels for select to authenticated
using (status = 'ACTIVE' and exists (
  select 1
  from public.hotel_members hm
  join public.app_users u on u.id = hm.user_id
  where hm.hotel_id = hotels.id
    and u.auth_user_id = (select auth.uid())
    and u.account_type = 'HOTEL'
    and u.status = 'ACTIVE'
    and hm.status = 'ACTIVE'
));

create policy "hotel_members_update_own_hotel"
on public.hotels for update to authenticated
using (status = 'ACTIVE' and exists (
  select 1
  from public.hotel_members hm
  join public.app_users u on u.id = hm.user_id
  where hm.hotel_id = hotels.id
    and u.auth_user_id = (select auth.uid())
    and u.account_type = 'HOTEL'
    and u.status = 'ACTIVE'
    and hm.status = 'ACTIVE'
))
with check (status = 'ACTIVE' and exists (
  select 1
  from public.hotel_members hm
  join public.app_users u on u.id = hm.user_id
  where hm.hotel_id = hotels.id
    and u.auth_user_id = (select auth.uid())
    and u.account_type = 'HOTEL'
    and u.status = 'ACTIVE'
    and hm.status = 'ACTIVE'
));

grant select on public.hotels, public.hotel_members to authenticated;
revoke insert, delete, truncate, references, trigger on public.hotels from anon, authenticated;
revoke update on public.hotels from anon, authenticated;
grant update (name, address_line1, address_line2, postal_code, city, country_code, timezone, legal_name, tax_number)
  on public.hotels to authenticated;

-- App identity and account_type are provisioned here, outside client control.
drop policy if exists "users_update_own_active_profile" on public.app_users;
create policy "users_update_own_active_profile"
on public.app_users for update to authenticated
using (
  auth_user_id = (select auth.uid())
  and status = 'ACTIVE'
  and account_type in ('HOTEL', 'PROFESSIONAL')
)
with check (
  auth_user_id = (select auth.uid())
  and status = 'ACTIVE'
  and account_type in ('HOTEL', 'PROFESSIONAL')
);

grant select on public.app_users to authenticated;
revoke insert, delete, truncate, references, trigger on public.app_users from anon, authenticated;
revoke update on public.app_users from anon, authenticated;
grant update (display_name, phone_e164) on public.app_users to authenticated;

create or replace function public.provision_wellweb_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_name text;
  v_email text;
  v_phone text;
  v_city text;
  v_app_user_id uuid;
  v_hotel_id uuid;
begin
  -- Other trusted Auth flows are not WellWeb public registrations.
  if new.raw_user_meta_data ->> 'wellweb_signup' is distinct from 'true' then
    return new;
  end if;

  v_type := new.raw_user_meta_data ->> 'account_type';
  v_name := nullif(trim(new.raw_user_meta_data ->> 'display_name'), '');
  v_email := nullif(trim(new.email), '');
  v_phone := nullif(trim(new.raw_user_meta_data ->> 'phone_e164'), '');
  v_city := nullif(trim(new.raw_user_meta_data ->> 'city'), '');

  if v_type not in ('HOTEL', 'PROFESSIONAL') then
    raise exception 'Invalid WellWeb account type';
  end if;
  if v_name is null or v_email is null or v_city is null
     or v_phone is null or v_phone !~ '^[+][1-9][0-9]{7,14}$' then
    raise exception 'WellWeb registration details are incomplete';
  end if;

  insert into public.app_users (auth_user_id, email, display_name, phone_e164, account_type, status)
  values (new.id, v_email, v_name, v_phone, v_type::public.account_type, 'ACTIVE')
  returning id into v_app_user_id;

  if v_type = 'HOTEL' then
    if nullif(trim(new.raw_user_meta_data ->> 'hotel_name'), '') is null
       or nullif(trim(new.raw_user_meta_data ->> 'address_line1'), '') is null then
      raise exception 'Hotel registration details are incomplete';
    end if;
    insert into public.hotels (name, address_line1, city)
    values (trim(new.raw_user_meta_data ->> 'hotel_name'), trim(new.raw_user_meta_data ->> 'address_line1'), v_city)
    returning id into v_hotel_id;

    insert into public.hotel_members (hotel_id, user_id, status, joined_at)
    values (v_hotel_id, v_app_user_id, 'ACTIVE', now());
  else
    if nullif(trim(new.raw_user_meta_data ->> 'service_area'), '') is null then
      raise exception 'Professional registration details are incomplete';
    end if;
    insert into public.professional_profiles (user_id, city, service_area, bio)
    values (v_app_user_id, v_city, trim(new.raw_user_meta_data ->> 'service_area'), nullif(trim(new.raw_user_meta_data ->> 'bio'), ''));
  end if;

  return new;
end;
$$;

revoke all on function public.provision_wellweb_auth_user() from public, anon, authenticated;
drop trigger if exists wellweb_auth_user_provision on auth.users;
create trigger wellweb_auth_user_provision
after insert on auth.users
for each row execute function public.provision_wellweb_auth_user();

commit;
