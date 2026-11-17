-- Build 5.1: stage edits to approved services and availability for one atomic review.
begin;
alter table public.professional_profiles add column pending_configuration jsonb;

create or replace function public.wellweb_base_professional_configuration(p_profile_id uuid)
returns jsonb language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'services',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'description',s.description,'modality_slug',s.modality_slug,
      'duration_minutes',s.duration_minutes,'price',s.price,'currency',s.currency,'active',s.active,'has_material',s.has_material,
      'allows_group',s.allows_group,'max_students',s.max_students,'price_per_student',s.price_per_student) order by s.name)
      from public.professional_services s where s.professional_profile_id=p_profile_id),'[]'::jsonb),
    'weekly',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'day_of_week',a.day_of_week,'start_time',a.start_time,'end_time',a.end_time) order by a.day_of_week,a.start_time)
      from public.professional_weekly_availability a where a.professional_profile_id=p_profile_id),'[]'::jsonb),
    'overrides',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'starts_at',o.starts_at,'ends_at',o.ends_at,'override_type',o.override_type::text,'reason',o.reason) order by o.starts_at)
      from public.professional_availability_overrides o where o.professional_profile_id=p_profile_id),'[]'::jsonb)
  );
$$;
revoke all on function public.wellweb_base_professional_configuration(uuid) from public,anon,authenticated;

-- Replace the service RPC to write a proposal when the profile is published.
create or replace function public.save_wellweb_professional_service(
  p_service_id uuid,p_name text,p_description text,p_modality_slug text,p_duration_minutes integer,p_price numeric,p_active boolean,
  p_has_material boolean default false,p_allows_group boolean default false,p_max_students integer default null,p_price_per_student boolean default false
)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb; sid uuid; item jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage services'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update;
  if not found then raise exception 'Professional profile not found'; end if;
  if nullif(trim(p_name),'') is null or length(trim(p_name))>120 or p_duration_minutes is null or p_duration_minutes not between 5 and 1440 then raise exception 'Invalid service name or duration'; end if;
  if p_price is not null and p_price<0 then raise exception 'Invalid service price'; end if;
  if p_modality_slug is not null and not exists(select 1 from public.modality_catalog where slug=p_modality_slug and active) then raise exception 'Selected modality is unavailable'; end if;
  if coalesce(p_allows_group,false) and p_max_students not between 1 and 100 then raise exception 'Group services require capacity from 1 to 100'; end if;
  if not coalesce(p_allows_group,false) and p_max_students is not null then raise exception 'Individual service cannot have group capacity'; end if;
  if coalesce(p_price_per_student,false) and not coalesce(p_allows_group,false) then raise exception 'Per-student price requires a group service'; end if;
  sid:=coalesce(p_service_id,gen_random_uuid());
  if p.approval_status='APPROVED' then
    cfg:=coalesce(p.pending_configuration,public.wellweb_base_professional_configuration(p.id));
    item:=jsonb_build_object('id',sid,'name',trim(p_name),'description',nullif(trim(p_description),''),'modality_slug',p_modality_slug,
      'duration_minutes',p_duration_minutes,'price',p_price,'currency','EUR','active',coalesce(p_active,true),'has_material',coalesce(p_has_material,false),
      'allows_group',coalesce(p_allows_group,false),'max_students',case when p_allows_group then p_max_students else null end,'price_per_student',coalesce(p_price_per_student,false));
    if p_service_id is not null and not exists(select 1 from jsonb_array_elements(cfg->'services') e where e->>'id'=sid::text) then raise exception 'Service not found'; end if;
    cfg:=jsonb_set(cfg,'{services}',case when p_service_id is null then (cfg->'services')||jsonb_build_array(item) else
      (select coalesce(jsonb_agg(case when e->>'id'=sid::text then item else e end),'[]'::jsonb) from jsonb_array_elements(cfg->'services') e) end);
    update public.professional_profiles set pending_configuration=cfg where id=p.id;
  else
    if p_service_id is null then
      insert into public.professional_services(id,professional_profile_id,name,description,modality_slug,duration_minutes,price,currency,active,has_material,allows_group,max_students,price_per_student)
      values(sid,p.id,trim(p_name),nullif(trim(p_description),''),p_modality_slug,p_duration_minutes,p_price,'EUR',coalesce(p_active,true),coalesce(p_has_material,false),coalesce(p_allows_group,false),case when p_allows_group then p_max_students else null end,coalesce(p_price_per_student,false));
    else
      update public.professional_services set name=trim(p_name),description=nullif(trim(p_description),''),modality_slug=p_modality_slug,duration_minutes=p_duration_minutes,
        price=p_price,active=coalesce(p_active,false),has_material=coalesce(p_has_material,false),allows_group=coalesce(p_allows_group,false),max_students=case when p_allows_group then p_max_students else null end,price_per_student=coalesce(p_price_per_student,false)
      where id=p_service_id and professional_profile_id=p.id;
      if not found then raise exception 'Service not found'; end if;
    end if;
  end if;
  return sid;
end;
$$;
revoke all on function public.save_wellweb_professional_service(uuid,text,text,text,integer,numeric,boolean,boolean,boolean,integer,boolean) from public,anon;
grant execute on function public.save_wellweb_professional_service(uuid,text,text,text,integer,numeric,boolean,boolean,boolean,integer,boolean) to authenticated;

create or replace function public.save_wellweb_weekly_availability(p_slot_id uuid,p_day_of_week smallint,p_start_time time,p_end_time time)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb; sid uuid; item jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  if p_day_of_week is null or p_day_of_week not between 0 and 6 or p_start_time is null or p_end_time is null or p_end_time<=p_start_time then raise exception 'Invalid weekly interval'; end if;
  if extract(minute from p_start_time)::int%15<>0 or extract(minute from p_end_time)::int%15<>0 or extract(second from p_start_time)<>0 or extract(second from p_end_time)<>0 then raise exception 'Times must use 15-minute increments'; end if;
  sid:=coalesce(p_slot_id,gen_random_uuid()); item:=jsonb_build_object('id',sid,'day_of_week',p_day_of_week,'start_time',p_start_time,'end_time',p_end_time);
  if p.approval_status='APPROVED' then
    cfg:=coalesce(p.pending_configuration,public.wellweb_base_professional_configuration(p.id));
    if p_slot_id is not null and not exists(select 1 from jsonb_array_elements(cfg->'weekly') e where e->>'id'=sid::text) then raise exception 'Availability interval not found'; end if;
    if exists(select 1 from jsonb_array_elements(cfg->'weekly') e where e->>'id'<>sid::text and (e->>'day_of_week')::int=p_day_of_week and p_start_time<(e->>'end_time')::time and p_end_time>(e->>'start_time')::time) then raise exception 'Weekly intervals cannot overlap'; end if;
    cfg:=jsonb_set(cfg,'{weekly}',case when p_slot_id is null then (cfg->'weekly')||jsonb_build_array(item) else (select coalesce(jsonb_agg(case when e->>'id'=sid::text then item else e end),'[]'::jsonb) from jsonb_array_elements(cfg->'weekly') e) end);
    update public.professional_profiles set pending_configuration=cfg where id=p.id;
  else
    if exists(select 1 from public.professional_weekly_availability x where x.professional_profile_id=p.id and x.day_of_week=p_day_of_week and x.id is distinct from p_slot_id and p_start_time<x.end_time and p_end_time>x.start_time) then raise exception 'Weekly intervals cannot overlap'; end if;
    if p_slot_id is null then insert into public.professional_weekly_availability(id,professional_profile_id,day_of_week,start_time,end_time) values(sid,p.id,p_day_of_week,p_start_time,p_end_time);
    else update public.professional_weekly_availability set day_of_week=p_day_of_week,start_time=p_start_time,end_time=p_end_time where id=p_slot_id and professional_profile_id=p.id; if not found then raise exception 'Availability interval not found'; end if; end if;
  end if;
  return sid;
end;
$$;
revoke all on function public.save_wellweb_weekly_availability(uuid,smallint,time,time) from public,anon;
grant execute on function public.save_wellweb_weekly_availability(uuid,smallint,time,time) to authenticated;

create or replace function public.delete_wellweb_weekly_availability(p_slot_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  if p.approval_status='APPROVED' then
    cfg:=coalesce(p.pending_configuration,public.wellweb_base_professional_configuration(p.id));
    if not exists(select 1 from jsonb_array_elements(cfg->'weekly') e where e->>'id'=p_slot_id::text) then raise exception 'Availability interval not found'; end if;
    cfg:=jsonb_set(cfg,'{weekly}',(select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(cfg->'weekly') e where e->>'id'<>p_slot_id::text));
    update public.professional_profiles set pending_configuration=cfg where id=p.id;
  else delete from public.professional_weekly_availability where id=p_slot_id and professional_profile_id=p.id; if not found then raise exception 'Availability interval not found'; end if; end if;
end;
$$;
revoke all on function public.delete_wellweb_weekly_availability(uuid) from public,anon;
grant execute on function public.delete_wellweb_weekly_availability(uuid) to authenticated;

-- Approved profile overrides are staged too; AVAILABLE and BLOCKED may overlap intentionally.
create or replace function public.save_wellweb_availability_override(p_override_id uuid,p_starts_at timestamptz,p_ends_at timestamptz,p_override_type public.wellweb_availability_override_type,p_reason text)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb; oid uuid; item jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  if p_starts_at is null or p_ends_at is null or p_override_type is null or p_ends_at<=p_starts_at or p_ends_at-p_starts_at>interval '31 days' then raise exception 'Invalid exception interval'; end if;
  if p_reason is not null and length(p_reason)>500 then raise exception 'Reason is too long'; end if;
  if p_override_type='BLOCKED' and exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=p.id and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'A confirmed reservation occupies this interval'; end if;
  oid:=coalesce(p_override_id,gen_random_uuid()); item:=jsonb_build_object('id',oid,'starts_at',p_starts_at,'ends_at',p_ends_at,'override_type',p_override_type::text,'reason',nullif(trim(p_reason),''));
  if p.approval_status='APPROVED' then
    cfg:=coalesce(p.pending_configuration,public.wellweb_base_professional_configuration(p.id));
    if p_override_id is not null and not exists(select 1 from jsonb_array_elements(cfg->'overrides') e where e->>'id'=oid::text) then raise exception 'Availability exception not found'; end if;
    if exists(select 1 from jsonb_array_elements(cfg->'overrides') e where e->>'id'<>oid::text and e->>'override_type'=p_override_type::text and tstzrange((e->>'starts_at')::timestamptz,(e->>'ends_at')::timestamptz,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'Overlapping exceptions of the same type are not allowed'; end if;
    cfg:=jsonb_set(cfg,'{overrides}',case when p_override_id is null then (cfg->'overrides')||jsonb_build_array(item) else (select coalesce(jsonb_agg(case when e->>'id'=oid::text then item else e end),'[]'::jsonb) from jsonb_array_elements(cfg->'overrides') e) end);
    update public.professional_profiles set pending_configuration=cfg where id=p.id;
  else
    if exists(select 1 from public.professional_availability_overrides o where o.professional_profile_id=p.id and o.id is distinct from p_override_id and o.override_type=p_override_type and tstzrange(o.starts_at,o.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'Overlapping exceptions of the same type are not allowed'; end if;
    if p_override_type='BLOCKED' and exists(select 1 from public.wellweb_bookings b where b.professional_profile_id=p.id and b.status='CONFIRMED' and tstzrange(b.starts_at,b.ends_at,'[)') && tstzrange(p_starts_at,p_ends_at,'[)')) then raise exception 'A confirmed reservation occupies this interval'; end if;
    if p_override_id is null then insert into public.professional_availability_overrides(id,professional_profile_id,starts_at,ends_at,override_type,reason) values(oid,p.id,p_starts_at,p_ends_at,p_override_type,nullif(trim(p_reason),''));
    else update public.professional_availability_overrides set starts_at=p_starts_at,ends_at=p_ends_at,override_type=p_override_type,reason=nullif(trim(p_reason),'') where id=p_override_id and professional_profile_id=p.id; if not found then raise exception 'Availability exception not found'; end if; end if;
  end if;
  return oid;
end;
$$;
revoke all on function public.save_wellweb_availability_override(uuid,timestamptz,timestamptz,public.wellweb_availability_override_type,text) from public,anon;
grant execute on function public.save_wellweb_availability_override(uuid,timestamptz,timestamptz,public.wellweb_availability_override_type,text) to authenticated;

create or replace function public.delete_wellweb_availability_override(p_override_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare a public.app_users%rowtype; p public.professional_profiles%rowtype; cfg jsonb;
begin
  a:=public.wellweb_actor(); if a.account_type<>'PROFESSIONAL' then raise exception 'Only professionals can manage availability'; end if;
  select * into p from public.professional_profiles where user_id=a.id for update; if not found then raise exception 'Professional profile not found'; end if;
  if p.approval_status='APPROVED' then
    cfg:=coalesce(p.pending_configuration,public.wellweb_base_professional_configuration(p.id));
    if not exists(select 1 from jsonb_array_elements(cfg->'overrides') e where e->>'id'=p_override_id::text) then raise exception 'Availability exception not found'; end if;
    cfg:=jsonb_set(cfg,'{overrides}',(select coalesce(jsonb_agg(e),'[]'::jsonb) from jsonb_array_elements(cfg->'overrides') e where e->>'id'<>p_override_id::text));
    update public.professional_profiles set pending_configuration=cfg where id=p.id;
  else delete from public.professional_availability_overrides where id=p_override_id and professional_profile_id=p.id; if not found then raise exception 'Availability exception not found'; end if; end if;
end;
$$;
revoke all on function public.delete_wellweb_availability_override(uuid) from public,anon;
grant execute on function public.delete_wellweb_availability_override(uuid) to authenticated;

create or replace function public.admin_list_pending_professional_configurations()
returns setof jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not public.is_wellweb_admin() then raise exception 'Administrator access required'; end if;
  return query select to_jsonb(x) from (
    select p.id as profile_id,u.id as partner_id,u.display_name,u.email,p.pending_configuration,public.wellweb_base_professional_configuration(p.id) as current_configuration,p.updated_at
    from public.professional_profiles p join public.app_users u on u.id=p.user_id
    where p.pending_configuration is not null order by p.updated_at
  ) x;
end;
$$;
revoke all on function public.admin_list_pending_professional_configurations() from public,anon;
grant execute on function public.admin_list_pending_professional_configurations() to authenticated;

create or replace function public.admin_review_professional_configuration(p_profile_id uuid,p_approve boolean,p_note text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare reviewer uuid; p public.professional_profiles%rowtype; cfg jsonb; s jsonb; a jsonb; o jsonb; recipient text; queue_id uuid;
begin
  select id into reviewer from public.app_users where auth_user_id=(select auth.uid()) and account_type='ADMIN' and status='ACTIVE';
  if reviewer is null then raise exception 'Administrator access required'; end if;
  if not p_approve and nullif(trim(p_note),'') is null then raise exception 'A rejection reason is required'; end if;
  select * into p from public.professional_profiles where id=p_profile_id for update;
  if not found or p.pending_configuration is null then raise exception 'No configuration is pending review'; end if;
  cfg:=p.pending_configuration;
  if p_approve then
    perform pg_advisory_xact_lock(hashtext('wellweb-booking-'||p.id::text));
    if exists(
      select 1 from jsonb_array_elements(cfg->'overrides') proposed
      join public.wellweb_bookings b on b.professional_profile_id=p.id and b.status='CONFIRMED'
      where proposed->>'override_type'='BLOCKED'
        and tstzrange((proposed->>'starts_at')::timestamptz,(proposed->>'ends_at')::timestamptz,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')
    ) then raise exception 'A confirmed reservation occupies a proposed blocked interval'; end if;
    for s in select value from jsonb_array_elements(cfg->'services') loop
      insert into public.professional_services(id,professional_profile_id,name,description,modality_slug,duration_minutes,price,currency,active,has_material,allows_group,max_students,price_per_student)
      values((s->>'id')::uuid,p.id,s->>'name',s->>'description',s->>'modality_slug',(s->>'duration_minutes')::int,(s->>'price')::numeric,coalesce(s->>'currency','EUR'),coalesce((s->>'active')::boolean,false),coalesce((s->>'has_material')::boolean,false),coalesce((s->>'allows_group')::boolean,false),(s->>'max_students')::int,coalesce((s->>'price_per_student')::boolean,false))
      on conflict(id) do update set name=excluded.name,description=excluded.description,modality_slug=excluded.modality_slug,duration_minutes=excluded.duration_minutes,price=excluded.price,currency=excluded.currency,active=excluded.active,has_material=excluded.has_material,allows_group=excluded.allows_group,max_students=excluded.max_students,price_per_student=excluded.price_per_student
      where public.professional_services.professional_profile_id=p.id;
    end loop;
    update public.professional_services set active=false where professional_profile_id=p.id and not exists(select 1 from jsonb_array_elements(cfg->'services') s where s->>'id'=professional_services.id::text);
    delete from public.professional_weekly_availability where professional_profile_id=p.id;
    for a in select value from jsonb_array_elements(cfg->'weekly') loop
      insert into public.professional_weekly_availability(id,professional_profile_id,day_of_week,start_time,end_time) values((a->>'id')::uuid,p.id,(a->>'day_of_week')::smallint,(a->>'start_time')::time,(a->>'end_time')::time);
    end loop;
    delete from public.professional_availability_overrides where professional_profile_id=p.id;
    for o in select value from jsonb_array_elements(cfg->'overrides') loop
      insert into public.professional_availability_overrides(id,professional_profile_id,starts_at,ends_at,override_type,reason)
      values((o->>'id')::uuid,p.id,(o->>'starts_at')::timestamptz,(o->>'ends_at')::timestamptz,(o->>'override_type')::public.wellweb_availability_override_type,o->>'reason');
    end loop;
  else
    select u.email into recipient from public.app_users u where u.id=p.user_id;
    insert into public.partner_rejection_email_outbox(partner_id,reviewer_id,recipient_email,reason)
    values(p.user_id,reviewer,recipient,trim(p_note)) returning id into queue_id;
  end if;
  update public.professional_profiles set pending_configuration=null where id=p.id;
  insert into public.partner_review_events(partner_id,reviewer_id,decision,note)
  values(p.user_id,reviewer,case when p_approve then 'APPROVED' else 'REJECTED' end,nullif(left(trim(coalesce(p_note,'')),1000),''));
  return queue_id;
end;
$$;
revoke all on function public.admin_review_professional_configuration(uuid,boolean,text) from public,anon;
grant execute on function public.admin_review_professional_configuration(uuid,boolean,text) to authenticated;

notify pgrst,'reload schema';
commit;
