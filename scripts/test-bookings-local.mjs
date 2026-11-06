// Isolated integration check for Build 5. Creates fixtures only on loopback and removes them.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const parsed = readFileSync('.env.local', 'utf8').split(/\r?\n/)
  .map(line => line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)).filter(Boolean)
  .map(match => [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')]);
const env = Object.fromEntries(parsed);
const endpoint = env.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY;
if (!endpoint || !anonKey || !['localhost', '127.0.0.1', '::1'].includes(new URL(endpoint).hostname)) {
  throw new Error('Refusing to run fixtures: .env.local must point to a loopback Supabase URL.');
}

const databaseContainer = process.env.WELLWEB_LOCAL_DB_CONTAINER || 'supabase_db_wellweb-mvp-local-only';
const suffix = randomBytes(5).toString('hex');
const authUserIds = [];
const hotelIds = [];
const profileIds = [];
const results = [];
const client = () => createClient(endpoint, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const pass = label => results.push(`PASS ${label}`);

function localSql(sql) {
  return execFileSync('docker', ['exec', databaseContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
async function signup(role, label, metadata = {}) {
  const supabase = client();
  const email = `b5-${role}-${suffix}-${label.toLowerCase().replace(/[^a-z]/g, '')}@example.test`;
  const password = `Ww!${randomBytes(24).toString('base64url')}9a`;
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: label, ...metadata } } });
  if (error || !data.user) throw new Error(`Local fixture signup failed for ${role}.`);
  authUserIds.push(data.user.id);
  if (!data.session) {
    const { data: login, error: loginError } = await supabase.auth.signInWithPassword({ email, password });
    if (loginError || !login.session) throw new Error(`Local fixture login failed for ${role}.`);
  }
  return { supabase, user: data.user, email };
}
async function appUserId(supabase, authUserId) {
  const { data, error } = await supabase.from('app_users').select('id').eq('auth_user_id', authUserId).single();
  if (error || !data) throw new Error('WellWeb local signup did not provision an app identity.');
  return data.id;
}
async function call(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  return { data, error };
}
async function ok(supabase, name, args) {
  const result = await call(supabase, name, args);
  if (result.error) throw new Error(`Expected ${name} to succeed; it was rejected.`);
  return result.data;
}
async function denied(supabase, name, args) {
  const { error } = await call(supabase, name, args);
  assert.ok(error, `${name} should be denied`);
}
function fixtureHotelMeta(name, suffixDigit) {
  return { wellweb_signup: 'true', account_type: 'HOTEL', phone_e164: `+35191000000${suffixDigit}`, city: 'Ericeira', hotel_name: name, address_line1: `Rua de Teste ${suffixDigit}` };
}
function nextLisbonDate() {
  const target = new Date(Date.now() + 36 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(target);
  const value = type => parts.find(part => part.type === type)?.value;
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  const [year, month, day] = date.split('-').map(Number);
  return { date, weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay() };
}

let admin;
let hotelA;
let hotelB;
let unapprovedHotel;
let pro;
let otherPro;
let createdBookings = [];

try {
  admin = await signup('admin', 'Fixture Admin');
  localSql(`insert into public.app_users(auth_user_id,email,display_name,account_type,status) values('${admin.user.id}'::uuid,'${admin.email}','Build 5 Fixture Admin','ADMIN','ACTIVE')`);
  const adminState = await admin.supabase.from('app_users').select('account_type,status').eq('auth_user_id', admin.user.id).single();
  assert.equal(adminState.data?.account_type, 'ADMIN');
  pass('local ADMIN identity is authenticated');

  hotelA = await signup('hotel', 'Fixture Hotel A', fixtureHotelMeta('Fixture Hotel A', 1));
  hotelB = await signup('hotel', 'Fixture Hotel B', fixtureHotelMeta('Fixture Hotel B', 2));
  unapprovedHotel = await signup('hotel', 'Fixture Hotel C', fixtureHotelMeta('Fixture Hotel C', 3));
  pro = await signup('professional', 'Fixture Pro A', { wellweb_signup: 'true', account_type: 'PROFESSIONAL', phone_e164: '+351910000004', city: 'Ericeira', service_area: 'Yoga' });
  otherPro = await signup('professional', 'Fixture Pro B', { wellweb_signup: 'true', account_type: 'PROFESSIONAL', phone_e164: '+351910000005', city: 'Ericeira', service_area: 'Surf' });

  const [hotelAUser, hotelBUser, unapprovedHotelUser, proUser, otherProUser] = await Promise.all([
    appUserId(hotelA.supabase, hotelA.user.id), appUserId(hotelB.supabase, hotelB.user.id),
    appUserId(unapprovedHotel.supabase, unapprovedHotel.user.id), appUserId(pro.supabase, pro.user.id), appUserId(otherPro.supabase, otherPro.user.id),
  ]);
  const [membershipA, membershipB, membershipC, profileResult, otherProfileResult] = await Promise.all([
    hotelA.supabase.from('hotel_members').select('hotel_id').eq('user_id', hotelAUser).single(),
    hotelB.supabase.from('hotel_members').select('hotel_id').eq('user_id', hotelBUser).single(),
    unapprovedHotel.supabase.from('hotel_members').select('hotel_id').eq('user_id', unapprovedHotelUser).single(),
    pro.supabase.from('professional_profiles').select('id').eq('user_id', proUser).single(),
    otherPro.supabase.from('professional_profiles').select('id').eq('user_id', otherProUser).single(),
  ]);
  if ([membershipA,membershipB,membershipC,profileResult,otherProfileResult].some(item => item.error)) throw new Error('Local fixture profiles were not created.');
  const hotels = [membershipA.data.hotel_id, membershipB.data.hotel_id, membershipC.data.hotel_id];
  const profileId = profileResult.data.id;
  const otherProfileId = otherProfileResult.data.id;
  hotelIds.push(...hotels); profileIds.push(profileId, otherProfileId);

  for (const partnerId of [hotelAUser, hotelBUser, proUser]) await ok(admin.supabase, 'admin_review_partner', { p_partner_id: partnerId, p_approve: true, p_note: 'Build 5 local integration fixture' });
  await ok(pro.supabase, 'submit_wellweb_partner_profile', {
    p_profile: { public_name: 'Fixture Pro A', city: 'Ericeira', service_area: 'Yoga', description: 'Local test profile', primary_photo_path: null, gallery_photo_paths: [], is_public: true },
    p_modalities: [], p_languages: ['pt'],
  });
  await ok(admin.supabase, 'admin_review_partner', { p_partner_id: proUser, p_approve: true, p_note: 'Approve local test publication' });
  pass('approved hotel and professional profiles are available for booking');

  const serviceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Yoga', p_description: 'Snapshot test', p_modality_slug: null,
    p_duration_minutes: 60, p_price: 25, p_active: true,
  });
  const secondServiceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Mobility', p_description: 'Second RLS-visible service', p_modality_slug: null,
    p_duration_minutes: 90, p_price: 35, p_active: true,
  });
  const hotelServices = await hotelA.supabase.from('professional_services')
    .select('id,name,duration_minutes,active')
    .eq('professional_profile_id', profileId).eq('active', true)
    .not('duration_minutes', 'is', null).gte('duration_minutes', 5).lte('duration_minutes', 1440)
    .order('name');
  if (hotelServices.error || !hotelServices.data?.length) {
    const rlsState = localSql(`select concat_ws('|',p.is_public,p.approval_status::text,pu.account_type,pu.status, exists(select 1 from public.hotel_members hm join public.app_users hu on hu.id=hm.user_id join public.hotels h on h.id=hm.hotel_id where hu.auth_user_id='${hotelA.user.id}'::uuid and hu.account_type='HOTEL' and hu.status='ACTIVE' and hm.status='ACTIVE' and h.approval_status='APPROVED' and h.status='ACTIVE')) from public.professional_profiles p join public.app_users pu on pu.id=p.user_id where p.id='${profileId}'::uuid`);
    throw new Error(`Authenticated HOTEL could not read approved services. RLS conditions: ${rlsState.trim()}; query error: ${hotelServices.error?.code ?? 'none'}`);
  }
  assert.deepEqual(new Set((hotelServices.data ?? []).map(row => row.id)), new Set([serviceId, secondServiceId]));
  assert.ok(hotelServices.data.every(row => row.active && row.duration_minutes >= 5 && row.duration_minutes <= 1440));
  pass('authenticated HOTEL session reads both active valid services with RLS enabled');

  const inactiveServiceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Inactive', p_description: 'Must not appear in booking', p_modality_slug: null,
    p_duration_minutes: 60, p_price: 10, p_active: false,
  });
  const filteredHotelServices = await hotelA.supabase.from('professional_services')
    .select('id').eq('professional_profile_id', profileId).eq('active', true)
    .not('duration_minutes', 'is', null).gte('duration_minutes', 5).lte('duration_minutes', 1440);
  assert.equal(filteredHotelServices.error, null);
  assert.deepEqual(new Set((filteredHotelServices.data ?? []).map(row => row.id)), new Set([serviceId, secondServiceId]));
  assert.ok(!filteredHotelServices.data.some(row => row.id === inactiveServiceId));
  const ownServices = await pro.supabase.from('professional_services').select('id,active').eq('professional_profile_id', profileId);
  assert.equal(ownServices.error, null);
  assert.ok(ownServices.data.some(row => row.id === inactiveServiceId && !row.active), 'professional should still manage own inactive services');
  pass('inactive services are excluded from hotel booking results while the professional retains management access');
  const { date, weekday } = nextLisbonDate();
  await ok(pro.supabase, 'save_wellweb_weekly_availability', { p_slot_id: null, p_day_of_week: weekday, p_start_time: '08:00', p_end_time: '18:00' });
  const { data: slots, error: slotError } = await hotelA.supabase.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: serviceId, p_from: date, p_to: date });
  if (slotError || !slots?.length) throw new Error('Local availability did not return an open future slot.');

  const request = (supabase, hotelId, startsAt = slots[0].starts_at) => ok(supabase, 'request_wellweb_booking', {
    p_hotel_id: hotelId, p_professional_profile_id: profileId, p_service_id: serviceId,
    p_starts_at: startsAt, p_participants: 2, p_guest_name: 'Fixture guest', p_notes: 'Fixture notes',
  });
  const first = await request(hotelA.supabase, hotels[0]);
  const second = await request(hotelB.supabase, hotels[1]);
  const rejectBooking = await request(hotelA.supabase, hotels[0], slots[4].starts_at);
  createdBookings.push(first.id, second.id, rejectBooking.id);
  assert.equal(first.status, 'PENDING'); assert.match(first.reference, /^WW-/);
  pass('approved hotel creates PENDING request with reference and service snapshot');

  const receivedByProfessional = await pro.supabase.rpc('my_list_wellweb_bookings');
  assert.equal(receivedByProfessional.error, null);
  assert.ok(receivedByProfessional.data.some(row => row.id === first.id && row.status === 'PENDING'), 'professional did not receive the hotel booking request');
  pass('real hotel booking request appears in the authenticated professional inbox');

  await denied(unapprovedHotel.supabase, 'request_wellweb_booking', { p_hotel_id: hotels[2], p_professional_profile_id: profileId, p_service_id: serviceId, p_starts_at: slots[0].starts_at, p_participants: 1 });
  await denied(hotelA.supabase, 'decide_wellweb_booking', { p_booking_id: first.id, p_accept: true, p_reason: null });
  await denied(otherPro.supabase, 'decide_wellweb_booking', { p_booking_id: first.id, p_accept: true, p_reason: null });
  const directUpdate = await hotelA.supabase.from('wellweb_bookings').update({ status: 'CONFIRMED' }).eq('id', first.id);
  assert.ok(directUpdate.error, 'direct client state updates must fail');
  pass('unapproved hotels, hotels changing state, and unrelated professionals are denied');

  const [hotelBRows, otherProRows] = await Promise.all([
    hotelB.supabase.from('wellweb_bookings').select('id'), otherPro.supabase.from('wellweb_bookings').select('id'),
  ]);
  assert.deepEqual((hotelBRows.data ?? []).map(row => row.id), [second.id]);
  assert.equal(otherProRows.data?.length, 0);
  pass('hotel and professional RLS reads are isolated');

  const race = await Promise.all([
    pro.supabase.rpc('decide_wellweb_booking', { p_booking_id: first.id, p_accept: true, p_reason: null }),
    pro.supabase.rpc('decide_wellweb_booking', { p_booking_id: second.id, p_accept: true, p_reason: null }),
  ]);
  assert.equal(race.filter(result => !result.error).length, 1);
  assert.equal(race.filter(result => result.error).length, 1);
  pass('concurrent overlapping accepts confirm exactly one booking');

  const [statusA, statusB] = await Promise.all([
    hotelA.supabase.from('wellweb_bookings').select('id,status').eq('id', first.id).single(),
    hotelB.supabase.from('wellweb_bookings').select('id,status').eq('id', second.id).single(),
  ]);
  const confirmed = statusA.data.status === 'CONFIRMED'
    ? { row: statusA.data, hotel: hotelA.supabase, hotelId: hotels[0] }
    : { row: statusB.data, hotel: hotelB.supabase, hotelId: hotels[1] };
  const pending = statusA.data.status === 'PENDING' ? statusA.data : statusB.data;
  await denied(confirmed.hotel, 'request_wellweb_booking', {
    p_hotel_id: confirmed.hotelId, p_professional_profile_id: profileId, p_service_id: serviceId,
    p_starts_at: slots[0].starts_at, p_participants: 1,
  });
  pass('a stale availability client cannot submit over an already confirmed booking');
  await ok(confirmed.hotel, 'cancel_wellweb_booking', { p_booking_id: confirmed.row.id, p_reason: 'Fixture cancellation' });
  const released = await confirmed.hotel.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: serviceId, p_from: date, p_to: date });
  assert.ok(released.data?.some(slot => Date.parse(slot.starts_at) === Date.parse(slots[0].starts_at)));
  await ok(pro.supabase, 'decide_wellweb_booking', { p_booking_id: pending.id, p_accept: true, p_reason: null });
  pass('cancellation frees a confirmed slot and a pending request can then be accepted');

  await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: serviceId, p_name: 'Fixture Yoga Updated', p_description: 'Updated service', p_modality_slug: null,
    p_duration_minutes: 90, p_price: 42.5, p_active: true,
  });
  const snapshot = await pro.supabase.from('wellweb_bookings').select('service_name_snapshot,service_duration_minutes_snapshot,service_price_snapshot').eq('id', pending.id).single();
  assert.equal(snapshot.data.service_name_snapshot, 'Fixture Yoga');
  assert.equal(snapshot.data.service_duration_minutes_snapshot, 60);
  assert.equal(Number(snapshot.data.service_price_snapshot), 25);
  await ok(pro.supabase, 'decide_wellweb_booking', { p_booking_id: rejectBooking.id, p_accept: false, p_reason: 'Não disponível nessa hora' });
  const history = await pro.supabase.rpc('my_wellweb_booking_history', { p_booking_id: rejectBooking.id });
  assert.ok(history.data?.some(event => event.to_status === 'REJECTED' && event.reason === 'Não disponível nessa hora'));
  pass('service edits preserve snapshots and rejection reasons are audited');

  const [proNotifications, hotelNotifications, isolatedNotifications] = await Promise.all([
    pro.supabase.from('wellweb_notifications').select('id,event_type'),
    hotelA.supabase.from('wellweb_notifications').select('id,event_type'),
    unapprovedHotel.supabase.from('wellweb_notifications').select('id,event_type'),
  ]);
  assert.ok((proNotifications.data ?? []).length >= 3);
  assert.ok((hotelNotifications.data ?? []).length > 0);
  assert.equal(isolatedNotifications.data?.length, 0);
  await ok(pro.supabase, 'mark_wellweb_notification_read', { p_notification_id: proNotifications.data[0].id });
  pass('notifications persist, remain private to recipients, and can be marked read');

  localSql(`update public.wellweb_bookings set starts_at=now()-interval '2 hours',ends_at=now()-interval '30 minutes' where id='${pending.id}'::uuid and status='CONFIRMED'`);
  await ok(pro.supabase, 'complete_wellweb_booking', { p_booking_id: pending.id, p_reason: 'Fixture experience complete' });
  await denied(pro.supabase, 'cancel_wellweb_booking', { p_booking_id: pending.id, p_reason: null });
  const all = await admin.supabase.rpc('admin_list_wellweb_bookings', { p_status: null, p_hotel_id: null, p_professional_profile_id: null, p_from: null, p_to: null });
  if (all.error) throw new Error('Admin global list did not load.');
  for (const id of createdBookings) assert.ok(all.data.some(row => row.id === id));
  pass('completed booking cannot be reopened and ADMIN can inspect global reservations/history');
} finally {
  const uuids = items => items.filter(value => /^[0-9a-f-]{36}$/i.test(value)).map(value => `'${value}'::uuid`).join(',');
  const hotels = uuids(hotelIds); const profiles = uuids(profileIds); const users = uuids(authUserIds);
  if (hotels || profiles || users) {
    let cleanup = 'begin;';
    if (users) cleanup += `delete from public.partner_review_events where partner_id in (select id from public.app_users where auth_user_id in (${users})) or reviewer_id in (select id from public.app_users where auth_user_id in (${users}));`;
    const bookingConditions = [
      hotels && `hotel_id in (${hotels})`,
      profiles && `professional_profile_id in (${profiles})`,
      users && `hotel_id in (select hm.hotel_id from public.hotel_members hm join public.app_users u on u.id=hm.user_id where u.auth_user_id in (${users}))`,
      users && `professional_profile_id in (select p.id from public.professional_profiles p join public.app_users u on u.id=p.user_id where u.auth_user_id in (${users}))`,
    ].filter(Boolean);
    if (bookingConditions.length) cleanup += `delete from public.wellweb_bookings where ${bookingConditions.join(' or ')};`;
    if (users) cleanup += `delete from public.hotels where id in (select hm.hotel_id from public.hotel_members hm join public.app_users u on u.id=hm.user_id where u.auth_user_id in (${users}));`;
    if (hotels) cleanup += `delete from public.hotels where id in (${hotels});`;
    if (users) cleanup += `delete from auth.users where id in (${users});`;
    cleanup += 'commit;';
    localSql(cleanup);
    pass('temporary fixture records and accounts were deleted from the local database');
  }
}

console.log(results.join('\n'));
