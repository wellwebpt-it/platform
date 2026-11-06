-- Public hotel and professional directory, plus owner-managed profile media.
-- Forward-only: previously applied identity and registration migrations stay unchanged.

begin;

alter table public.professional_profiles
  add column public_name text not null default '',
  add column description text not null default '',
  add column services text[] not null default '{}'::text[],
  add column primary_photo_path text,
  add column gallery_photo_paths text[] not null default '{}'::text[],
  add column is_public boolean not null default false;

update public.professional_profiles p
set public_name = coalesce(nullif(trim(u.display_name), ''), 'Profissional')
from public.app_users u
where u.id = p.user_id;

alter table public.professional_profiles
  add constraint professional_profiles_public_name_not_blank check (length(trim(public_name)) > 0),
  add constraint professional_profiles_description_length check (length(description) <= 5000),
  add constraint professional_profiles_gallery_limit check (cardinality(gallery_photo_paths) <= 12);

alter table public.hotels
  add column description text not null default '',
  add column public_contact_email text,
  add column public_phone text,
  add column website_url text,
  add column primary_photo_path text,
  add column gallery_photo_paths text[] not null default '{}'::text[],
  add column is_public boolean not null default false;

alter table public.hotels
  add constraint hotels_description_length check (length(description) <= 5000),
  add constraint hotels_public_contact_email_format check (
    public_contact_email is null or public_contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ),
  add constraint hotels_website_url_format check (
    website_url is null or website_url ~ '^https?://[^[:space:]]+$'
  ),
  add constraint hotels_gallery_limit check (cardinality(gallery_photo_paths) <= 12);

-- Migration 202611040001 owns signup provisioning. This narrowly scoped trigger
-- copies only the professional's public name into the public profile row.
create or replace function public.set_professional_public_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.public_name := coalesce(
    nullif(trim(new.public_name), ''),
    (select nullif(trim(u.display_name), '') from public.app_users u where u.id = new.user_id),
    'Profissional'
  );
  return new;
end;
$$;

revoke all on function public.set_professional_public_name() from public, anon, authenticated;
create trigger professional_profiles_set_public_name
before insert on public.professional_profiles
for each row execute function public.set_professional_public_name();

create index hotels_public_city_idx on public.hotels (city) where is_public and status = 'ACTIVE';
create index professional_profiles_public_city_idx
  on public.professional_profiles (city) where is_public;
create index professional_profiles_services_idx
  on public.professional_profiles using gin (services) where is_public;

-- Expose only active, explicitly published records. Row policies remain the
-- authority; grants below also prevent accidental access to private hotel fields.
create policy "public_read_listed_hotels"
on public.hotels for select to anon
using (is_public and status = 'ACTIVE');

create policy "public_read_listed_professionals"
on public.professional_profiles for select to anon
using (
  is_public
  and exists (
    select 1 from public.app_users u
    where u.id = professional_profiles.user_id
      and u.account_type = 'PROFESSIONAL'
      and u.status = 'ACTIVE'
  )
);

create policy "public_read_active_professional_names"
on public.app_users for select to anon
using (account_type = 'PROFESSIONAL' and status = 'ACTIVE');

revoke select on public.hotels from anon;
grant select (
  id, name, description, city, country_code, public_contact_email, public_phone,
  website_url, primary_photo_path, gallery_photo_paths, is_public
) on public.hotels to anon;

revoke select on public.app_users from anon;
grant select (id, display_name, account_type, status) on public.app_users to anon;

revoke select on public.professional_profiles from anon;
grant select (
  id, user_id, public_name, city, service_area, description, services,
  primary_photo_path, gallery_photo_paths, is_public
) on public.professional_profiles to anon;
revoke insert, update, delete, truncate, references, trigger on public.professional_profiles from anon;
revoke insert, update, delete, truncate, references, trigger on public.hotels from anon;
revoke insert, update, delete, truncate, references, trigger on public.app_users from anon;
grant update (
  public_name, description, services, primary_photo_path, gallery_photo_paths, is_public, city, service_area, bio
) on public.professional_profiles to authenticated;
grant update (
  description, public_contact_email, public_phone, website_url,
  primary_photo_path, gallery_photo_paths, is_public
) on public.hotels to authenticated;

-- Directory views expose only fields intentionally marked public. They use the
-- migration owner for the underlying reads; direct authenticated table reads
-- remain limited by the existing owner/membership RLS policies.
create view public.public_professional_directory with (security_barrier = true) as
select
  p.id, p.user_id, p.public_name, p.city, p.service_area, p.description, p.services,
  p.primary_photo_path, p.gallery_photo_paths
from public.professional_profiles p
join public.app_users u on u.id = p.user_id
where p.is_public and u.account_type = 'PROFESSIONAL' and u.status = 'ACTIVE';

create view public.public_hotel_directory with (security_barrier = true) as
select
  h.id, h.name, h.city, h.country_code, h.description, h.public_contact_email,
  h.public_phone, h.website_url, h.primary_photo_path, h.gallery_photo_paths
from public.hotels h
where h.is_public and h.status = 'ACTIVE';

grant select on public.public_professional_directory, public.public_hotel_directory to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'wellweb-public-media',
  'wellweb-public-media',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_manage_wellweb_media(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_users u
    where u.auth_user_id = (select auth.uid())
      and u.status = 'ACTIVE'
      and (storage.foldername(object_name))[2] = u.auth_user_id::text
      and (
        (u.account_type = 'PROFESSIONAL' and (storage.foldername(object_name))[1] = 'professionals')
        or
        (u.account_type = 'HOTEL'
          and (storage.foldername(object_name))[1] = 'hotels'
          and exists (
            select 1 from public.hotel_members hm
            join public.hotels h on h.id = hm.hotel_id
            where hm.user_id = u.id and hm.status = 'ACTIVE' and h.status = 'ACTIVE'
          ))
      )
  );
$$;
revoke all on function public.can_manage_wellweb_media(text) from public, anon, authenticated;
grant execute on function public.can_manage_wellweb_media(text) to authenticated;

create policy "wellweb_profile_media_insert_own"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'wellweb-public-media'
  and (select public.can_manage_wellweb_media(name))
);

create policy "wellweb_profile_media_update_own"
on storage.objects for update to authenticated
using (
  bucket_id = 'wellweb-public-media'
  and (select public.can_manage_wellweb_media(name))
)
with check (
  bucket_id = 'wellweb-public-media'
  and (select public.can_manage_wellweb_media(name))
);

create policy "wellweb_profile_media_delete_own"
on storage.objects for delete to authenticated
using (
  bucket_id = 'wellweb-public-media'
  and (select public.can_manage_wellweb_media(name))
);

notify pgrst, 'reload schema';

commit;
