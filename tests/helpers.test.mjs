import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

async function loadTs(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const access = await loadTs('../src/lib/access.ts');
const registration = await loadTs('../src/lib/registration.ts');
const catalog = await loadTs('../src/lib/catalog.ts');
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  process.stdout.write(`PASS ${name}\n`);
}

check('active accounts can access only the dashboard matching their immutable account type', () => {
  assert.equal(access.canAccessPath('HOTEL', 'ACTIVE', '/hotel'), true);
  assert.equal(access.canAccessPath('HOTEL', 'ACTIVE', '/profissional'), false);
  assert.equal(access.canAccessPath('PROFESSIONAL', 'ACTIVE', '/profissional'), true);
  assert.equal(access.canAccessPath('PROFESSIONAL', 'ACTIVE', '/hotel'), false);
});

check('incomplete, invited and suspended accounts cannot access private areas', () => {
  assert.equal(access.canAccessPath(null, null, '/hotel'), false);
  assert.equal(access.canAccessPath('HOTEL', 'INVITED', '/hotel'), false);
  assert.equal(access.canAccessPath('PROFESSIONAL', 'SUSPENDED', '/profissional'), false);
});

check('administrator area is available only to active ADMIN accounts', () => {
  assert.equal(access.accountHome('ADMIN'), '/admin');
  assert.equal(access.canAccessPath('ADMIN', 'ACTIVE', '/admin'), true);
  assert.equal(access.canAccessPath('HOTEL', 'ACTIVE', '/admin'), false);
  assert.equal(access.canAccessPath('PROFESSIONAL', 'ACTIVE', '/admin'), false);
  assert.equal(access.canAccessPath('ADMIN', 'SUSPENDED', '/admin'), false);
  assert.equal(access.canAccessPath('HOTEL', 'ACTIVE', '/reservas'), true);
  assert.equal(access.canAccessPath('PROFESSIONAL', 'ACTIVE', '/reservas'), true);
  assert.equal(access.canAccessPath('ADMIN', 'ACTIVE', '/reservas'), false);
  assert.equal(access.canAccessPath('HOTEL', 'ACTIVE', '/reservar/profile-id'), true);
  assert.equal(access.canAccessPath('PROFESSIONAL', 'ACTIVE', '/reservar/profile-id'), false);
});

check('modality ids are stable and languages expose text labels with image flag paths', () => {
  assert.equal(catalog.modalitySlug('Meditação'), 'meditacao');
  assert.equal(catalog.modalitySlug('Yoga & movimento'), 'yoga-movimento');
  assert.equal(catalog.LANGUAGE_OPTIONS.length, 6);
  assert.equal(catalog.languageLabel('pt'), 'Português');
  assert.deepEqual(catalog.LANGUAGE_OPTIONS.map(({ value, label }) => [value, label]), [
    ['pt', 'Português'], ['en', 'Inglês'], ['es', 'Espanhol'],
    ['fr', 'Francês'], ['it', 'Italiano'], ['de', 'Alemão'],
  ]);
  assert.equal(catalog.LANGUAGE_OPTIONS.every(language => language.flag.startsWith('/flags/')), true);
  assert.equal(catalog.LANGUAGE_OPTIONS.some(language => /\p{Regional_Indicator}/u.test(language.label)), false);
});

check('all six language flag assets are present as standard PNG files', () => {
  for (const language of catalog.LANGUAGE_OPTIONS) {
    const asset = new URL(`../public${language.flag}`, import.meta.url);
    const bytes = readFileSync(asset);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
});

check('registration validation accepts valid hotel and professional data', () => {
  const common = { displayName: 'Ana Silva', email: 'ana@example.pt', password: 'bem-estar-2026', passwordConfirmation: 'bem-estar-2026', phone: '+351912345678', city: 'Ericeira' };
  assert.deepEqual(registration.validateRegistration({ ...common, hotelName: 'Hotel Mar', address: 'Rua do Mar 1' }, 'HOTEL'), {});
  assert.deepEqual(registration.validateRegistration({ ...common, serviceArea: 'Yoga e movimento' }, 'PROFESSIONAL'), {});
});

check('registration role is fixed to HOTEL or PROFESSIONAL and metadata contains profile fields', () => {
  const common = { displayName: 'Ana Silva', email: 'ana@example.pt', password: 'bem-estar-2026', passwordConfirmation: 'bem-estar-2026', phone: '+351912345678', city: 'Ericeira', hotelName: 'Hotel Mar', address: 'Rua do Mar 1' };
  const metadata = registration.registrationMetadata(common, 'HOTEL');
  assert.equal(metadata.account_type, 'HOTEL');
  assert.equal(metadata.wellweb_signup, true);
  assert.equal(metadata.hotel_name, 'Hotel Mar');
  assert.equal('ADMIN' in metadata, false);
});

check('invalid email, weak password, mismatched password and non-E.164 phone are rejected', () => {
  const errors = registration.validateRegistration({ displayName: 'A', email: 'bad', password: 'short', passwordConfirmation: 'different', phone: '912345678', city: '' }, 'PROFESSIONAL');
  assert.ok(errors.email);
  assert.ok(errors.password);
  assert.ok(errors.passwordConfirmation);
  assert.ok(errors.phone);
  assert.ok(errors.city);
  assert.ok(errors.displayName);
  assert.ok(errors.serviceArea);
});
const migration = await readFile(new URL('../supabase/migrations/202611050002_partner_approval_taxonomy_admin.sql', import.meta.url), 'utf8');
check('database migration gates public listing on partner approval', () => {
  assert.match(migration, /approval_status = 'APPROVED'/);
  assert.match(migration, /drop policy if exists "public_read_listed_professionals"/);
  assert.match(migration, /drop policy if exists "public_read_listed_hotels"/);
});

check('database administration and profile edits require protected functions', () => {
  assert.match(migration, /function public\.is_wellweb_admin\(\)/);
  assert.match(migration, /if not public\.is_wellweb_admin\(\) then raise exception/);
  assert.match(migration, /revoke update \(city, service_area, bio, public_name/);
  assert.match(migration, /pending_profile = v_payload/);
});
const mediaGuard = await readFile(new URL('../supabase/migrations/202611050004_preserve_published_media.sql', import.meta.url), 'utf8');
check('approved public profile media cannot be replaced or deleted before review', () => {
  assert.match(mediaGuard, /function public\.wellweb_media_path_is_published/);
  assert.match(mediaGuard, /drop policy "wellweb_profile_media_update_own"/);
  assert.match(mediaGuard, /drop policy "wellweb_profile_media_delete_own"/);
  assert.match(mediaGuard, /not \(select public\.wellweb_media_path_is_published\(name\)\)/);
});
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
check('session lookup failures leave the public UI usable and private routes ask for login', () => {
  assert.match(appSource, /getSession\(\)[\s\S]*?\.catch\(\(\) => \{[\s\S]*?setAuthReady\(true\)/);
  assert.match(appSource, /if \(protectedPath && !authReady\)/);
  assert.match(appSource, /if \(protectedPath && isSupabaseConfigured && !user\)/);
});
process.stdout.write(`${passed} checks passed.\n`);
