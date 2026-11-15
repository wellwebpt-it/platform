-- Build 5.4: filter the complete eligible public-professional set before
-- applying a stable keyset page. The source view remains the public allowlist.
begin;

create or replace function public.wellweb_search_public_professionals(
  p_search text,
  p_city text,
  p_modality text,
  p_language text,
  p_has_material boolean,
  p_cursor_published_at timestamptz,
  p_cursor_id uuid,
  p_page_size integer
)
returns setof public.public_professional_directory
language sql
stable
security invoker
set search_path = ''
as $$
  select p.*
  from public.public_professional_directory p
  where (
      nullif(pg_catalog.btrim(p_search), '') is null
      or pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.concat_ws(' ', p.public_name, p.city, p.service_area,
          p.description, pg_catalog.array_to_string(p.services, ' '),
          pg_catalog.array_to_string(p.modalities, ' '))),
        pg_catalog.lower(pg_catalog.btrim(p_search))) > 0
    )
    and (
      nullif(pg_catalog.btrim(p_city), '') is null
      or pg_catalog.strpos(pg_catalog.lower(p.city), pg_catalog.lower(pg_catalog.btrim(p_city))) > 0
    )
    and (nullif(pg_catalog.btrim(p_modality), '') is null or p.modalities @> array[p_modality]::text[])
    and (nullif(pg_catalog.btrim(p_language), '') is null or p.languages @> array[p_language]::text[])
    and (
      not coalesce(p_has_material, false)
      or exists (
        select 1
        from pg_catalog.jsonb_array_elements(coalesce(p.service_details, '[]'::jsonb)) as svc(value)
        where svc.value ->> 'has_material' = 'true'
          and (
            nullif(pg_catalog.btrim(p_modality), '') is null
            or svc.value ->> 'modality_slug' = (
              select m.slug from public.modality_catalog m
              where m.active and m.name = p_modality
              limit 1
            )
          )
      )
    )
    and (
      (p_cursor_published_at is null and p_cursor_id is null)
      or p.published_at < p_cursor_published_at
      or (p.published_at = p_cursor_published_at and p.id > p_cursor_id)
    )
  order by p.published_at desc, p.id asc
  limit (least(greatest(coalesce(p_page_size, 10), 1), 30) + 1);
$$;

revoke all on function public.wellweb_search_public_professionals(text,text,text,text,boolean,timestamptz,uuid,integer) from public;
grant execute on function public.wellweb_search_public_professionals(text,text,text,text,boolean,timestamptz,uuid,integer) to anon, authenticated;

notify pgrst, 'reload schema';
commit;
