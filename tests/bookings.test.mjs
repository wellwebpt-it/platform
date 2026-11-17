import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/202611060001_booking_management.sql', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/Bookings.tsx', import.meta.url), 'utf8');
const directory = await readFile(new URL('../src/Directory.tsx', import.meta.url), 'utf8');
const integration = await readFile(new URL('../scripts/test-bookings-local.mjs', import.meta.url), 'utf8');

const checks = [
  ['reservation state set is persisted with the required lifecycle', () => {
    for (const status of ['PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED', 'COMPLETED']) assert.match(sql, new RegExp(`'${status}'`));
  }],
  ['booking records retain service snapshots, participants and private guest notes', () => {
    for (const column of ['service_name_snapshot','service_duration_minutes_snapshot','service_price_snapshot','service_currency_snapshot','starts_at','ends_at','participants','guest_name','notes']) assert.match(sql, new RegExp(`\\b${column}\\b`));
  }],
  ['new booking requests are pending and notify the assigned professional', () => {
    assert.match(sql, /nullif\(trim\(p_notes\),''\),'PENDING'\)/);
    assert.match(sql, /'BOOKING_REQUESTED','Novo pedido de reserva'/);
  }],
  ['only approved hotels can request approved professional services', () => {
    assert.match(sql, /h\.approval_status='APPROVED'/);
    assert.match(sql, /p\.approval_status='APPROVED' and p\.is_public/);
    assert.match(sql, /s\.id=p_service_id[^;]+s\.active/s);
  }],
  ['acceptance serializes per professional and checks half-open overlap against confirmed bookings', () => {
    assert.match(sql, /pg_advisory_xact_lock\(hashtext\('wellweb-booking-'/);
    assert.match(sql, /tstzrange\(b\.starts_at,b\.ends_at,'\[\)'\) && tstzrange\(v_booking\.starts_at,v_booking\.ends_at,'\[\)'\)/);
  }],
  ['booking and event tables deny direct writes to client roles', () => {
    assert.match(sql, /revoke insert, update, delete, truncate, references, trigger on public\.professional_weekly_availability,[\s\S]+from anon, authenticated/);
  }],
  ['hotel and professional reservation lists are scoped to their authenticated account', () => {
    assert.match(sql, /function public\.my_list_wellweb_bookings\(\)/);
    assert.match(sql, /v_actor\.account_type='HOTEL' and exists\(select 1 from public\.hotel_members/);
    assert.match(sql, /v_actor\.account_type='PROFESSIONAL' and p\.user_id=v_actor\.id/);
  }],
  ['status changes record actor, reason and notification recipient', () => {
    assert.match(sql, /wellweb_booking_history\(booking_id,from_status,to_status,actor_user_id,reason\)/);
    for (const event of ['BOOKING_CONFIRMED','BOOKING_REJECTED','BOOKING_CANCELLED','BOOKING_COMPLETED']) assert.match(sql, new RegExp(event));
    assert.match(sql, /function public\.mark_wellweb_notification_read/);
  }],
  ['booking request UI includes review step, price/duration summary and confirmation reference', () => {
    assert.match(app, /setStep\('review'\)/);
    assert.match(app, /Preço indicativo/);
    assert.match(app, /setReference\(result\.reference/);
    assert.match(app, /wellweb_available_booking_slots/);
  }],
  ['hotel booking service query requires active services with valid duration and reports query failures', () => {
    assert.match(app, /from\('professional_services'\)[\s\S]+?eq\('active', true\)[\s\S]+?not\('duration_minutes', 'is', null\)[\s\S]+?gte\('duration_minutes', 5\)[\s\S]+?lte\('duration_minutes', 1440\)/);
    assert.match(app, /if \(serviceResult\.error\) \{ setError\(serviceQueryErrorText/);
    assert.match(app, /if \(!services\.length\) return[\s\S]+?não tem serviços ativos com duração válida/);
    assert.match(integration, /hotelA\.supabase\.from\('professional_services'\)/);
    assert.match(integration, /authenticated HOTEL session reads both active valid services with RLS enabled/);
    assert.match(integration, /real hotel booking request appears in the authenticated professional inbox/);
  }],
  ['hotel profiles offer booking entry points and public service details', () => {
    assert.match(directory, /Solicitar reserva/);
    assert.match(directory, /service_details/);
  }],
  ['professional workspace manages services, weekly availability, exceptions and decisions', () => {
    for (const action of ['save_wellweb_professional_service','save_wellweb_weekly_availability','save_wellweb_availability_override','decide_wellweb_booking']) assert.match(app, new RegExp(action));
    assert.match(app, /Europe\/Lisbon/);
  }],
];

for (const [name, run] of checks) {
  run();
  process.stdout.write(`PASS ${name}\n`);
}
process.stdout.write(`${checks.length} booking checks passed.\n`);
