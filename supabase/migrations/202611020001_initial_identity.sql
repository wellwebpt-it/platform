
-- WellWeb
-- Migration: Initial identity and hotel structure
-- Version: 202611020001

-- =========================================================
-- 1. ENUM TYPES
-- =========================================================

create type public.account_type as enum (
  'ADMIN',
  'HOTEL',
  'PROFESSIONAL'
);

create type public.account_status as enum (
  'INVITED',
  'ACTIVE',
  'SUSPENDED'
);

create type public.hotel_status as enum (
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED'
);

create type public.membership_status as enum (
  'INVITED',
  'ACTIVE',
  'REVOKED'
);

-- =========================================================
-- 2. TABLES
-- =========================================================

create table public.app_users (
  id uuid primary key default gen_random_uuid(),

  auth_user_id uuid not null unique
    references auth.users(id) on delete cascade,

  email text not null,
  display_name text,
  phone_e164 text,

  account_type public.account_type not null,
  status public.account_status not null default 'INVITED',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint app_users_email_not_blank
    check (length(trim(email)) > 0),

  constraint app_users_display_name_not_blank
    check (display_name is null or length(trim(display_name)) > 0)
);

create unique index app_users_email_lower_unique
  on public.app_users (lower(email));

create index app_users_account_type_status_idx
  on public.app_users (account_type, status);


create table public.hotel_groups (
  id uuid primary key default gen_random_uuid(),

  name text not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint hotel_groups_name_not_blank
    check (length(trim(name)) > 0)
);


create table public.hotels (
  id uuid primary key default gen_random_uuid(),

  group_id uuid
    references public.hotel_groups(id) on delete set null,

  name text not null,
  address_line1 text not null,
  address_line2 text,
  postal_code text,
  city text not null,

  country_code char(2) not null default 'PT',
  timezone text not null default 'Europe/Lisbon',

  legal_name text,
  tax_number text,

  status public.hotel_status not null default 'ACTIVE',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint hotels_name_not_blank
    check (length(trim(name)) > 0),

  constraint hotels_address_not_blank
    check (length(trim(address_line1)) > 0),

  constraint hotels_city_not_blank
    check (length(trim(city)) > 0),

  constraint hotels_country_code_format
    check (country_code ~ '^[A-Z]{2}$'),

  constraint hotels_timezone_not_blank
    check (length(trim(timezone)) > 0)
);


-- Multiple individual accounts per hotel.
-- All hotel members have identical functional permissions in MVP.
create table public.hotel_members (
  id uuid primary key default gen_random_uuid(),

  hotel_id uuid not null
    references public.hotels(id) on delete cascade,

  user_id uuid not null
    references public.app_users(id) on delete cascade,

  status public.membership_status not null default 'INVITED',

  invited_by uuid
    references public.app_users(id) on delete set null,

  joined_at timestamptz,
  created_at timestamptz not null default now(),

  constraint hotel_members_hotel_user_unique
    unique (hotel_id, user_id),

  constraint hotel_members_joined_at_consistency
    check (
      status <> 'ACTIVE'
      or joined_at is not null
    )
);

-- =========================================================
-- 3. INDEXES
-- =========================================================

create index hotels_group_id_idx
  on public.hotels(group_id);

create index hotels_status_idx
  on public.hotels(status);

create index hotel_members_user_id_idx
  on public.hotel_members(user_id);

create index hotel_members_hotel_status_idx
  on public.hotel_members(hotel_id, status);

create index hotel_members_invited_by_idx
  on public.hotel_members(invited_by);


-- =========================================================
-- 4. AUTOMATIC UPDATED_AT
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
for each row execute function public.set_updated_at();

create trigger hotel_groups_set_updated_at
before update on public.hotel_groups
for each row execute function public.set_updated_at();

create trigger hotels_set_updated_at
before update on public.hotels
for each row execute function public.set_updated_at();


-- =========================================================
-- 5. ROW LEVEL SECURITY
-- =========================================================

alter table public.app_users enable row level security;
alter table public.hotel_groups enable row level security;
alter table public.hotels enable row level security;
alter table public.hotel_members enable row level security;


-- Users can read their own application account.
create policy "users_read_own_app_user"
on public.app_users
for select
to authenticated
using (
  auth.uid() = auth_user_id
);


-- Users can read their own hotel memberships.
create policy "users_read_own_memberships"
on public.hotel_members
for select
to authenticated
using (
  exists (
    select 1
    from public.app_users u
    where u.id = hotel_members.user_id
      and u.auth_user_id = (select auth.uid())
  )
);


-- Active hotel members can read their own hotel.
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


-- Hotel members can read the group associated with their hotel.
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


-- =========================================================
-- 6. SECURITY NOTES
-- =========================================================

-- No direct INSERT, UPDATE or DELETE policies are created.
-- Client-side users cannot provision accounts, change account
-- types, manage hotel memberships or modify hotel records.
--
-- Administrative provisioning and management must be performed
-- through trusted backend functions.
--
-- Supabase service_role credentials must never be exposed
-- in the frontend.
--
-- Professional public profiles and approval workflows will
-- be implemented in subsequent migrations.
