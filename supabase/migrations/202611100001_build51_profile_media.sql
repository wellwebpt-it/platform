-- Build 5.1: enforce media caps without deleting legacy media.
-- Existing profiles with more than 3 gallery images can still be viewed and
-- regularized by removing images. Only newly submitted gallery values are capped.
begin;

create or replace function public.enforce_wellweb_gallery_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  gallery_count integer;
begin
  gallery_count := coalesce(cardinality(new.gallery_photo_paths), 0);
  if gallery_count > 3 then
    raise exception 'A profile can have at most 3 gallery photos';
  end if;

  if new.pending_profile is not null then
    if jsonb_typeof(new.pending_profile->'gallery_photo_paths') = 'array'
       and jsonb_array_length(new.pending_profile->'gallery_photo_paths') > 3 then
      raise exception 'A profile can have at most 3 gallery photos';
    end if;
  end if;
  return new;
end;
$$;

create trigger professional_profiles_gallery_limit_build51
before insert or update of gallery_photo_paths, pending_profile on public.professional_profiles
for each row execute function public.enforce_wellweb_gallery_limit();

create trigger hotels_gallery_limit_build51
before insert or update of gallery_photo_paths, pending_profile on public.hotels
for each row execute function public.enforce_wellweb_gallery_limit();

create or replace function public.require_complete_professional_for_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_user public.app_users%rowtype;
begin
  if new.approval_status = 'APPROVED' then
    select * into profile_user from public.app_users where id = new.user_id;
    if not found
       or length(trim(coalesce(profile_user.display_name, ''))) < 2
       or length(trim(coalesce(profile_user.phone_e164, ''))) < 8
       or length(trim(coalesce(new.public_name, ''))) < 2
       or length(trim(coalesce(new.city, ''))) < 2
       or length(trim(coalesce(new.service_area, ''))) < 2
       or nullif(trim(coalesce(new.primary_photo_path, '')), '') is null
       or not exists (select 1 from storage.objects o where o.bucket_id='wellweb-public-media' and o.name=new.primary_photo_path) then
      raise exception 'Professional profile is incomplete; name, contact, location, service area and a primary photo are required';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.require_complete_professional_for_approval() from public, anon, authenticated;

create trigger professional_profiles_complete_before_approval
before update of approval_status on public.professional_profiles
for each row execute function public.require_complete_professional_for_approval();

notify pgrst, 'reload schema';
commit;
