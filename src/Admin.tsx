import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Building2, Check, CircleAlert, Plus, ShieldCheck, UserRound, X } from 'lucide-react';
import { publicImageUrl } from './lib/media';
import { supabase } from './lib/supabase';
import { modalitySlug } from './lib/catalog';
import { AdminBookingManager } from './Bookings';

type Partner = {
  partner_id: string; account_type: 'HOTEL' | 'PROFESSIONAL'; email: string; display_name: string;
  phone_e164: string | null; approval_status: 'PENDING' | 'APPROVED' | 'REJECTED'; is_public: boolean;
  profile: Record<string, unknown>; pending_profile: Record<string, unknown> | null; created_at: string;
};
type Modality = { slug: string; name: string; active: boolean };

const statusLabel: Record<Partner['approval_status'], string> = { PENDING: 'Pendente', APPROVED: 'Aprovado', REJECTED: 'Rejeitado' };

export function AdminDashboard() {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [modalities, setModalities] = useState<Modality[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState<'ALL' | Partner['approval_status']>('ALL');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selected = partners.find(partner => partner.partner_id === selectedId);

  async function reload() {
    if (!supabase) return;
    const [partnerResult, modalityResult] = await Promise.all([
      supabase.rpc('admin_list_partner_reviews'),
      supabase.from('modality_catalog').select('slug,name,active').order('name'),
    ]);
    if (partnerResult.error) setError('Não foi possível carregar a revisão. Confirma que esta conta foi provisionada como administradora.');
    else setPartners((partnerResult.data ?? []) as Partner[]);
    if (!modalityResult.error) setModalities((modalityResult.data ?? []) as Modality[]);
  }

  useEffect(() => { void reload(); }, []);

  const visible = useMemo(() => partners.filter(partner => filter === 'ALL' || partner.approval_status === filter), [filter, partners]);

  async function decide(approve: boolean) {
    if (!supabase || !selected) return;
    setBusy(true); setError(''); setNotice('');
    const { error: actionError } = await supabase.rpc('admin_review_partner', {
      p_partner_id: selected.partner_id, p_approve: approve, p_note: null,
    });
    setBusy(false);
    if (actionError) { setError('A decisão não foi guardada. Atualiza a página e tenta novamente.'); return; }
    setNotice(approve ? 'Perfil aprovado.' : 'Registo rejeitado ou alterações pendentes rejeitadas.');
    await reload();
  }

  async function addModality(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase || !name.trim()) return;
    setBusy(true); setError(''); setNotice('');
    const { error: actionError } = await supabase.rpc('admin_add_wellweb_modality', { p_slug: modalitySlug(name), p_name: name.trim() });
    setBusy(false);
    if (actionError) { setError('Não foi possível adicionar. O nome ou identificador pode já existir.'); return; }
    setName(''); setNotice('Modalidade adicionada ao catálogo.'); await reload();
  }

  async function setActive(modality: Modality) {
    if (!supabase) return;
    setBusy(true); setError('');
    const { error: actionError } = await supabase.rpc('admin_set_wellweb_modality_active', { p_slug: modality.slug, p_active: !modality.active });
    setBusy(false);
    if (actionError) setError('Não foi possível atualizar a modalidade.'); else await reload();
  }

  const profile = selected?.pending_profile ?? selected?.profile;
  const photo = typeof profile?.primary_photo_path === 'string' ? publicImageUrl(profile.primary_photo_path) : null;
  const isHotel = selected?.account_type === 'HOTEL';

  return <section className="admin-page dashboard">
    <div className="dashboard-head"><div><p className="eyebrow">WELLWEB · ADMINISTRAÇÃO</p><h1>Revisão de parceiros.</h1><p>Consulta os registos e decide o que fica visível na comunidade.</p></div><div className="profile-avatar"><ShieldCheck/></div></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}{notice && <div className="admin-notice"><Check size={16}/>{notice}</div>}
    <div className="admin-stats"><div><span>Parceiros registados</span><strong>{partners.length}</strong></div><div><span>A aguardar revisão</span><strong>{partners.filter(item => item.approval_status === 'PENDING' || item.pending_profile).length}</strong></div><div><span>Modalidades ativas</span><strong>{modalities.filter(item => item.active).length}</strong></div></div>
    <div className="admin-layout">
      <section className="profile-card admin-list"><div className="admin-list-head"><div><h2>Parceiros</h2><p>Estado da aprovação e alterações por rever.</p></div><select aria-label="Filtrar estado" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="ALL">Todos</option><option value="PENDING">Pendentes</option><option value="APPROVED">Aprovados</option><option value="REJECTED">Rejeitados</option></select></div>
        {visible.length ? visible.map(partner => <button type="button" className={`admin-partner ${selectedId === partner.partner_id ? 'selected' : ''}`} key={partner.partner_id} onClick={() => setSelectedId(partner.partner_id)}><span className="admin-partner-icon">{partner.account_type === 'HOTEL' ? <Building2 size={18}/> : <UserRound size={18}/>}</span><span className="admin-partner-copy"><strong>{partner.account_type === 'HOTEL' ? String(partner.profile.name ?? partner.display_name) : partner.display_name}</strong><small>{partner.email}</small></span><span className={`review-badge ${partner.approval_status.toLowerCase()}`}>{statusLabel[partner.approval_status]}</span>{partner.pending_profile && <span className="review-changes">Alterações</span>}</button>) : <p className="admin-empty">Ainda não há registos neste estado.</p>}
      </section>
      <section className="profile-card admin-detail">{selected && profile ? <>
        <div className="admin-detail-head">{photo ? <img src={photo} alt="Fotografia principal do perfil"/> : <div className="admin-photo-placeholder">{isHotel ? <Building2/> : <UserRound/>}</div>}<div><p className="eyebrow">{isHotel ? 'ALOJAMENTO' : 'PROFISSIONAL'}</p><h2>{String((profile as Record<string, unknown>).name ?? (profile as Record<string, unknown>).public_name ?? selected.display_name)}</h2><span className={`review-badge ${selected.approval_status.toLowerCase()}`}>{statusLabel[selected.approval_status]}</span></div></div>
        <div className="admin-account-meta"><span>{selected.email}</span>{selected.phone_e164&&<span>{selected.phone_e164}</span>}<span>Registado em {new Date(selected.created_at).toLocaleDateString('pt-PT')}</span></div>
        {selected.pending_profile && <div className="inline-alert"><CircleAlert size={16}/> Esta versão aguarda revisão. A versão aprovada continua publicada até uma decisão.</div>}
        <dl className="admin-profile-data">{Object.entries(profile).filter(([key, value]) => key !== 'primary_photo_path' && key !== 'gallery_photo_paths' && value !== null).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd></div>)}</dl>
        {Array.isArray(profile.gallery_photo_paths) && <div className="admin-gallery">{profile.gallery_photo_paths.map((path, index) => { const url = typeof path === 'string' ? publicImageUrl(path) : null; return url ? <img key={`${path}-${index}`} src={url} alt={`Imagem ${index+1} do perfil`}/> : null; })}</div>}
        {selected.pending_profile&&selected.approval_status==='APPROVED'&&<details className="admin-published-version"><summary>Ver versão atualmente publicada</summary><dl className="admin-profile-data">{Object.entries(selected.profile).filter(([key,value])=>key!=='primary_photo_path'&&key!=='gallery_photo_paths'&&value!==null).map(([key,value])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{Array.isArray(value)?value.join(', '):String(value)}</dd></div>)}</dl></details>}
        {(selected.approval_status === 'PENDING' || selected.pending_profile) && <div className="admin-actions"><button type="button" disabled={busy} className="secondary-button" onClick={() => void decide(false)}><X size={16}/> Rejeitar</button><button type="button" disabled={busy} className="primary-button" onClick={() => void decide(true)}><BadgeCheck size={16}/> Aprovar</button></div>}
      </> : <div className="admin-empty"><ShieldCheck/><p>Seleciona um parceiro para consultar o perfil completo.</p></div>}</section>
    </div>
    <section className="profile-card modality-admin"><div><p className="eyebrow">CATÁLOGO</p><h2>Modalidades</h2><p>Modalidades ativas ficam disponíveis na seleção de perfis.</p></div><form onSubmit={addModality}><input aria-label="Nova modalidade" value={name} onChange={event => setName(event.target.value)} placeholder="Ex.: Pilates" maxLength={60} required/><button className="primary-button" disabled={busy}><Plus size={16}/> Adicionar</button></form><div className="modality-admin-list">{modalities.map(modality => <div key={modality.slug}><span>{modality.name}</span><button type="button" className={modality.active ? 'catalog-active' : ''} disabled={busy} onClick={() => void setActive(modality)}>{modality.active ? 'Ativa · desativar' : 'Inativa · ativar'}</button></div>)}</div></section>
    <AdminBookingManager />
  </section>;
}
