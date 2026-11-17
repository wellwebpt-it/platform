import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadTs(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const featured = await loadTs('../src/lib/featuredProfessionals.ts');
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const carousel = await readFile(new URL('../src/saiba-mais/ProfessionalCarousel.tsx', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/202611150001_build53_public_professional_availability.sql', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../src/saiba-mais/WorkflowSection.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

let passed = 0;
function check(name, fn) { fn(); passed++; process.stdout.write(`PASS ${name}\n`); }
async function checkAsync(name, fn) { await fn(); passed++; process.stdout.write(`PASS ${name}\n`); }

check('Saiba mais has a public route and the original directory route remains available', () => {
  assert.match(app, /path === '\/saiba-mais'.*<SaibaMais/);
  assert.match(app, /path === '\/profissionais'.*<Directory mode="professionals"/);
  const protectedPaths = app.match(/const protectedPath = ([^;]+);/)?.[1] ?? '';
  assert.doesNotMatch(protectedPaths, /saiba-mais/);
  assert.match(app, /onClick=\{\(\) => go\('\/saiba-mais'\)\}>Saiba mais/);
  assert.match(app, /aria-current=\{location\.pathname==='\/saiba-mais'\?'page':undefined\}/);
});

check('published professional selection excludes unapproved, private, inactive and undated profiles', () => {
  const dated = { published_at: '2026-11-14T12:00:00Z' };
  const profiles = [
    { ...dated, id: 'active', is_public: true, approval_status: 'APPROVED', account_status: 'ACTIVE' },
    { ...dated, id: 'pending', is_public: true, approval_status: 'PENDING', account_status: 'ACTIVE' },
    { ...dated, id: 'hidden', is_public: false, approval_status: 'APPROVED', account_status: 'ACTIVE' },
    { ...dated, id: 'suspended', is_public: true, approval_status: 'APPROVED', account_status: 'SUSPENDED' },
    { id: 'undated', published_at: null, is_public: true, approval_status: 'APPROVED', account_status: 'ACTIVE' },
    { ...dated, published_at: 'invalid', id: 'invalid-date', is_public: true, approval_status: 'APPROVED', account_status: 'ACTIVE' },
  ];
  assert.deepEqual(featured.selectFeaturedProfessionals(profiles).map(({ id }) => id), ['active']);
});

check('latest publications sort first and ties use stable profile ID ordering', () => {
  const profiles = [
    { id: 'z', published_at: '2026-11-14T10:00:00Z' },
    { id: 'b', published_at: '2026-11-15T10:00:00Z' },
    { id: 'a', published_at: '2026-11-15T10:00:00Z' },
  ];
  assert.deepEqual(featured.selectFeaturedProfessionals(profiles).map(({ id }) => id), ['a', 'b', 'z']);
});

check('selection policy can configure inclusion, ordering and a bounded result count', () => {
  const profiles = ['d', 'a', 'c', 'b'].map((id) => ({ id, published_at: '2026-11-14T10:00:00Z', pinned_order: id.charCodeAt(0) }));
  const selected = featured.selectFeaturedProfessionals(profiles, {
    limit: 2,
    include: (profile) => profile.id !== 'd',
    compare: (a, b) => a.pinned_order - b.pinned_order,
  });
  assert.deepEqual(selected.map(({ id }) => id), ['a', 'b']);
});

check('small and large result sets are not duplicated to fill the carousel', () => {
  const profiles = Array.from({ length: 23 }, (_, index) => ({ id: `p${index}`, published_at: `2026-11-${String(15 - Math.floor(index / 3)).padStart(2, '0')}T12:00:00Z` }));
  const few = featured.selectFeaturedProfessionals(profiles.slice(0, 2));
  const many = featured.selectFeaturedProfessionals(profiles, { limit: 30 });
  assert.equal(few.length, 2);
  assert.equal(many.length, 23);
  assert.equal(new Set(many.map(({ id }) => id)).size, 23);
  assert.match(carousel, /go\(`\/profissional\/\$\{profile\.id\}`\)/);
  assert.match(carousel, /scrollBy\(/);
  assert.match(carousel, /ArrowRight/);
  assert.match(carousel, /ArrowLeft/);
});

check('availability messages match backend summaries and omit unsupported counts or incomplete results', () => {
  assert.equal(featured.formatAvailabilitySummary({ professional_profile_id: 'p', summary_code: 'AVAILABLE_THIS_WEEK', days_until: 0 }), 'Disponível esta semana');
  assert.equal(featured.formatAvailabilitySummary({ professional_profile_id: 'p', summary_code: 'NEXT_SLOT', days_until: 1 }), 'Próxima vaga amanhã');
  assert.equal(featured.formatAvailabilitySummary({ professional_profile_id: 'p', summary_code: 'NEXT_SLOT', days_until: 3 }), 'Próxima vaga em 3 dias');
  assert.equal(featured.formatAvailabilitySummary({ professional_profile_id: 'p', summary_code: 'NONE_NEXT_7_DAYS', days_until: null }), 'Sem disponibilidade nos próximos 7 dias');
  assert.equal(featured.formatAvailabilitySummary({ professional_profile_id: 'p', summary_code: 'NO_ACTIVE_SERVICE', days_until: null }), null);
  assert.equal(featured.formatAvailabilitySummary(undefined), null);
  assert.doesNotMatch(carousel, /horários livres/);
});

await checkAsync('availability query deduplicates profile IDs and sends one aggregate batch', async () => {
  const calls = [];
  const result = await featured.getProfessionalAvailabilitySummary(['p1', 'p1', 'p2'], async (ids) => {
    calls.push(ids);
    return { data: [{ professional_profile_id: 'p1', summary_code: 'AVAILABLE_THIS_WEEK', days_until: 0 }], error: null };
  });
  assert.deepEqual(calls, [['p1', 'p2']]);
  assert.equal(result.get('p1')?.summary_code, 'AVAILABLE_THIS_WEEK');
  assert.equal(result.has('p2'), false);
});

await checkAsync('availability transport errors are not converted into empty schedules', async () => {
  await assert.rejects(featured.getProfessionalAvailabilitySummary(['p1'], async () => ({ data: null, error: new Error('network') })));
  await assert.rejects(featured.getProfessionalAvailabilitySummary(Array.from({ length: 51 }, (_, i) => `p${i}`), async () => ({ data: [], error: null })), /50 perfis/);
  assert.equal((await featured.getProfessionalAvailabilitySummary([], async () => { throw new Error('must not call'); })).size, 0);
});

check('Lisbon local weekday calculation handles both sides of spring and autumn clock changes', () => {
  assert.equal(featured.localLisbonWeekday('2026-03-29T00:30:00Z'), 0);
  assert.equal(featured.localLisbonWeekday('2026-03-29T01:30:00Z'), 0);
  assert.equal(featured.localLisbonWeekday('2026-10-25T00:30:00Z'), 0);
  assert.equal(featured.localLisbonWeekday('2026-10-25T01:30:00Z'), 0);
});

check('availability migration follows existing Lisbon scheduling, service duration, notice and occupancy rules', () => {
  assert.match(migration, /add column published_at timestamptz/);
  assert.match(migration, /wellweb_booking_interval_is_available\(/);
  assert.match(migration, /duration_minutes between 5 and 1440/);
  assert.match(migration, /interval '30 minutes'/);
  assert.match(migration, /interval '4 hours'/);
  assert.match(migration, /b\.status='CONFIRMED'/);
  assert.match(migration, /wellweb_local_datetime_to_utc/);
  assert.match(migration, /Europe\/Lisbon/);
  assert.match(migration, /date_trunc\('week'/);
  assert.match(migration, /p\.approval_status='APPROVED'/);
  assert.match(migration, /p\.is_public/);
  assert.match(migration, /u\.status='ACTIVE'/);
  assert.match(migration, /returns table\(professional_profile_id uuid, summary_code text, days_until smallint\)/);
  assert.doesNotMatch(migration, /returns table\([^)]*starts_at/);
  assert.match(migration, /grant execute on function public\.wellweb_public_professional_availability\(uuid\[\]\) to anon, authenticated/);
});

check('workflow animation is one-shot and uses reduced-motion support', () => {
  assert.match(workflow, /IntersectionObserver/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
});

process.stdout.write(`Build 5.3: ${passed} checks passed\n`);
