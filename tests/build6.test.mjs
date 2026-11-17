import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const migration=await readFile(new URL('../supabase/migrations/202611160004_build6_notifications_sla.sql',import.meta.url),'utf8');
const app=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
const bookings=await readFile(new URL('../src/Bookings.tsx',import.meta.url),'utf8');
const worker=await readFile(new URL('../supabase/functions/process-wellweb-notification-outbox/index.ts',import.meta.url),'utf8');
const webhook=await readFile(new URL('../supabase/functions/whatsapp-webhook/index.ts',import.meta.url),'utf8');
const docs=await readFile(new URL('../docs/requirements/build-6.md',import.meta.url),'utf8');
const checks=[
 ['SLA is calculated server-side for new pending bookings',()=>{assert.match(migration,/clock_timestamp\(\)\+interval '4 hours'/);assert.match(migration,/response_deadline_at<=clock_timestamp\(\)/)}],
 ['historic requests with NULL deadline are preserved',()=>{assert.doesNotMatch(migration,/update public\.wellweb_bookings[\s\S]{0,200}response_deadline_at\s*=/i)}],
 ['deadline blocks late professional decisions',()=>assert.match(migration,/clock_timestamp\(\)>=v_booking\.response_deadline_at/)],
 ['expiry is batched, locked and idempotent',()=>{assert.match(migration,/for update skip locked/i);assert.match(migration,/status='PENDING' and response_deadline_at is not null/i)}],
 ['expiry notifies hotel and professional with distinct timeout reason',()=>{assert.match(migration,/PROFESSIONAL_RESPONSE_TIMEOUT/);assert.match(migration,/BOOKING_EXPIRED/)}],
 ['consent history is versioned and phone-specific',()=>{assert.match(migration,/professional_whatsapp_consent_events/);assert.match(migration,/text_version/);assert.match(migration,/PHONE_CHANGED/)}],
 ['phone changes disable WhatsApp and direct writes are guarded',()=>{assert.match(migration,/disable_whatsapp_on_phone_change/);assert.match(migration,/guard_app_user_phone_change/)}],
 ['private outbox is idempotent and RLS protected',()=>{assert.match(migration,/unique\(notification_id,channel\)/);assert.match(migration,/enable row level security/i);assert.match(migration,/for update skip locked/i)}],
 ['consent preference is revalidated immediately before WhatsApp send',()=>{assert.match(worker,/check_wellweb_whatsapp_eligibility/);assert.match(worker,/META_WHATSAPP_TEST_RECIPIENTS/)}],
 ['Meta webhook validates HMAC and stores delivery events',()=>{assert.match(webhook,/x-hub-signature-256/);assert.match(webhook,/HMAC/);assert.match(webhook,/record_wellweb_whatsapp_delivery/)}],
 ['profile offers consent settings and privacy information',()=>{assert.match(app,/my_save_professional_whatsapp_preference/);assert.match(app,/privacidade/)}],
 ['booking UI presents Lisbon response deadlines and expiration reason',()=>{assert.match(bookings,/response_deadline_at/);assert.match(bookings,/PROFESSIONAL_RESPONSE_TIMEOUT/);assert.match(bookings,/Europe\/Lisbon/)}],
 ['Build 6 requirements and test limits are documented',()=>{assert.match(docs,/quatro horas/);assert.match(docs,/Meta/);assert.match(docs,/Pendências/)}],
];
for(const [name,fn] of checks){fn();console.log(`PASS ${name}`)}
