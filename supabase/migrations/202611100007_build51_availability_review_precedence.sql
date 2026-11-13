-- Build 5.1: keep configuration review consistent with AVAILABLE-over-BLOCKED precedence.
begin;

create or replace function public.admin_review_professional_configuration(p_profile_id uuid,p_approve boolean,p_note text default null)
returns uuid language plpgsql security definer set search_path = ''
as $$
declare
  reviewer uuid;
  p public.professional_profiles%rowtype;
  cfg jsonb;
  service_item jsonb;
  weekly_item jsonb;
  override_item jsonb;
  recipient text;
  queue_id uuid;
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
      select 1
      from jsonb_array_elements(cfg->'overrides') as proposed_block(value)
      join public.wellweb_bookings b on b.professional_profile_id=p.id and b.status='CONFIRMED'
      where proposed_block.value->>'override_type'='BLOCKED'
        and tstzrange((proposed_block.value->>'starts_at')::timestamptz,(proposed_block.value->>'ends_at')::timestamptz,'[)')
            && tstzrange(b.starts_at,b.ends_at,'[)')
        and not exists (
          select 1
          from jsonb_array_elements(cfg->'overrides') as proposed_availability(value)
          where proposed_availability.value->>'override_type'='AVAILABLE'
            and (proposed_availability.value->>'starts_at')::timestamptz <= b.starts_at
            and (proposed_availability.value->>'ends_at')::timestamptz >= b.ends_at
        )
    ) then raise exception 'A confirmed reservation occupies a proposed blocked interval'; end if;

    for service_item in
      select service_elements.value from jsonb_array_elements(cfg->'services') as service_elements(value)
    loop
      insert into public.professional_services(
        id,professional_profile_id,name,description,modality_slug,duration_minutes,price,currency,active,
        has_material,allows_group,max_students,price_per_student
      ) values (
        (service_item->>'id')::uuid,p.id,service_item->>'name',service_item->>'description',service_item->>'modality_slug',
        (service_item->>'duration_minutes')::int,(service_item->>'price')::numeric,coalesce(service_item->>'currency','EUR'),
        coalesce((service_item->>'active')::boolean,false),coalesce((service_item->>'has_material')::boolean,false),
        coalesce((service_item->>'allows_group')::boolean,false),(service_item->>'max_students')::int,
        coalesce((service_item->>'price_per_student')::boolean,false)
      )
      on conflict(id) do update set
        name=excluded.name,description=excluded.description,modality_slug=excluded.modality_slug,
        duration_minutes=excluded.duration_minutes,price=excluded.price,currency=excluded.currency,active=excluded.active,
        has_material=excluded.has_material,allows_group=excluded.allows_group,max_students=excluded.max_students,
        price_per_student=excluded.price_per_student
      where public.professional_services.professional_profile_id=p.id;
    end loop;

    update public.professional_services
    set active=false
    where professional_profile_id=p.id
      and not exists (
        select 1 from jsonb_array_elements(cfg->'services') as proposed_service(value)
        where proposed_service.value->>'id'=professional_services.id::text
      );

    delete from public.professional_weekly_availability where professional_profile_id=p.id;
    for weekly_item in
      select weekly_elements.value from jsonb_array_elements(cfg->'weekly') as weekly_elements(value)
    loop
      insert into public.professional_weekly_availability(id,professional_profile_id,day_of_week,start_time,end_time)
      values((weekly_item->>'id')::uuid,p.id,(weekly_item->>'day_of_week')::smallint,
             (weekly_item->>'start_time')::time,(weekly_item->>'end_time')::time);
    end loop;

    delete from public.professional_availability_overrides where professional_profile_id=p.id;
    for override_item in
      select override_elements.value from jsonb_array_elements(cfg->'overrides') as override_elements(value)
    loop
      insert into public.professional_availability_overrides(id,professional_profile_id,starts_at,ends_at,override_type,reason)
      values((override_item->>'id')::uuid,p.id,(override_item->>'starts_at')::timestamptz,
             (override_item->>'ends_at')::timestamptz,
             (override_item->>'override_type')::public.wellweb_availability_override_type,override_item->>'reason');
    end loop;
  else
    select u.email into recipient from public.app_users u where u.id=p.user_id;
    insert into public.partner_rejection_email_outbox(partner_id,reviewer_id,recipient_email,reason)
    values(p.user_id,reviewer,recipient,trim(p_note)) returning id into queue_id;
  end if;

  update public.professional_profiles set pending_configuration=null where id=p.id;
  insert into public.partner_review_events(partner_id,reviewer_id,decision,note)
  values(p.user_id,reviewer,case when p_approve then 'APPROVED' else 'REJECTED' end,
         nullif(left(trim(coalesce(p_note,'')),1000),''));
  return queue_id;
end;
$$;
revoke all on function public.admin_review_professional_configuration(uuid,boolean,text) from public,anon;
grant execute on function public.admin_review_professional_configuration(uuid,boolean,text) to authenticated;

notify pgrst,'reload schema';
commit;
