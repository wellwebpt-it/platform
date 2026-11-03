
-- WellWeb
-- Migration: Account type integrity
-- Version: 202611030002

begin;

-- =========================================================
-- 1. VALIDATE HOTEL MEMBERSHIP
-- =========================================================
-- Only HOTEL accounts that are not suspended can be
-- associated with a hotel.

create or replace function public.validate_hotel_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  member_account_type public.account_type;
  member_account_status public.account_status;
begin
  select u.account_type, u.status
    into member_account_type, member_account_status
  from public.app_users u
  where u.id = new.user_id;

  if not found then
    raise exception 'Application user does not exist';
  end if;

  if member_account_type <> 'HOTEL' then
    raise exception 'Only HOTEL accounts can be associated with a hotel';
  end if;

  if member_account_status = 'SUSPENDED' then
    raise exception 'Suspended accounts cannot be associated with a hotel';
  end if;

  return new;
end;
$$;


-- =========================================================
-- 2. PREVENT INVALID ACCOUNT TYPE CHANGES
-- =========================================================
-- A HOTEL account cannot change to another account type
-- while it has an invited or active hotel membership.
-- Revoked memberships are retained as historical records.

create or replace function public.validate_account_type_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.account_type = 'HOTEL'
     and new.account_type <> 'HOTEL'
     and exists (
       select 1
       from public.hotel_members hm
       where hm.user_id = old.id
         and hm.status in ('INVITED', 'ACTIVE')
     )
  then
    raise exception
      'Cannot change account type while invited or active hotel memberships exist';
  end if;

  return new;
end;
$$;

create trigger app_users_validate_account_type_change
before update of account_type
on public.app_users
for each row
execute function public.validate_account_type_change();


-- =========================================================
-- 3. RESTRICT DIRECT EXECUTION OF SECURITY FUNCTIONS
-- =========================================================

revoke all on function public.validate_hotel_membership()
from public, anon, authenticated;

revoke all on function public.validate_account_type_change()
from public, anon, authenticated;

commit;
