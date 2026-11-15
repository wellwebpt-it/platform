import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadTs(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}

const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const intro = await readFile(new URL('../src/saiba-mais/IntroSection.tsx', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../src/saiba-mais/WorkflowSection.tsx', import.meta.url), 'utf8');
const carousel = await readFile(new URL('../src/saiba-mais/ProfessionalCarousel.tsx', import.meta.url), 'utf8');
const card = await readFile(new URL('../src/saiba-mais/ProfessionalCard.tsx', import.meta.url), 'utf8');
const availability = await readFile(new URL('../src/saiba-mais/AvailabilityBadge.tsx', import.meta.url), 'utf8');
const directory = await readFile(new URL('../src/Directory.tsx', import.meta.url), 'utf8');
const filterBar = await readFile(new URL('../src/search/ProfessionalFilterBar.tsx', import.meta.url), 'utf8');
const search = await readFile(new URL('../src/lib/publicProfessionalSearch.ts', import.meta.url), 'utf8');
const hook = await readFile(new URL('../src/hooks/usePublicProfessionalSearch.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/202611160001_build54_public_professional_search.sql', import.meta.url), 'utf8');
const featured = await loadTs('../src/lib/featuredProfessionals.ts');

const hotelExpected = [
  'Serviços que se adaptam às suas necessidades',
  'Profissionais locais de confiança',
  'Experiências que valorizam a estadia',
  'Mais praticidade para a sua equipa',
];
const professionalExpected = [
  'Mais visibilidade para o seu talento',
  'Novas oportunidades de negócio',
  'Menos tempo à procura de clientes',
  'Maior autonomia para crescer',
];
const home = app.slice(app.indexOf('function Home('), app.indexOf('function AuthFrame('));
const footer = app.slice(app.indexOf('className="site-footer"'), app.indexOf('</footer>'));
const build54Styles = styles.slice(styles.indexOf('/* Build 5.4 — compact footer'));
const build54BenefitsStyles = styles.slice(styles.indexOf('/* Build 5.4: partner benefits'));
let passed = 0;
function check(name, fn) { fn(); passed++; process.stdout.write(`PASS ${name}\n`); }

function extractBenefits(constName) {
  const match = app.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `${constName} is defined`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(([, text]) => text);
}

check('WW-B54-001 homepage intro uses the exact approved copy', () => {
  assert.ok(home.includes('Conectamos hotéis e espaços de hospitalidade a profissionais locais de wellness. Do yoga ao surf, do mindfulness à massagem, encontre o melhor profissional e proporcione experiências únicas aos seus hóspedes'));
  assert.doesNotMatch(home, /Conectamos hotéis e hostels a profissionais locais de wellness/);
});

check('WW-B54-002 old secondary phrase is removed without leaving a trust row', () => {
  assert.doesNotMatch(home, /Experiências locais com significado|className="trust"/);
});

check('WW-B54-003 hotel CTA keeps the existing registration and session routing', () => {
  assert.match(home, /className="secondary-button" onClick=\{\(\) => go\(account\?\.status === 'ACTIVE' \? accountHome\(account\.account_type\) : account \? '\/entrar' : '\/registar\/hotel'\)\}>Sou um alojamento/);
  assert.match(home, /className="secondary-button"/);
});

check('WW-B54-004 homepage has no body Contacto button while the menu link remains', () => {
  assert.doesNotMatch(home, /Contacto/);
  assert.match(app, /onClick=\{\(\) => document\.getElementById\('contactos'\).*?>Contacto<\/button>/);
});

check('WW-B54-015 exact benefit copy and ordering are preserved for both audiences', () => {
  assert.deepEqual(extractBenefits('hotelPartnerBenefits'), hotelExpected);
  assert.deepEqual(extractBenefits('professionalPartnerBenefits'), professionalExpected);
  assert.equal((home.match(/className="editorial-intro partner-benefits"/g) ?? []).length, 1);
  assert.match(home, /className="experience-strip partner-benefit-groups"/);
  for (const oldCopy of ['O melhor de um destino', 'vive-se por dentro', 'Mar, corpo e liberdade', 'Ritmos para abrandar', 'Tempo para cuidar', 'Lugares com identidade']) assert.ok(!home.includes(oldCopy));
});

check('WW-B54-016 two audience groups support future actions without adding buttons', () => {
  assert.match(home, /partner-benefit-group" aria-labelledby="hotel-benefits-title"/);
  assert.match(home, /partner-benefit-group" aria-labelledby="professional-benefits-title"/);
  assert.doesNotMatch(home.slice(home.indexOf('className="editorial-intro partner-benefits"'), home.indexOf('className="directory-invite"')), /<button/);
  assert.match(build54BenefitsStyles, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(build54BenefitsStyles, /@media\(max-width:650px\)[\s\S]*?\.partner-benefit-groups\{grid-template-columns:minmax\(0,1fr\)/);
  assert.ok(home.includes('marketing-hero-background') && home.includes('directory-invite') && home.includes('join-banner'));
});

check('WW-B54-005/006 footer is compact and its original-proportion logo is smaller than the header', () => {
  assert.match(build54Styles, /\.site-footer\{[^}]*padding:20px 0 22px/);
  assert.match(build54Styles, /\.footer-brand\{width:132px;height:56px/);
  assert.match(build54Styles, /\.footer-brand img\{[^}]*object-fit:contain/);
  assert.match(footer, /wellweb-logo-transparent\.png/);
});

check('WW-B54-007 footer contacts are exact, vertical, clickable and focusable', () => {
  for (const snippet of ['mailto:info@wellweb.pt', 'info@wellweb.pt', 'https://www.instagram.com/wellweb.pt/', '@wellweb.pt', 'https://wa.me/351918483987', '+351918483987']) assert.ok(footer.includes(snippet));
  assert.match(footer, /footer-contact-links/);
  assert.match(build54Styles, /\.footer-contact-links\{display:grid;gap:7px/);
  assert.match(build54Styles, /\.footer-contact-links a:focus-visible/);
});

check('WW-B54-008 WhatsApp icon has the same dimensions and stroke system as other contact icons', () => {
  assert.match(app, /function WhatsAppIcon\(\).*?<svg width="18" height="18" viewBox="0 0 24 24"[^>]*strokeWidth="2"/);
  assert.match(build54Styles, /\.footer-contact-links a svg\{[^}]*flex:0 0 18px;width:18px;height:18px;stroke-width:2/);
});

check('WW-B54-009/010 About signature is centered and the three maintext paragraphs use centered cards without the left rule', () => {
  assert.match(intro, /about-signature/);
  assert.match(intro, /A Wellweb nasceu com o propósito de aproximar pessoas, espaços e profissionais/);
  assert.match(intro, /Somos uma plataforma digital que conecta/);
  assert.match(intro, /Acreditamos no poder das conexões/);
  assert.equal((intro.match(/className="about-intro-card"/g) ?? []).length, 3);
  assert.doesNotMatch(intro, /Saiba mais sobre a WellWeb/);
  assert.match(styles, /\.about-intro:before\{display:none\}/);
  assert.match(styles, /\.about-intro-copy \.about-intro-card\{[^}]*text-align:center/);
});

check('WW-B54-011 workflow has the four reference steps, future note and no icons', () => {
  const expected = [
    'Encontre o perfil certo', '01 / DESCOBRIR', 'Pesquise profissionais e encontre o serviço ideal, filtrando por modalidade, localização, preço e disponibilidade.',
    'O hotel solicita a sessão', '02 / RESERVAR', 'Envie o pedido e aguarde a confirmação da disponibilidade. Hotel e profissional recebem notificações sobre o agendamento.',
    'O bem-estar vai até ao hotel', '03 / EXPERIENCIAR', 'Com hora e preço confirmados, o profissional desloca-se ao hotel para proporcionar uma experiência de bem-estar ao hóspede.',
    'Partilhe a sua experiência', '04 / AVALIAR', 'Avaliação do profissional através de um link público, sem criar conta. Fortalece a reputação do profissional e aumenta a confiança dos alojamentos.',
  ];
  let last = -1;
  for (const text of expected) { const index = workflow.indexOf(text); assert.ok(index > last, `ordered workflow text: ${text}`); last = index; }
  assert.match(workflow, /Funcionalidade futura/);
  assert.doesNotMatch(workflow, /lucide-react|workflow-icon|<Icon/);
  assert.match(build54Styles, /grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles, /prefers-reduced-motion/);
});

check('WW-B54-012/012A real compact profile card uses database review aggregates and title matches reference', () => {
  assert.match(carousel, /Encontre o próximo parceiro/);
  assert.match(carousel, /usePublicProfessionalSearch/);
  assert.match(card, /profile\.public_name/);
  assert.match(card, /profile\.city/);
  assert.match(card, /ReviewRatingSummary/);
  assert.match(card, /guest_rating_count/);
});

check('WW-B54-012B availability is real, compact and overlaid on each actual photograph', () => {
  assert.match(card, /AvailabilityBadge summary=\{summary\} className="availability-badge-photo"/);
  assert.match(build54Styles, /\.availability-badge-photo\{position:absolute/);
  assert.match(carousel, /getProfessionalAvailabilitySummary/);
  assert.match(availability, /formatAvailabilitySummary/);
});

check('WW-B54-012C starting prices use public services and omit incomparable values', () => {
  const services = [
    { price: 40, currency: 'EUR', allows_group: false, price_per_student: false },
    { price: 25, currency: 'EUR', allows_group: false, price_per_student: false },
  ];
  assert.match(featured.formatStartingServicePrice(services), /Serviços a partir de 25,00/);
  assert.match(featured.formatStartingServicePrice([{ price: 9, currency: 'EUR', allows_group: true, price_per_student: true }]), /\/ pessoa/);
  assert.equal(featured.formatStartingServicePrice([...services, { price: 7, currency: 'USD', allows_group: false, price_per_student: false }]), null);
  assert.equal(featured.formatStartingServicePrice([...services, { price: 7, currency: 'EUR', allows_group: true, price_per_student: true }]), null);
  assert.equal(featured.formatStartingServicePrice([{ price: null, currency: 'EUR', allows_group: false, price_per_student: false }]), null);
  assert.match(card, /formatStartingServicePrice\(profile\.service_details\)/);
  assert.match(card, /startingPrice \?\? 'Consultar serviços'/);
  assert.match(card, /about-professional-card-footer/);
});

check('WW-B54-012D carousel navigates by button, horizontal touch/scroll, keyboard and progressive loading', () => {
  assert.match(carousel, /scrollBy\(/);
  assert.match(carousel, /onScroll=\{handleScroll\}/);
  assert.match(carousel, /ArrowRight/);
  assert.match(carousel, /ArrowLeft/);
  assert.match(carousel, /search\.loadMore\(\)/);
  assert.match(carousel, /PAGE_SIZE = 10/);
  assert.match(carousel, /Carregar mais profissionais/);
  assert.match(styles, /\.about-carousel-track\{scrollbar-width:none/);
  assert.match(styles, /\.about-carousel-track::\-webkit-scrollbar\{display:none/);
  assert.match(styles, /\.about-professional-card-footer\{display:flex/);
  assert.match(styles, /\.about-professional-card\{flex-basis:calc\(\(100% - 88px\)\/5\.4\)/);
});

check('WW-B54-013 filters reuse the directory control and validation components', () => {
  assert.match(carousel, /ProfessionalFilterBar/);
  assert.match(directory, /ProfessionalFilterBar/);
  assert.match(filterBar, /LanguageFilter/);
  assert.match(filterBar, /Todas as modalidades/);
  assert.match(filterBar, /Com material disponível/);
});

check('WW-B54-014 filters run globally before stable keyset pagination', () => {
  assert.match(search, /wellweb_search_public_professionals/);
  assert.match(search, /p_cursor_published_at/);
  assert.match(search, /hasMore: rows\.length > size/);
  assert.match(hook, /setTimeout/);
  assert.match(hook, /version\.current/);
  assert.match(hook, /new Set\(current\.map\(profile => profile\.id\)\)/);
  for (const field of ['p_search', 'p_city', 'p_modality', 'p_language', 'p_has_material']) assert.ok(migration.includes(field));
  assert.match(migration, /p\.modalities @> array\[p_modality\]/);
  assert.match(migration, /p\.languages @> array\[p_language\]/);
  assert.match(migration, /jsonb_array_elements/);
  assert.match(migration, /order by p\.published_at desc, p\.id asc/);
  assert.match(migration, /limit \(least\(greatest\(coalesce\(p_page_size, 10\), 1\), 30\) \+ 1\)/);
  assert.match(migration, /security invoker[\s\S]*?set search_path = ''/);
  assert.match(migration, /from public\.public_professional_directory p/);
  assert.match(migration, /grant execute on function .* to anon, authenticated/);
});

check('Directory and carousel share global-search pagination and retain real empty/error states', () => {
  assert.match(directory, /usePublicProfessionalSearch\(filters, \{ pageSize: 24/);
  assert.match(directory, /Carregar mais profissionais/);
  assert.match(directory, /Não encontrámos resultados/);
  assert.match(hook, /Não foi possível pesquisar os profissionais/);
  assert.match(carousel, /Não encontrámos profissionais com estes filtros/);
  assert.match(carousel, /search\.problem/);
});

check('responsiveness covers supplied 320px through desktop widths without fixed viewport overflow', () => {
  assert.match(build54Styles, /@media\(max-width:1050px\)/);
  assert.match(build54Styles, /@media\(max-width:650px\)/);
  assert.match(build54Styles, /@media\(max-width:390px\)/);
  assert.match(build54Styles, /grid-template-columns:minmax\(0,1fr\)/);
  assert.doesNotMatch(build54Styles, /width:100vw/);
});

console.log(`Build 5.4: ${passed} checks passed`);
