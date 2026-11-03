
-- WellWeb
-- Migration: Immutable account type
-- Version: 202611030003

begin;

-- Remove the previous HOTEL-specific account type validation.
drop trigger if exists app_users_validate_account_type_change
on public.app_users;

drop function if exists public.validate_account_type_change();


-- Account type is permanent after account creation.
create or replace function public.prevent_account_type_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.account_type is distinct from old.account_type then
    raise exception
      'Account type is immutable and cannot be changed after account creation';
  end if;

  return new;
end;
$$;

create trigger app_users_immutable_account_type
before update of account_type
on public.app_users
for each row
execute function public.prevent_account_type_change();

-- Trigger functions are not intended to be called directly.
revoke all on function public.prevent_account_type_change()
from public, anon, authenticated;

commit;
