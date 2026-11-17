-- Evaluate approved booking access without invoking the separate public-listing
-- RLS policies on hotels and professional_profiles from inside this policy.
create or replace function public.wellweb_hotel_can_read_professional_services(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_users hotel_user
    join public.hotel_members hm on hm.user_id = hotel_user.id and hm.status = 'ACTIVE'
    join public.hotels h on h.id = hm.hotel_id
    where hotel_user.auth_user_id = (select auth.uid())
      and hotel_user.account_type = 'HOTEL'
      and hotel_user.status = 'ACTIVE'
      and h.approval_status = 'APPROVED'
      and h.status = 'ACTIVE'
  )
  and exists (
    select 1
    from public.professional_profiles p
    join public.app_users pro_user on pro_user.id = p.user_id
    where p.id = p_profile_id
      and p.approval_status = 'APPROVED'
      and p.is_public
      and pro_user.account_type = 'PROFESSIONAL'
      and pro_user.status = 'ACTIVE'
  );
$$;

revoke all on function public.wellweb_hotel_can_read_professional_services(uuid) from public, anon;
grant execute on function public.wellweb_hotel_can_read_professional_services(uuid) to authenticated;

drop policy "approved_hotels_read_published_services" on public.professional_services;
create policy "approved_hotels_read_published_services"
on public.professional_services for select to authenticated
using (
  active
  and duration_minutes between 5 and 1440
  and (select public.wellweb_hotel_can_read_professional_services(professional_profile_id))
);
