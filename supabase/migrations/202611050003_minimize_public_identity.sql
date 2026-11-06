-- The public directory only needs its profile id; an Auth-linked app user id
-- is not a public profile field. Remove it from both view and direct anon grants.
begin;

drop view public.public_professional_directory;
revoke select (user_id) on public.professional_profiles from anon;

create view public.public_professional_directory with (security_barrier = true) as
select p.id, p.public_name, p.city, p.service_area, p.description,
  coalesce((select array_agg(s.name order by s.name) from public.professional_services s
    where s.professional_profile_id = p.id and s.active), '{}'::text[]) as services,
  coalesce((select array_agg(m.name order by m.name) from public.professional_modalities pm
    join public.modality_catalog m on m.slug = pm.modality_slug and m.active
    where pm.professional_profile_id = p.id), '{}'::text[]) as modalities,
  p.languages, p.primary_photo_path, p.gallery_photo_paths
from public.professional_profiles p
join public.app_users u on u.id = p.user_id
where p.is_public and p.approval_status = 'APPROVED'
  and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE';

grant select on public.public_professional_directory to anon, authenticated;
notify pgrst, 'reload schema';
commit;
