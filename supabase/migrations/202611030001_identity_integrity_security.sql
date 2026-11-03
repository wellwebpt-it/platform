
-- WellWeb
-- Migration: Identity integrity and security improvements
-- Version: 202611030001
--
-- This migration extends the existing identity schema.
-- It does not recreate or delete existing tables.

begin;

-- =========================================================
-- 1. DATA INTEGRITY
-- =========================================================

alter table public.app_users
  add constraint app_users_email_not_blank
  check (length(trim(email)) > 0);

alter table public.app_users
  add constraint app_users_display_name_not_blank
  check (display_name is null or length(trim(display_name)) > 0);

create unique index app_users_email_lower_unique
  on public.app_users (lower(email));

alter table public.hotel_groups
  add constraint hotel_groups_name_not_blank
  check (length(trim(name)) > 0);

alter table public.hotels
  add constraint hotels_name_not_blank
  check (length(trim(name)) > 0);

alter table public.hotels
  add constraint hotels_address_not_blank
  check (length(trim(address_line1)) > 0);

alter table public.hotels
  add constraint hotels_city_not_blank
  check (length(trim(city)) > 0);

alter table public.hotels
  add constraint hotels_country_code_format
  check (country_code ~ '^[A-Z]{2}$');

alter table public.hotels
  add constraint hotels_timezone_not_blank
  check (length(trim(timezone)) > 0);

alter table public.hotel_members
  add constraint hotel_members_joined_at_consistency
  check (status <> 'ACTIVE' or joined_at is not null);


-- =========================================================
-- 2. HOTEL MEMBERSHIP ACCOUNT VALIDATION
-- =========================================================
-- Only HOTEL accounts can become hotel members.
-- PROFESSIONAL and ADMIN accounts cannot be associated
-- through hotel_members.

create or replace function public.validate_hotel_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_account_type public.account_type;
begin
  select u.account_type
    into member_account_type
  from public.app_users u
  where u.id = new.user_id;

  if member_account_type is null then
    raise exception 'Application user does not exist';
  end if;

  if member_account_type <> 'HOTEL' then
    raise exception 'Only HOTEL accounts can be associated with a hotel';
  end if;

  return new;
end;
$$;

create trigger hotel_members_validate_account
before insert or update of user_id
on public.hotel_members
for each row
execute function public.validate_hotel_membership();


-- =========================================================
-- 3. UPDATED_AT AUTOMATION
-- =========================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger app_users_set_updated_at
before update on public.app_users
for each row
execute function public.set_updated_at();

create trigger hotel_groups_set_updated_at
before update on public.hotel_groups
for each row
execute function public.set_updated_at();

create trigger hotels_set_updated_at
before update on public.hotels
for each row
execute function public.set_updated_at();


-- =========================================================
-- 4. READ ACCESS POLICIES
-- =========================================================

create policy "hotel_members_read_own_hotel"
on public.hotels
for select
to authenticated
using (
  exists (
    select 1
    from public.hotel_members hm
    join public.app_users u
      on u.id = hm.user_id
    where hm.hotel_id = hotels.id
      and u.auth_user_id = (select auth.uid())
      and u.status = 'ACTIVE'
      and hm.status = 'ACTIVE'
  )
);

create policy "hotel_members_read_own_group"
on public.hotel_groups
for select
to authenticated
using (
  exists (
    select 1
    from public.hotels h
    join public.hotel_members hm
      on hm.hotel_id = h.id
    join public.app_users u
      on u.id = hm.user_id
    where h.group_id = hotel_groups.id
      and u.auth_user_id = (select auth.uid())
      and u.status = 'ACTIVE'
      and hm.status = 'ACTIVE'
  )
);

commit;
