create extension if not exists pgcrypto;
create type public.account_type as enum ('ADMIN','HOTEL','PROFESSIONAL');
create type public.account_status as enum ('INVITED','ACTIVE','SUSPENDED');
create type public.hotel_status as enum ('ACTIVE','INACTIVE','SUSPENDED');
create type public.membership_status as enum ('INVITED','ACTIVE','REVOKED');

create table public.app_users (
 id uuid primary key default gen_random_uuid(),
 auth_user_id uuid not null unique references auth.users(id) on delete cascade,
 email text not null, display_name text, phone_e164 text,
 account_type public.account_type not null,
 status public.account_status not null default 'INVITED',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.hotel_groups (
 id uuid primary key default gen_random_uuid(), name text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.hotels (
 id uuid primary key default gen_random_uuid(),
 group_id uuid references public.hotel_groups(id) on delete set null,
 name text not null, address_line1 text not null, address_line2 text,
 postal_code text, city text not null, country_code char(2) not null default 'PT',
 timezone text not null default 'Europe/Lisbon', legal_name text, tax_number text,
 status public.hotel_status not null default 'ACTIVE',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
-- Multiple individual accounts per hotel; identical functional access in MVP.
create table public.hotel_members (
 id uuid primary key default gen_random_uuid(),
 hotel_id uuid not null references public.hotels(id) on delete cascade,
 user_id uuid not null references public.app_users(id) on delete cascade,
 status public.membership_status not null default 'INVITED',
 invited_by uuid references public.app_users(id) on delete set null,
 joined_at timestamptz, created_at timestamptz not null default now(),
 constraint hotel_members_hotel_user_unique unique(hotel_id,user_id)
);
create index hotels_group_id_idx on public.hotels(group_id);
create index hotel_members_user_id_idx on public.hotel_members(user_id);
create index hotel_members_hotel_status_idx on public.hotel_members(hotel_id,status);

alter table public.app_users enable row level security;
alter table public.hotel_groups enable row level security;
alter table public.hotels enable row level security;
alter table public.hotel_members enable row level security;

create policy "users read own app user" on public.app_users for select to authenticated
using (auth.uid() = auth_user_id);
create policy "users read own memberships" on public.hotel_members for select to authenticated
using (exists(select 1 from public.app_users u where u.id=hotel_members.user_id and u.auth_user_id=auth.uid()));
-- No client write policies yet. Admin provisioning will use trusted backend functions.
