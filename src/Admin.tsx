import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Building2, Check, CircleAlert, Plus, ShieldCheck, UserRound, X } from 'lucide-react';
import { publicImageUrl } from './lib/media';
import { supabase } from './lib/supabase';
import { modalitySlug } from './lib/catalog';
import { compareServiceReview, type ReviewService } from './lib/serviceReview';
import { AdminBookingManager } from './Bookings';

type Partner = {
  partner_id: string; account_type: 'HOTEL' | 'PROFESSIONAL'; email: string; display_name: string;
  phone_e164: string | null; approval_status: 'PENDING' | 'APPROVED' | 'REJECTED'; is_public: boolean;
  profile: Record<string, unknown>; pending_profile: Record<string, unknown> | null; created_at: string;
};
type Modality = { slug: string; name: string; active: boolean };
type ConfigurationReview = { profile_id:string; partner_id:string; display_name:string; email:string; pending_configuration:Record<string,unknown>; current_configuration:Record<string,unknown> };

function configurationChanges(review:ConfigurationReview) {
  const changes:string[]=[];
  const current=review.current_configuration, proposed=review.pending_configuration;
  const labels:Record<string,string>={name:'Nome',description:'Descrição',modality_slug:'Modalidade',duration_minutes:'Duração',price:'Preço',active:'Estado ativo',has_material:'Material disponível',allows_group:'Aula em grupo',max_students:'Capacidade',price_per_student:'Preço por aluno'};
  const oldServices=(current.services??[]) as Record<string,unknown>[]; const newServices=(proposed.services??[]) as Record<string,unknown>[];
  const oldMap=new Map(oldServices.map(item=>[String(item.id),item])); const newMap=new Map(newServices.map(item=>[String(item.id),item]));
  for(const [id,item] of newMap){const before=oldMap.get(id);if(!before){changes.push(`Serviço “${String(item.name)}” adicionado.`);continue;}for(const key of Object.keys(labels)){if(JSON.stringify(before[key]??null)!==JSON.stringify(item[key]??null))changes.push(`${String(item.name)}: ${labels[key]} alterado de “${String(before[key]??'—')}” para “${String(item[key]??'—')}”.`);}}
  for(const [id,item] of oldMap)if(!newMap.has(id))changes.push(`Serviço “${String(item.name)}” removido da proposta.`);
  return changes;
}

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
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [emailOutboxId, setEmailOutboxId] = useState('');
  const [emailState, setEmailState] = useState('');
  const [configurationReviews, setConfigurationReviews] = useState<ConfigurationReview[]>([]);
  const [selectedConfigurationId, setSelectedConfigurationId] = useState('');
  const [configurationReason, setConfigurationReason] = useState('');
  const [configurationDecision, setConfigurationDecision] = useState(false);
  const selected = partners.find(partner => partner.partner_id === selectedId);

  async function reload() {
    if (!supabase) return;
    const [partnerResult, modalityResult, configurationResult] = await Promise.all([
      supabase.rpc('admin_list_partner_reviews'),
      supabase.from('modality_catalog').select('slug,name,active').order('name'),
      supabase.rpc('admin_list_pending_professional_configurations'),
    ]);
    if (partnerResult.error) setError('Não foi possível carregar a revisão. Confirma que esta conta foi provisionada como administradora.');
    else setPartners((partnerResult.data ?? []) as Partner[]);
    if (!modalityResult.error) setModalities((modalityResult.data ?? []) as Modality[]);
    if (!configurationResult.error) {
      const rows=(configurationResult.data??[]) as ConfigurationReview[];
      setConfigurationReviews(rows);
      setSelectedConfigurationId(current=>rows.some(row=>row.profile_id===current)?current:rows[0]?.profile_id??'');
    }
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
    setNotice('Perfil aprovado.');
    await reload();
  }

  async function rejectPartner(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase || !selected || !rejectReason.trim()) return;
    setBusy(true); setError(''); setNotice(''); setEmailState('');
    const { data, error: actionError } = await supabase.rpc('admin_reject_partner_with_reason', { p_partner_id: selected.partner_id, p_reason: rejectReason.trim() });
    setBusy(false);
    if (actionError) { setError('A rejeição não foi guardada. Confirma o motivo e tenta novamente.'); return; }
    const outboxId = String(data);
    setEmailOutboxId(outboxId); setRejecting(false); setRejectReason('');
    setNotice('Rejeição e motivo registados.');
    await sendRejectionEmail(outboxId);
    await reload();
  }

  async function sendRejectionEmail(outboxId: string) {
    if (!supabase) return;
    const {data:retryState,error:retryError}=await supabase.rpc('admin_prepare_rejection_email_retry',{p_outbox_id:outboxId});
    if(retryError){setEmailState('Não foi possível consultar o estado do email.');return;}
    if(retryState==='SENT'){setEmailState('Email enviado com sucesso.');return;}
    if(retryState==='SENDING'){setEmailState('O envio ainda está a ser processado.');return;}
    setEmailState('A processar envio…');
    const { data, error: sendError } = await supabase.functions.invoke('send-partner-rejection', { body: { outbox_id: outboxId } });
    if (sendError) {
      const { data: state } = await supabase.rpc('admin_list_partner_rejection_email', { p_outbox_id: outboxId });
      const status = (state as { status?: string; last_error?: string } | null)?.status;
      setEmailState(status === 'FAILED' || status === 'PENDING' ? 'Email não enviado. A rejeição ficou registada; podes tentar novamente.' : status === 'SENT' ? 'Email enviado com sucesso.' : 'O envio ainda está a ser processado; consulta o estado antes de repetir.');
      return;
    }
    const status = (data as { status?: string } | null)?.status;
    setEmailState(status === 'SENT' ? 'Email enviado com sucesso.' : 'Email não enviado. A rejeição ficou registada; podes tentar novamente.');
  }

  async function decideConfiguration(approve:boolean) {
    if(!supabase||!configurationReview)return;
    if(!approve&&!configurationReason.trim())return;
    setBusy(true);setError('');setNotice('');
    const {data:outboxId,error:decisionError}=await supabase.rpc('admin_review_professional_configuration',{p_profile_id:configurationReview.profile_id,p_approve:approve,p_note:approve?null:configurationReason.trim()});
    setBusy(false);
    if(decisionError){setError('A decisão da configuração não foi guardada. Confirma os dados e tenta novamente.');return;}
    setNotice(approve?'Serviços e disponibilidade publicados em conjunto.':'Alterações propostas rejeitadas e motivo registado.');
    setConfigurationDecision(false);setConfigurationReason('');
    if(!approve&&typeof outboxId==='string'){setEmailOutboxId(outboxId);await sendRejectionEmail(outboxId);}
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
  const pendingDiff = selected?.pending_profile ? Object.entries(selected.pending_profile).filter(([key, value]) => {
    const proposed=key==='modalities'&&Array.isArray(value)?value.map(slug=>modalities.find(item=>item.slug===slug)?.name??slug):value;
    return JSON.stringify(proposed)!==JSON.stringify(selected.profile[key]??null);
  }) : [];
  const missingProfessionalFields = selected?.account_type === 'PROFESSIONAL' ? [
    (!selected.display_name?.trim() || selected.display_name.trim().length < 2) && 'Nome profissional',
    (!selected.phone_e164?.trim() || selected.phone_e164.trim().length < 8) && 'Contacto telefónico',
    (!(profile?.city as string | undefined)?.trim() || String(profile?.city).trim().length < 2) && 'Localidade',
    (!(profile?.service_area as string | undefined)?.trim() || String(profile?.service_area).trim().length < 2) && 'Área de atuação',
    !(profile?.primary_photo_path as string | undefined) && 'Imagem de destaque',
  ].filter(Boolean) as string[] : [];
  const configurationReview=configurationReviews.find(item=>item.profile_id===selectedConfigurationId);
  const configurationDiff=configurationReview?configurationChanges(configurationReview):[];
  const configurationServices=(configurationReview?.pending_configuration.services??[]) as ReviewService[];
  const publishedServices=(configurationReview?.current_configuration.services??[]) as ReviewService[];
  const modalityNames=new Map(modalities.map(item=>[item.slug,item.name]));

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
        {selected.pending_profile&&<section className="admin-change-diff"><h3>Alterações propostas</h3>{pendingDiff.length?pendingDiff.map(([key,value])=><article key={key}><strong>{key.replaceAll('_',' ')}</strong><div><small>Anterior</small><p>{key==='primary_photo_path'&&typeof selected.profile[key]==='string'?<img className="admin-diff-photo" src={publicImageUrl(selected.profile[key] as string)??undefined} alt="Imagem anterior"/>:key==='gallery_photo_paths'&&Array.isArray(selected.profile[key])?<div className="admin-diff-gallery">{(selected.profile[key] as string[]).map((path,index)=><img key={`${path}-${index}`} src={publicImageUrl(path)??undefined} alt={`Imagem anterior ${index+1}`}/>)}</div>:Array.isArray(selected.profile[key])?JSON.stringify(selected.profile[key]):String(selected.profile[key]??'—')}</p></div><div><small>Proposto</small><p>{key==='primary_photo_path'&&typeof value==='string'?<img className="admin-diff-photo" src={publicImageUrl(value)??undefined} alt="Imagem proposta"/>:key==='gallery_photo_paths'&&Array.isArray(value)?<div className="admin-diff-gallery">{(value as string[]).map((path,index)=><img key={`${path}-${index}`} src={publicImageUrl(path)??undefined} alt={`Imagem proposta ${index+1}`}/>)}</div>:Array.isArray(value)?JSON.stringify(value):String(value??'—')}</p></div></article>):<p>Não foram detetadas alterações nos campos deste perfil.</p>}</section>}
        {selected.account_type==='PROFESSIONAL'&&(selected.approval_status==='PENDING'||selected.pending_profile)&&<section className="approval-completeness"><h3>Validação para aprovação</h3>{missingProfessionalFields.length?<><p>Completa os seguintes dados antes da aprovação:</p><ul>{missingProfessionalFields.map(field=><li key={field}>{field}</li>)}</ul></>:<p>Os campos obrigatórios e a imagem principal estão presentes. A API também valida estes requisitos.</p>}</section>}
        <dl className="admin-profile-data">{Object.entries(profile).filter(([key, value]) => key !== 'primary_photo_path' && key !== 'gallery_photo_paths' && value !== null).map(([key, value]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd></div>)}</dl>
        {Array.isArray(profile.gallery_photo_paths) && <div className="admin-gallery">{profile.gallery_photo_paths.map((path, index) => { const url = typeof path === 'string' ? publicImageUrl(path) : null; return url ? <img key={`${path}-${index}`} src={url} alt={`Imagem ${index+1} do perfil`}/> : null; })}</div>}
        {selected.pending_profile&&selected.approval_status==='APPROVED'&&<details className="admin-published-version"><summary>Ver versão atualmente publicada</summary><dl className="admin-profile-data">{Object.entries(selected.profile).filter(([key,value])=>key!=='primary_photo_path'&&key!=='gallery_photo_paths'&&value!==null).map(([key,value])=><div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{Array.isArray(value)?value.join(', '):String(value)}</dd></div>)}</dl></details>}
        {(selected.approval_status === 'PENDING' || selected.pending_profile) && <div className="admin-actions"><button type="button" disabled={busy} className="secondary-button" onClick={() => {setRejectReason('');setRejecting(true);}}><X size={16}/> Rejeitar</button><button type="button" disabled={busy||missingProfessionalFields.length>0} className="primary-button" onClick={() => void decide(true)}><BadgeCheck size={16}/> Aprovar</button></div>}
        {emailState&&<div className="admin-notice" role="status">{emailState}{emailOutboxId&&emailState.includes('não enviado')&&<button type="button" disabled={busy} onClick={()=>void sendRejectionEmail(emailOutboxId)}>Tentar novamente</button>}</div>}
        {rejecting&&<form className="reject-reason-form" onSubmit={rejectPartner} role="dialog" aria-labelledby="reject-title"><h3 id="reject-title">Rejeitar cadastro</h3><p>O motivo será guardado no histórico e enviado ao email associado à conta.</p><label className="field"><span>Motivo obrigatório</span><textarea required minLength={1} maxLength={1000} value={rejectReason} onChange={event=>setRejectReason(event.target.value)} placeholder="Explica o que precisa de ser corrigido."/></label><div className="admin-actions"><button type="button" className="secondary-button" disabled={busy} onClick={()=>setRejecting(false)}>Voltar</button><button type="submit" className="secondary-button danger-button" disabled={busy||!rejectReason.trim()}>{busy?'A registar…':'Confirmar rejeição'}</button></div></form>}
      </> : <div className="admin-empty"><ShieldCheck/><p>Seleciona um parceiro para consultar o perfil completo.</p></div>}</section>
    </div>
    <section className="profile-card config-review-card"><div><p className="eyebrow">REVISÃO DE CONFIGURAÇÃO</p><h2>Serviços</h2><p>As alterações aos serviços não substituem a versão ativa até à decisão administrativa. A disponibilidade é aplicada de imediato.</p></div>
      {configurationReviews.length>0&&<label className="field"><span>Profissional</span><select value={selectedConfigurationId} onChange={event=>setSelectedConfigurationId(event.target.value)}>{configurationReviews.map(item=><option key={item.profile_id} value={item.profile_id}>{item.display_name} · {item.email}</option>)}</select></label>}
      {configurationReview?<><div className="configuration-diff-list">{configurationDiff.length?configurationDiff.map((item,index)=><p key={`${index}-${item}`}>{item}</p>):<p>Não foram detetadas diferenças nos serviços propostos.</p>}</div><section className="admin-pending-services"><h3>Detalhes dos serviços propostos</h3>{configurationServices.length?configurationServices.map(service=>{const current=publishedServices.find(item=>item.id===service.id);const fields=compareServiceReview(service,current,modalityNames);const changed=fields.some(field=>field.changed);return <article className="admin-service-review" key={service.id}><header><h4>{service.name}</h4><span className={`service-review-status ${!current?'new':changed?'changed':''}`}>{!current?'Novo serviço':changed?'Alteração proposta':'Sem alterações'}</span></header><dl>{fields.map(field=><div className={`service-review-field ${field.changed?'changed':''}`} key={field.key}><dt>{field.label}</dt><dd>{current?<><span><small>Publicado</small>{field.previous}</span><span><small>Proposto</small><strong>{field.value}</strong></span></>:<strong>{field.value}</strong>}</dd></div>)}</dl></article>;}):<p>A proposta não contém serviços.</p>}</section>{configurationDecision?<div className="reject-reason-form"><label className="field"><span>Motivo obrigatório para rejeitar</span><textarea required maxLength={1000} value={configurationReason} onChange={event=>setConfigurationReason(event.target.value)}/></label><div className="admin-actions"><button className="secondary-button" disabled={busy} onClick={()=>setConfigurationDecision(false)}>Voltar</button><button className="secondary-button danger-button" disabled={busy||!configurationReason.trim()} onClick={()=>void decideConfiguration(false)}>Confirmar rejeição</button></div></div>:<div className="admin-actions"><button className="secondary-button danger-button" disabled={busy} onClick={()=>setConfigurationDecision(true)}><X size={16}/> Rejeitar alterações</button><button className="primary-button" disabled={busy} onClick={()=>void decideConfiguration(true)}><BadgeCheck size={16}/> Aprovar serviços</button></div>}</>:<p>Não existem alterações de serviços a aguardar revisão.</p>}
    </section>
    <section className="profile-card modality-admin"><div><p className="eyebrow">CATÁLOGO</p><h2>Modalidades</h2><p>Modalidades ativas ficam disponíveis na seleção de perfis.</p></div><form onSubmit={addModality}><input aria-label="Nova modalidade" value={name} onChange={event => setName(event.target.value)} placeholder="Ex.: Pilates" maxLength={60} required/><button className="primary-button" disabled={busy}><Plus size={16}/> Adicionar</button></form><div className="modality-admin-list">{modalities.map(modality => <div key={modality.slug}><span>{modality.name}</span><button type="button" className={modality.active ? 'catalog-active' : ''} disabled={busy} onClick={() => void setActive(modality)}>{modality.active ? 'Ativa · desativar' : 'Inativa · ativar'}</button></div>)}</div></section>
    <AdminBookingManager />
  </section>;
}
