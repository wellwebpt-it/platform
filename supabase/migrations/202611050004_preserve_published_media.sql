-- Keep media referenced by a currently published partner profile immutable
-- while profile edits wait for administrator review.
begin;

create or replace function public.wellweb_media_path_is_published(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.professional_profiles p
    join public.app_users u on u.id = p.user_id
    where p.is_public and p.approval_status = 'APPROVED'
      and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE'
      and (p.primary_photo_path = object_name or object_name = any(p.gallery_photo_paths))
  ) or exists (
    select 1 from public.hotels h
    where h.is_public and h.approval_status = 'APPROVED' and h.status = 'ACTIVE'
      and (h.primary_photo_path = object_name or object_name = any(h.gallery_photo_paths))
  );
$$;
revoke all on function public.wellweb_media_path_is_published(text) from public, anon;
grant execute on function public.wellweb_media_path_is_published(text) to authenticated;

drop policy "wellweb_profile_media_update_own" on storage.objects;
create policy "wellweb_profile_media_update_own"
on storage.objects for update to authenticated
using (
  bucket_id = 'wellweb-public-media'
  and (select public.can_manage_wellweb_media(name))
  and not (select public.wellweb_media_path_is_published(name))
)
with check (
  bucket_id = 'wellweb-public-media'
  and (select public.can_manage_wellweb_media(name))
  and not (select public.wellweb_media_path_is_published(name))
);

drop policy "wellweb_profile_media_delete_own" on storage.objects;
create policy "wellweb_profile_media_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'wellweb-public-media'
  and (select public.can_manage_wellweb_media(name))
  and not (select public.wellweb_media_path_is_published(name))
);

commit;
