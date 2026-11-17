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
const mediaPaths = [];
const results = [];
const client = () => createClient(endpoint, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const pass = label => results.push(`PASS ${label}`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function localSql(sql) {
  return execFileSync('docker', ['exec', databaseContainer, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function localServiceKey() {
  const output = execFileSync('npx', ['supabase', 'status', '--workdir', '/home/wellweb/wellweb-supabase-local', '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
  });
  const status = JSON.parse(output);
  const localApi = new URL(status.API_URL);
  if (!['127.0.0.1', 'localhost', '::1'].includes(localApi.hostname) || localApi.port !== '54321' || !status.SERVICE_ROLE_KEY) {
    throw new Error('Refusing fixture cleanup: local Supabase status could not be confirmed.');
  }
  return status.SERVICE_ROLE_KEY;
}
async function signup(role, label, metadata = {}) {
  const supabase = client();
  const email = `b5-${role}-${suffix}-${label.toLowerCase().replace(/[^a-z]/g, '')}@example.test`;
  const password = `Ww!${randomBytes(24).toString('base64url')}9a`;
  const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { display_name: label, ...metadata } } });
  if (error || !data.user) throw new Error(`Local fixture signup failed for ${role} (HTTP ${error?.status??'none'}, code ${error?.code??'none'}).`);
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
  if (result.error) throw new Error(`Expected ${name} to succeed; it was rejected: ${result.error.message}`);
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
let professionalPartnerId;
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
  otherPro = await signup('professional', 'Fixture Pro B', { wellweb_signup: 'true', account_type: 'PROFESSIONAL', phone_e164: '+351910000005', city: 'Ericeira', service_area: 'Surf', whatsapp_operational_consent: true, whatsapp_consent_text_version: 'wellweb-whatsapp-operations-v1-2026-11-15' });

  const [hotelAUser, hotelBUser, unapprovedHotelUser, proUser, otherProUser] = await Promise.all([
    appUserId(hotelA.supabase, hotelA.user.id), appUserId(hotelB.supabase, hotelB.user.id),
    appUserId(unapprovedHotel.supabase, unapprovedHotel.user.id), appUserId(pro.supabase, pro.user.id), appUserId(otherPro.supabase, otherPro.user.id),
  ]);
  professionalPartnerId = proUser;
  const initialWhatsApp = await pro.supabase.rpc('my_professional_whatsapp_preference');
  assert.equal(initialWhatsApp.error,null); assert.equal(initialWhatsApp.data?.whatsapp_enabled,false,'existing/new user without explicit consent stays opted out');
  const deniedConsent = await pro.supabase.rpc('my_save_professional_whatsapp_preference',{p_enabled:true,p_explicit_consent:false,p_text_version:null});
  assert.ok(deniedConsent.error,'WhatsApp activation must require explicit current consent');
  const consentVersion='wellweb-whatsapp-operations-v1-2026-11-15';
  const grantedConsent = await pro.supabase.rpc('my_save_professional_whatsapp_preference',{p_enabled:true,p_explicit_consent:true,p_text_version:consentVersion});
  assert.equal(grantedConsent.error,null); assert.equal(grantedConsent.data?.whatsapp_enabled,true);
  await ok(pro.supabase,'my_save_professional_whatsapp_preference',{p_enabled:false,p_explicit_consent:false,p_text_version:null});
  pass('WhatsApp preference defaults off and explicit versioned opt-in/revocation are enforced');
  await ok(pro.supabase,'my_save_professional_whatsapp_preference',{p_enabled:true,p_explicit_consent:true,p_text_version:consentVersion});
  await ok(pro.supabase,'my_update_contact_details',{p_display_name:'Fixture Pro A',p_phone:'+351 910 000 006'});
  const afterPhoneChange=await pro.supabase.rpc('my_professional_whatsapp_preference');
  assert.equal(afterPhoneChange.data?.whatsapp_enabled,false,'changing number must require fresh consent');
  await ok(pro.supabase,'my_update_contact_details',{p_display_name:'Fixture Pro A',p_phone:'+351910000004'});
  pass('changing the phone disables WhatsApp consent without transferring it to the new number');
  const [membershipA, membershipB, membershipC, profileResult, otherProfileResult] = await Promise.all([
    hotelA.supabase.from('hotel_members').select('hotel_id').eq('user_id', hotelAUser).single(),
    hotelB.supabase.from('hotel_members').select('hotel_id').eq('user_id', hotelBUser).single(),
    unapprovedHotel.supabase.from('hotel_members').select('hotel_id').eq('user_id', unapprovedHotelUser).single(),
    pro.supabase.from('professional_profiles').select('id,is_public').eq('user_id', proUser).single(),
    otherPro.supabase.from('professional_profiles').select('id').eq('user_id', otherProUser).single(),
  ]);
  if ([membershipA,membershipB,membershipC,profileResult,otherProfileResult].some(item => item.error)) throw new Error('Local fixture profiles were not created.');
  const hotels = [membershipA.data.hotel_id, membershipB.data.hotel_id, membershipC.data.hotel_id];
  const profileId = profileResult.data.id;
  assert.equal(profileResult.data.is_public, true, 'new professional profile should default to publication intent');
  pass('new professional registration defaults publication intent on while approval still gates visibility');
  const unpublishedIntent = await client().from('public_professional_directory').select('id').eq('id', profileResult.data.id);
  assert.equal(unpublishedIntent.data?.length,0,'publication intent must not bypass pending approval');
  pass('a professional with publication intent remains absent from the public directory until approved');
  const otherProfileId = otherProfileResult.data.id;
  const registrationConsent=localSql(`select p.whatsapp_enabled::text||':'||count(e.id)::text from wellweb_private.professional_notification_preferences p left join wellweb_private.professional_whatsapp_consent_events e on e.professional_profile_id=p.professional_profile_id where p.professional_profile_id='${otherProfileId}'::uuid group by p.whatsapp_enabled`);
  assert.match(registrationConsent,/true:1/,'registration opt-in must create one versioned event and enable only that profile');
  pass('registration opt-in is recorded with a consent event; opt-out stays off by default');
  hotelIds.push(...hotels); profileIds.push(profileId, otherProfileId);

  for (const partnerId of [hotelAUser, hotelBUser]) await ok(admin.supabase, 'admin_review_partner', { p_partner_id: partnerId, p_approve: true, p_note: 'Build 5.1 local integration fixture' });
  const hotelDraft = await hotelA.supabase.from('hotels').select('name,address_line1,city,description,public_contact_email,public_phone,website_url,primary_photo_path,is_public').eq('id', hotels[0]).single();
  assert.equal(hotelDraft.error, null);
  const hotelGalleryLimit = await call(hotelA.supabase, 'submit_wellweb_partner_profile', {
    p_profile: { ...hotelDraft.data, gallery_photo_paths: ['fixture-1','fixture-2','fixture-3','fixture-4'] }, p_modalities: [], p_languages: [],
  });
  assert.ok(hotelGalleryLimit.error, 'hotel gallery must be capped at three photos');
  pass('hotel profile rejects a fourth gallery image');
  const websiteReview = await ok(hotelA.supabase, 'submit_wellweb_partner_profile', {
    p_profile: { ...hotelDraft.data, website_url: 'https://wellweb.example', is_public:true }, p_modalities: [], p_languages: [],
  });
  assert.equal(websiteReview.pending_review, true);
  await ok(admin.supabase, 'admin_review_partner', { p_partner_id: hotelAUser, p_approve: true, p_note: 'Publish public website fixture' });
  const publicHotel = await client().from('public_hotel_directory').select('website_url').eq('id', hotels[0]).single();
  assert.equal(publicHotel.error, null); assert.equal(publicHotel.data.website_url, 'https://wellweb.example');
  pass('hotel website is included in the public hotel allowlist after review');
  await denied(admin.supabase, 'admin_review_partner', { p_partner_id: otherProUser, p_approve: true, p_note: 'Incomplete profile must not be approved' });
  pass('incomplete professional profile cannot be approved');

  const serviceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Yoga', p_description: 'Snapshot test', p_modality_slug: null,
    p_duration_minutes: 60, p_price: 25, p_active: true,
  });
  const secondServiceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Mobility', p_description: 'Group price per student', p_modality_slug: null,
    p_duration_minutes: 90, p_price: 35, p_active: true, p_allows_group: true, p_max_students: 6, p_price_per_student: true,
  });
  const fixedGroupServiceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Group Class', p_description: 'Group price per service', p_modality_slug: null,
    p_duration_minutes: 60, p_price: 120, p_active: true, p_allows_group: true, p_max_students: 10, p_price_per_student: false,
  });
  const inactiveServiceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Inactive', p_description: 'Must not appear in booking', p_modality_slug: null,
    p_duration_minutes: 60, p_price: 10, p_active: false,
  });
  const { date, weekday } = nextLisbonDate();
  await ok(pro.supabase, 'save_wellweb_weekly_availability', { p_slot_id: null, p_day_of_week: weekday, p_start_time: '08:00', p_end_time: '18:00' });
  const weeklyImmediately = await pro.supabase.from('professional_weekly_availability').select('id').eq('professional_profile_id', profileId);
  assert.equal(weeklyImmediately.data?.length, 1, 'weekly availability must be live immediately');
  const weeklySlotId=weeklyImmediately.data[0].id;
  pass('weekly availability is persisted immediately without admin review');

  const incompleteProfile = {
    public_name: 'Fixture Pro A', city: 'Ericeira', service_area: 'Yoga', description: 'Local test profile',
    primary_photo_path: null, gallery_photo_paths: [], is_public: true,
  };
  await ok(pro.supabase, 'submit_wellweb_partner_profile', {
    p_profile: incompleteProfile,
    p_modalities: [], p_languages: ['pt'],
  });
  await denied(admin.supabase, 'admin_review_partner', { p_partner_id: proUser, p_approve: true, p_note: 'Missing primary photo must not be approved' });
  pass('professional approval is blocked when the primary photo is missing');

  const mediaPath = `professionals/${pro.user.id}/fixture-${suffix}.png`;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/dU8AAAAASUVORK5CYII=', 'base64');
  const upload = await pro.supabase.storage.from('wellweb-public-media').upload(mediaPath, png, { contentType: 'image/png', upsert: false });
  if (upload.error) throw new Error('Local professional test image upload failed.');
  mediaPaths.push(mediaPath);
  await ok(pro.supabase, 'submit_wellweb_partner_profile', {
    p_profile: { ...incompleteProfile, primary_photo_path: mediaPath }, p_modalities: [], p_languages: ['pt'],
  });
  await ok(admin.supabase, 'admin_review_partner', { p_partner_id: proUser, p_approve: true, p_note: 'Approve local test publication' });
  pass('complete professional profile with owned storage image is approved');

  const professionalGalleryLimit = await call(pro.supabase, 'submit_wellweb_partner_profile', {
    p_profile: { ...incompleteProfile, primary_photo_path: mediaPath, gallery_photo_paths: ['fixture-1','fixture-2','fixture-3','fixture-4'] },
    p_modalities: [], p_languages: ['pt'],
  });
  assert.ok(professionalGalleryLimit.error, 'professional gallery must be capped at three photos');
  pass('professional profile rejects a fourth gallery image');

  const profileProposal = await ok(pro.supabase, 'submit_wellweb_partner_profile', {
    p_profile: { ...incompleteProfile, description: 'Proposed profile description', primary_photo_path: mediaPath },
    p_modalities: [], p_languages: ['pt'],
  });
  assert.equal(profileProposal.pending_review, true);
  const publishedBeforeReview = await pro.supabase.from('professional_profiles').select('description,pending_profile').eq('id', profileId).single();
  assert.equal(publishedBeforeReview.data?.description, 'Local test profile');
  assert.equal(publishedBeforeReview.data?.pending_profile?.description, 'Proposed profile description');
  const partnerReviews = await ok(admin.supabase, 'admin_list_partner_reviews', {});
  const reviewItem = partnerReviews.find(row => row.partner_id === proUser);
  assert.equal(reviewItem?.profile?.description, 'Local test profile');
  assert.equal(reviewItem?.pending_profile?.description, 'Proposed profile description');
  await ok(admin.supabase, 'admin_review_partner', { p_partner_id: proUser, p_approve: true, p_note: 'Approve local profile proposal' });
  const publishedAfterReview = await pro.supabase.from('professional_profiles').select('description,pending_profile').eq('id', profileId).single();
  assert.equal(publishedAfterReview.data?.description, 'Proposed profile description');
  assert.equal(publishedAfterReview.data?.pending_profile, null);
  pass('published profile stays unchanged until an admin reviews a proposed edit');

  const rejectedPartner = await call(admin.supabase, 'admin_reject_partner_with_reason', { p_partner_id: unapprovedHotelUser, p_reason: '   ' });
  assert.ok(rejectedPartner.error, 'rejection reason must be required');
  const rejectionReason = 'Fixture rejection reason for local integration';
  const outboxId = await ok(admin.supabase, 'admin_reject_partner_with_reason', { p_partner_id: unapprovedHotelUser, p_reason: rejectionReason });
  const reviewEvent = await admin.supabase.from('partner_review_events').select('decision,note').eq('partner_id', unapprovedHotelUser).order('created_at', { ascending: false }).limit(1).single();
  assert.equal(reviewEvent.data?.decision, 'REJECTED');
  assert.equal(reviewEvent.data?.note, rejectionReason);
  const rejectionState = await ok(admin.supabase, 'admin_list_partner_rejection_email', { p_outbox_id: outboxId });
  assert.equal(rejectionState.status, 'PENDING');
  const hotelOutbox = await unapprovedHotel.supabase.from('partner_rejection_email_outbox').select('id');
  assert.ok(hotelOutbox.error, 'non-admin users must not read the email outbox');
  pass('admin rejection reason is persisted; ordinary hotel session cannot read private outbox');
  if(process.env.WELLWEB_SKIP_REJECTION_EMAIL_TEST==='1') pass('existing partner-rejection SMTP check skipped by explicit local integration option');
  else {
  const emailSend = await admin.supabase.functions.invoke('send-partner-rejection', { body: { outbox_id: outboxId } });
  if (emailSend.error || emailSend.data?.status !== 'SENT') throw new Error(`The local rejection email was not accepted by the local SMTP transport (HTTP ${emailSend.response?.status??'no response'}, code ${emailSend.error?.code??'none'}, state ${emailSend.data?.status??'none'}, result ${emailSend.data?.message??'none'}).`);
  let delivered=false;
  for(let attempt=0;attempt<10;attempt++){
    const inbox=await fetch('http://127.0.0.1:54324/api/v1/messages').then(response=>response.json()).catch(()=>null);
    delivered=JSON.stringify(inbox?.messages??[]).includes(unapprovedHotel.email);
    if(delivered)break;
    await pause(300);
  }
  assert.ok(delivered,'the rejection email must appear in the local Inbucket mailbox');
  const sentState = await ok(admin.supabase, 'admin_list_partner_rejection_email', { p_outbox_id: outboxId });
  assert.equal(sentState.status, 'SENT');
  pass('rejection email is delivered only to local Inbucket and its outbox state is SENT');
  }

  await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: serviceId, p_name: 'Fixture Yoga Published', p_description: 'Snapshot test', p_modality_slug: null,
    p_duration_minutes: 60, p_price: 25, p_active: true,
  });
  const proposals = await ok(admin.supabase, 'admin_list_pending_professional_configurations', {});
  const pendingProposal = proposals.find(row => row.profile_id === profileId);
  assert.ok(pendingProposal);
  assert.equal(pendingProposal.current_configuration.services.length, 4);
  assert.ok(pendingProposal.pending_configuration.services.some(item => item.id === serviceId && item.name === 'Fixture Yoga Published'));
  const beforeConfigReview = await hotelA.supabase.from('professional_services').select('name').eq('id', serviceId).single();
  assert.equal(beforeConfigReview.data?.name, 'Fixture Yoga');
  await ok(admin.supabase, 'admin_review_professional_configuration', { p_profile_id: profileId, p_approve: true, p_note: 'Publish local test service proposal' });
  const afterConfigReview = await hotelA.supabase.from('professional_services').select('name').eq('id', serviceId).single();
  assert.equal(afterConfigReview.data?.name, 'Fixture Yoga Published');
  pass('service proposal diff is visible to admins while the hotel sees only the published version');

  const overrideStart = new Date(`${date}T08:00:00+00:00`);
  const override = async (type, from, to) => ok(pro.supabase, 'save_wellweb_availability_override', {
    p_override_id: null, p_starts_at: from.toISOString(), p_ends_at: to.toISOString(), p_override_type: type, p_reason: 'Build 5.1 fixture exception',
  });
  const blockedOverrideId=await override('BLOCKED', overrideStart, new Date(overrideStart.getTime() + 2 * 60 * 60 * 1000));
  const availableOverrideId=await override('AVAILABLE', new Date(overrideStart.getTime() + 30 * 60 * 1000), new Date(overrideStart.getTime() + 90 * 60 * 1000));
  await ok(pro.supabase,'save_wellweb_availability_override',{p_override_id:blockedOverrideId,p_starts_at:overrideStart.toISOString(),p_ends_at:new Date(overrideStart.getTime()+2*60*60*1000).toISOString(),p_override_type:'BLOCKED',p_reason:'Edited Build 5.2 fixture exception'});
  const editedOverride=await pro.supabase.from('professional_availability_overrides').select('reason').eq('id',blockedOverrideId).single();
  assert.equal(editedOverride.data?.reason,'Edited Build 5.2 fixture exception');
  pass('availability exceptions can be selected, edited and reloaded');
  const liveOverridesBeforeReview = await pro.supabase.from('professional_availability_overrides').select('id').eq('professional_profile_id', profileId);
  assert.equal(liveOverridesBeforeReview.data?.length, 2, 'availability exceptions must be live immediately');
  const { data: overrideSlots, error: overrideSlotsError } = await hotelA.supabase.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: serviceId, p_from: date, p_to: date });
  assert.equal(overrideSlotsError, null);
  assert.ok(overrideSlots.some(slot => Date.parse(slot.starts_at) === overrideStart.getTime() + 30 * 60 * 1000), 'AVAILABLE exception inside BLOCKED interval should be bookable');
  pass('availability exceptions take effect immediately and AVAILABLE retains precedence inside BLOCKED interval');
  const hotelServices = await hotelA.supabase.from('professional_services')
    .select('id,name,duration_minutes,active')
    .eq('professional_profile_id', profileId).eq('active', true)
    .not('duration_minutes', 'is', null).gte('duration_minutes', 5).lte('duration_minutes', 1440)
    .order('name');
  if (hotelServices.error || !hotelServices.data?.length) {
    const rlsState = localSql(`select concat_ws('|',p.is_public,p.approval_status::text,pu.account_type,pu.status, exists(select 1 from public.hotel_members hm join public.app_users hu on hu.id=hm.user_id join public.hotels h on h.id=hm.hotel_id where hu.auth_user_id='${hotelA.user.id}'::uuid and hu.account_type='HOTEL' and hu.status='ACTIVE' and hm.status='ACTIVE' and h.approval_status='APPROVED' and h.status='ACTIVE')) from public.professional_profiles p join public.app_users pu on pu.id=p.user_id where p.id='${profileId}'::uuid`);
    throw new Error(`Authenticated HOTEL could not read approved services. RLS conditions: ${rlsState.trim()}; query error: ${hotelServices.error?.code ?? 'none'}`);
  }
  assert.deepEqual(new Set((hotelServices.data ?? []).map(row => row.id)), new Set([serviceId, secondServiceId, fixedGroupServiceId]));
  assert.ok(hotelServices.data.every(row => row.active && row.duration_minutes >= 5 && row.duration_minutes <= 1440));
  pass('authenticated HOTEL session reads both active valid services with RLS enabled');

  const filteredHotelServices = await hotelA.supabase.from('professional_services')
    .select('id').eq('professional_profile_id', profileId).eq('active', true)
    .not('duration_minutes', 'is', null).gte('duration_minutes', 5).lte('duration_minutes', 1440);
  assert.equal(filteredHotelServices.error, null);
  assert.deepEqual(new Set((filteredHotelServices.data ?? []).map(row => row.id)), new Set([serviceId, secondServiceId, fixedGroupServiceId]));
  assert.ok(!filteredHotelServices.data.some(row => row.id === inactiveServiceId));
  const ownServices = await pro.supabase.from('professional_services').select('id,active').eq('professional_profile_id', profileId);
  assert.equal(ownServices.error, null);
  assert.ok(ownServices.data.some(row => row.id === inactiveServiceId && !row.active), 'professional should still manage own inactive services');
  pass('inactive services are excluded from hotel booking results while the professional retains management access');
  const { data: slots, error: slotError } = await hotelA.supabase.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: serviceId, p_from: date, p_to: date });
  if (slotError || !slots?.length) throw new Error('Local availability did not return an open future slot.');
  const exactBoundarySql=`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${pro.user.id}',true); select public.save_wellweb_availability_override(null,now()+interval '4 hours',now()+interval '5 hours','AVAILABLE'::public.wellweb_availability_override_type,'Build 5.2 exact boundary'); select set_config('request.jwt.claim.sub','${hotelA.user.id}',true); select (public.request_wellweb_booking('${hotels[0]}'::uuid,'${profileId}'::uuid,'${serviceId}'::uuid,now()+interval '4 hours',1,null,null)->>'status'); rollback;`;
  const exactBoundaryResult=localSql(exactBoundarySql);
  assert.match(exactBoundaryResult,/PENDING/,'an exact four-hour lead time must be accepted');
  let belowBoundaryRejected=false;
  try {
    localSql(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${hotelA.user.id}',true); select public.request_wellweb_booking('${hotels[0]}'::uuid,'${profileId}'::uuid,'${serviceId}'::uuid,now()+interval '4 hours'-interval '1 second',1,null,null); rollback;`);
  } catch(error) { belowBoundaryRejected=String(error.stderr??'').includes('Reservation requests require at least 4 hours notice'); }
  assert.ok(belowBoundaryRejected,'one second below the four-hour boundary must be rejected');
  pass('exact four-hour reservation boundary is accepted; one second below is rejected');

  const request = (supabase, hotelId, startsAt = slots[0].starts_at, serviceIdForRequest = serviceId, participants = 1) => ok(supabase, 'request_wellweb_booking', {
    p_hotel_id: hotelId, p_professional_profile_id: profileId, p_service_id: serviceIdForRequest,
    p_starts_at: startsAt, p_participants: participants, p_guest_name: 'Fixture guest', p_notes: 'Fixture notes',
  });
  const tooSoon = await call(hotelA.supabase, 'request_wellweb_booking', { p_hotel_id: hotels[0], p_professional_profile_id: profileId, p_service_id: serviceId, p_starts_at: new Date(Date.now()+4*60*60*1000-1000).toISOString(), p_participants: 1 });
  assert.match(tooSoon.error?.message??'', /at least 4 hours notice/i);
  pass('booking RPC rejects starts less than four hours away');
  const first = await request(hotelA.supabase, hotels[0]);
  const second = await request(hotelB.supabase, hotels[1]);
  const rejectBooking = await request(hotelA.supabase, hotels[0], slots[4].starts_at);
  createdBookings.push(first.id, second.id, rejectBooking.id);
  const queuedChannels=localSql(`select count(*) from wellweb_private.notification_outbox o join public.wellweb_notifications n on n.id=o.notification_id where n.booking_id='${first.id}'::uuid`);
  assert.match(queuedChannels,/2/,'booking request event should enqueue email and WhatsApp independently');
  const deadlineView=await pro.supabase.rpc('my_list_wellweb_bookings');
  const firstWithDeadline=deadlineView.data.find(row=>row.id===first.id);
  assert.ok(firstWithDeadline?.response_deadline_at);
  assert.ok(Math.abs(Date.parse(firstWithDeadline.response_deadline_at)-Date.parse(firstWithDeadline.created_at)-4*60*60*1000)<5000,'new request deadline must be four hours after server creation');
  assert.equal(firstWithDeadline.resolution_code,null);
  assert.equal(first.status, 'PENDING'); assert.match(first.reference, /^WW-/);
  assert.equal(Number(first.total_price), 25);
  pass('approved hotel creates PENDING request with reference and service snapshot');

  const expirationBooking=await request(hotelA.supabase,hotels[0],slots[2].starts_at);
  createdBookings.push(expirationBooking.id);
  localSql(`update public.wellweb_bookings set response_deadline_at=now()-interval '1 second' where id='${expirationBooking.id}'::uuid`);
  let expired;
  for(let attempt=0;attempt<75;attempt++){
    const rows=await pro.supabase.rpc('my_list_wellweb_bookings');expired=rows.data?.find(row=>row.id===expirationBooking.id);
    if(expired?.resolution_code==='PROFESSIONAL_RESPONSE_TIMEOUT')break;
    await pause(1000);
  }
  assert.equal(expired?.status,'CANCELLED','cron must expire a due pending request without frontend activity');
  assert.equal(expired?.resolution_code,'PROFESSIONAL_RESPONSE_TIMEOUT');
  await denied(pro.supabase,'decide_wellweb_booking',{p_booking_id:expirationBooking.id,p_accept:true,p_reason:null});
  const expiredProNotices=await pro.supabase.from('wellweb_notifications').select('id').eq('booking_id',expirationBooking.id).eq('event_type','BOOKING_EXPIRED');
  const expiredHotelNotices=await hotelA.supabase.from('wellweb_notifications').select('id').eq('booking_id',expirationBooking.id).eq('event_type','BOOKING_EXPIRED');
  assert.ok((expiredProNotices.data?.length??0)>0);assert.ok((expiredHotelNotices.data?.length??0)>0);
  const releasedSlots=await hotelA.supabase.rpc('wellweb_available_booking_slots',{p_professional_profile_id:profileId,p_service_id:serviceId,p_from:date,p_to:date});
  assert.ok(releasedSlots.data?.some(slot=>Date.parse(slot.starts_at)===Date.parse(slots[2].starts_at)),'expired pending request must release its slot');
  pass('background scheduler expires a due request, audits the timeout, notifies both parties, denies late response and releases the slot');

  const groupSlots = await hotelA.supabase.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: secondServiceId, p_from: date, p_to: date });
  assert.equal(groupSlots.error, null);
  const groupBooking = await request(hotelA.supabase, hotels[0], groupSlots.data.at(-1).starts_at, secondServiceId, 2);
  createdBookings.push(groupBooking.id);
  assert.equal(Number(groupBooking.total_price), 70);
  await denied(hotelA.supabase, 'request_wellweb_booking', { p_hotel_id: hotels[0], p_professional_profile_id: profileId, p_service_id: secondServiceId, p_starts_at: groupSlots.data.at(-2).starts_at, p_participants: 7 });
  pass('group booking validates capacity and calculates the per-student total through the local API');
  const fixedGroupSlots = await hotelA.supabase.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: fixedGroupServiceId, p_from: date, p_to: date });
  assert.equal(fixedGroupSlots.error, null);
  const fixedGroupBooking = await request(hotelA.supabase, hotels[0], fixedGroupSlots.data.at(-1).starts_at, fixedGroupServiceId, 5);
  createdBookings.push(fixedGroupBooking.id);
  assert.equal(Number(fixedGroupBooking.total_price), 120);
  pass('group booking with fixed service pricing does not multiply the service price by student count');

  const receivedByProfessional = await pro.supabase.rpc('my_list_wellweb_bookings');
  assert.equal(receivedByProfessional.error, null);
  assert.ok(receivedByProfessional.data.some(row => row.id === first.id && row.status === 'PENDING'), 'professional did not receive the hotel booking request');
  pass('real hotel booking request appears in the authenticated professional inbox');

  await denied(unapprovedHotel.supabase, 'request_wellweb_booking', { p_hotel_id: hotels[2], p_professional_profile_id: profileId, p_service_id: serviceId, p_starts_at: slots[0].starts_at, p_participants: 1 });
  await denied(hotelA.supabase, 'decide_wellweb_booking', { p_booking_id: first.id, p_accept: true, p_reason: null });
  await denied(otherPro.supabase, 'decide_wellweb_booking', { p_booking_id: first.id, p_accept: true, p_reason: null });
  await denied(otherPro.supabase, 'save_wellweb_professional_service', { p_service_id: serviceId, p_name: 'Foreign update', p_description: null, p_modality_slug: null, p_duration_minutes: 60, p_price: 1, p_active: true });
  await denied(hotelA.supabase, 'admin_review_partner', { p_partner_id: otherProUser, p_approve: true, p_note: 'Only admins may approve' });
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
    ? { row: statusA.data, hotel: hotelA.supabase, otherHotel: hotelB.supabase, hotelId: hotels[0] }
    : { row: statusB.data, hotel: hotelB.supabase, otherHotel: hotelA.supabase, hotelId: hotels[1] };
  const pending = statusA.data.status === 'PENDING' ? statusA.data : statusB.data;
  const pendingHotel = statusA.data.status === 'PENDING' ? hotelA.supabase : hotelB.supabase;
  await denied(pro.supabase,'delete_wellweb_availability_override',{p_override_id:availableOverrideId});
  pass('availability changes that would invalidate an existing confirmed reservation are rejected');
  await denied(confirmed.otherHotel, 'cancel_wellweb_booking', { p_booking_id: confirmed.row.id, p_reason: 'Unauthorized hotel fixture' });
  await denied(confirmed.hotel, 'cancel_wellweb_booking', { p_booking_id: confirmed.row.id, p_reason: null });
  await denied(confirmed.hotel, 'request_wellweb_booking', {
    p_hotel_id: confirmed.hotelId, p_professional_profile_id: profileId, p_service_id: serviceId,
    p_starts_at: slots[0].starts_at, p_participants: 1,
  });
  pass('a stale availability client cannot submit over an already confirmed booking');
  localSql(`update public.wellweb_bookings set starts_at=now()+interval '11 hours 59 minutes',ends_at=now()+interval '12 hours 59 minutes' where id='${confirmed.row.id}'::uuid`);
  await denied(confirmed.hotel, 'cancel_wellweb_booking', { p_booking_id: confirmed.row.id, p_reason: 'Inside hotel cancellation cutoff' });
  localSql(`update public.wellweb_bookings set starts_at=now()+interval '12 hours 1 minute',ends_at=now()+interval '13 hours 1 minute' where id='${confirmed.row.id}'::uuid`);
  await ok(confirmed.hotel, 'cancel_wellweb_booking', { p_booking_id: confirmed.row.id, p_reason: 'Fixture cancellation' });
  const released = await confirmed.hotel.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: serviceId, p_from: date, p_to: date });
  assert.ok(released.data?.some(slot => Date.parse(slot.starts_at) === Date.parse(slots[0].starts_at)));
  await ok(pro.supabase, 'decide_wellweb_booking', { p_booking_id: pending.id, p_accept: true, p_reason: null });
  await denied(pendingHotel, 'complete_wellweb_booking', { p_booking_id: pending.id, p_reason: null });
  localSql(`update public.wellweb_bookings set starts_at=now()-interval '2 hours',ends_at=now()-interval '30 minutes' where id='${pending.id}'::uuid and status='CONFIRMED'`);
  await ok(pendingHotel, 'complete_wellweb_booking', { p_booking_id: pending.id, p_reason: 'Fixture completed by hotel' });
  const manualCompletion = await pendingHotel.from('wellweb_bookings').select('status,completion_method,completed_by').eq('id', pending.id).single();
  assert.equal(manualCompletion.data?.status, 'COMPLETED');
  assert.equal(manualCompletion.data?.completion_method, 'MANUAL_HOTEL');
  const manualHistory = await pendingHotel.rpc('my_wellweb_booking_history', { p_booking_id: pending.id });
  assert.ok(manualHistory.data?.some(event => event.to_status === 'COMPLETED' && event.actor_type === 'HOTEL'));
  await denied(pendingHotel, 'cancel_wellweb_booking', { p_booking_id: pending.id, p_reason: 'Completed cannot be cancelled' });
  pass('hotel cannot complete before end, can complete after end, and completion history records HOTEL actor');

  await denied(pro.supabase, 'cancel_wellweb_booking', { p_booking_id: groupBooking.id, p_reason: 'Pending cannot be cancelled by professional' });
  await ok(pro.supabase, 'decide_wellweb_booking', { p_booking_id: groupBooking.id, p_accept: true, p_reason: null });
  await denied(pro.supabase,'delete_wellweb_weekly_availability',{p_slot_id:weeklySlotId});
  pass('weekly availability cannot be removed when it supports a confirmed reservation');
  await denied(pro.supabase, 'cancel_wellweb_booking', { p_booking_id: groupBooking.id, p_reason: null });
  localSql(`update public.wellweb_bookings set starts_at=now()+interval '23 hours 59 minutes',ends_at=now()+interval '25 hours 29 minutes' where id='${groupBooking.id}'::uuid`);
  await denied(pro.supabase, 'cancel_wellweb_booking', { p_booking_id: groupBooking.id, p_reason: 'Inside professional cancellation cutoff' });
  localSql(`update public.wellweb_bookings set starts_at=now()+interval '24 hours 1 minute',ends_at=now()+interval '25 hours 31 minutes' where id='${groupBooking.id}'::uuid`);
  await ok(pro.supabase, 'cancel_wellweb_booking', { p_booking_id: groupBooking.id, p_reason: 'Fixture professional cancellation' });
  const groupHistory = await pro.supabase.rpc('my_wellweb_booking_history', { p_booking_id: groupBooking.id });
  assert.ok(groupHistory.data?.some(event => event.to_status === 'CANCELLED' && event.reason === 'Fixture professional cancellation'));
  pass('professional cancellation requires CONFIRMED, a reason and at least 24 hours; hotel requires a reason and 12 hours');

  localSql(`update public.wellweb_bookings set starts_at=now()-interval '121 minutes',ends_at=now()-interval '61 minutes' where id='${groupBooking.id}'::uuid and status='CANCELLED'`);
  await ok(pro.supabase, 'decide_wellweb_booking', { p_booking_id: fixedGroupBooking.id, p_accept: true, p_reason: null });
  localSql(`update public.wellweb_bookings set starts_at=now()-interval '121 minutes',ends_at=now()-interval '61 minutes' where id='${fixedGroupBooking.id}'::uuid and status='CONFIRMED'`);
  let automaticCompletion;
  for (let attempt = 0; attempt < 75; attempt++) {
    const current = await pro.supabase.rpc('my_list_wellweb_bookings');
    automaticCompletion = current.data?.find(row => row.id === fixedGroupBooking.id);
    if (automaticCompletion?.status === 'COMPLETED') break;
    await pause(1000);
  }
  assert.equal(automaticCompletion?.status, 'COMPLETED', 'pg_cron did not complete the eligible local reservation');
  assert.equal(automaticCompletion?.completion_method, 'AUTOMATIC');
  const automaticHistory = await pro.supabase.rpc('my_wellweb_booking_history', { p_booking_id: fixedGroupBooking.id });
  assert.equal(automaticHistory.data?.filter(event => event.to_status === 'COMPLETED').length, 1);
  assert.ok(automaticHistory.data?.some(event => event.to_status === 'COMPLETED' && event.actor_type === 'SYSTEM'));
  const canceledAfterCron = await pro.supabase.rpc('my_list_wellweb_bookings');
  assert.equal(canceledAfterCron.data?.find(row => row.id === groupBooking.id)?.status, 'CANCELLED');
  const canceledHistoryAfterCron = await pro.supabase.rpc('my_wellweb_booking_history', { p_booking_id: groupBooking.id });
  assert.equal(canceledHistoryAfterCron.data?.filter(event => event.to_status === 'COMPLETED').length, 0);
  pass('pg_cron independently completes an eligible booking once and ignores a past cancelled booking');

  await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: serviceId, p_name: 'Fixture Yoga Updated', p_description: 'Updated service', p_modality_slug: null,
    p_duration_minutes: 90, p_price: 42.5, p_active: true,
  });
  const stagedServices = await ok(admin.supabase, 'admin_list_pending_professional_configurations', {});
  const stagedServiceProposal = stagedServices.find(row => row.profile_id === profileId);
  assert.ok(stagedServiceProposal?.pending_configuration.services.some(item => item.id === serviceId && item.name === 'Fixture Yoga Updated'));
  const serviceBeforeReview = await hotelA.supabase.from('professional_services').select('name,price').eq('id', serviceId).single();
  assert.equal(serviceBeforeReview.data?.name, 'Fixture Yoga Published');
  await ok(admin.supabase, 'admin_review_professional_configuration', { p_profile_id: profileId, p_approve: true, p_note: 'Approve service proposal' });
  const serviceAfterReview = await hotelA.supabase.from('professional_services').select('name,price').eq('id', serviceId).single();
  assert.equal(serviceAfterReview.data?.name, 'Fixture Yoga Updated');
  assert.equal(Number(serviceAfterReview.data?.price), 42.5);
  const snapshot = await pro.supabase.from('wellweb_bookings').select('service_name_snapshot,service_duration_minutes_snapshot,service_price_snapshot').eq('id', pending.id).single();
  assert.equal(snapshot.data.service_name_snapshot, 'Fixture Yoga Published');
  assert.equal(snapshot.data.service_duration_minutes_snapshot, 60);
  assert.equal(Number(snapshot.data.service_price_snapshot), 25);
  const rejectedServiceId = await ok(pro.supabase, 'save_wellweb_professional_service', {
    p_service_id: null, p_name: 'Fixture Pending Service', p_description: 'Awaiting review', p_modality_slug: null,
    p_duration_minutes: 45, p_price: 20, p_active: true,
  });
  const serviceNotPublic = await hotelA.supabase.from('professional_services').select('id').eq('id', rejectedServiceId);
  assert.equal(serviceNotPublic.data?.length, 0, 'pending service must not be offered to hotels');
  const ownPendingConfig = await pro.supabase.from('professional_profiles').select('pending_configuration').eq('id', profileId).single();
  assert.ok(ownPendingConfig.data?.pending_configuration?.services.some(item => item.id === rejectedServiceId));
  await ok(admin.supabase, 'admin_review_professional_configuration', { p_profile_id: profileId, p_approve: false, p_note: 'Fixture service requires corrections' });
  const ownReviewHistory = await pro.supabase.from('professional_profiles').select('service_review_history').eq('id', profileId).single();
  assert.ok(ownReviewHistory.data?.service_review_history?.at(-1)?.services?.some(item => item.id === rejectedServiceId));
  assert.equal(ownReviewHistory.data.service_review_history.at(-1).status, 'REJECTED');
  pass('professional can see their pending and rejected service proposals while hotels cannot book them');
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
  const notificationId=proNotifications.data.find(item=>item.event_type==='BOOKING_REQUESTED')?.id;
  assert.ok(notificationId);
  const outboxIdOutput=localSql(`update wellweb_private.notification_outbox set status='PROCESSING',attempts=1,processing_started_at=now() where channel='WHATSAPP' and notification_id='${notificationId}'::uuid returning id`);
  const candidateOutboxId=outboxIdOutput.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0];assert.ok(candidateOutboxId);
  const backend=createClient(endpoint,localServiceKey(),{auth:{persistSession:false,autoRefreshToken:false}});
  const ineligibleWhatsApp=await backend.rpc('check_wellweb_whatsapp_eligibility',{p_outbox_id:candidateOutboxId});
  assert.equal(ineligibleWhatsApp.error,null);assert.equal(ineligibleWhatsApp.data?.eligible,false);assert.equal(ineligibleWhatsApp.data?.reason,'WHATSAPP_DISABLED');
  localSql(`update wellweb_private.notification_outbox set status='PENDING',attempts=0,processing_started_at=null where id='${candidateOutboxId}'::uuid`);
  pass('notification event enqueues both channels and backend eligibility blocks WhatsApp after consent revocation');
  pass('notifications persist, remain private to recipients, and can be marked read');

  const all = await admin.supabase.rpc('admin_list_wellweb_bookings', { p_status: null, p_hotel_id: null, p_professional_profile_id: null, p_from: null, p_to: null });
  if (all.error) throw new Error('Admin global list did not load.');
  for (const id of createdBookings) assert.ok(all.data.some(row => row.id === id));
  pass('completed booking cannot be reopened and ADMIN can inspect global reservations/history');
} finally {
  const uuids = items => items.filter(value => /^[0-9a-f-]{36}$/i.test(value)).map(value => `'${value}'::uuid`).join(',');
  const hotels = uuids(hotelIds); const profiles = uuids(profileIds); const users = uuids(authUserIds);
  if (mediaPaths.length) {
    const serviceClient = createClient(endpoint, localServiceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
    const removed = await serviceClient.storage.from('wellweb-public-media').remove(mediaPaths);
    if (removed.error || removed.data?.length !== mediaPaths.length) throw new Error('Could not remove local fixture media through Storage API.');
  }
  if (hotels || profiles || users) {
    let cleanup = 'begin;';
    if (users) cleanup += `delete from public.partner_rejection_email_outbox where partner_id in (select id from public.app_users where auth_user_id in (${users})) or reviewer_id in (select id from public.app_users where auth_user_id in (${users}));`;
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
