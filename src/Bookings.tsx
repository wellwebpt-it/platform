import { useCallback, useEffect, useMemo, useState } from 'react';
import { BadgeCheck, Bell, Building2, CalendarDays, Check, Clock3, Plus, Save, Search, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { supabase } from './lib/supabase';

type AccountType = 'HOTEL' | 'PROFESSIONAL' | 'ADMIN';
type BookingStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED';
type Account = { id: string; account_type: AccountType; status: string };
type HotelChoice = { id: string; name: string; city: string; approval_status: string };
type Service = { id: string; name: string; description: string | null; modality_slug: string | null; duration_minutes: number | null; price: number | null; currency: string; active: boolean };
type Slot = { starts_at: string; ends_at: string };
type Booking = {
  id: string; booking_reference: string; hotel_id: string; hotel_name: string;
  professional_profile_id: string; professional_name: string; service_id: string | null;
  service_name_snapshot: string; service_duration_minutes_snapshot: number;
  service_price_snapshot: number | null; service_currency_snapshot: string;
  starts_at: string; ends_at: string; participants: number; guest_name: string | null;
  notes: string | null; status: BookingStatus; created_at: string;
};
type Notification = { id: string; booking_id: string; event_type: string; title: string; body: string; created_at: string; read_at: string | null };
type History = { id: string; from_status: string | null; to_status: string; reason: string | null; created_at: string; actor_name: string; actor_type: string };
type Weekly = { id: string; day_of_week: number; start_time: string; end_time: string };
type Override = { id: string; starts_at: string; ends_at: string; override_type: 'AVAILABLE' | 'BLOCKED'; reason: string | null };
type Modality = { slug: string; name: string; active: boolean };

const statusNames: Record<BookingStatus, string> = { PENDING: 'Pendente', CONFIRMED: 'Confirmada', REJECTED: 'Rejeitada', CANCELLED: 'Cancelada', COMPLETED: 'Concluída' };
const weekdays = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

function parseRows<T>(data: unknown): T[] { return (Array.isArray(data) ? data : []) as T[]; }
function formatDate(value: string, includeTime = true) {
  return new Date(value).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', dateStyle: 'medium', ...(includeTime ? { timeStyle: 'short' as const } : {}) });
}
function formatPrice(price: number | null, currency = 'EUR') {
  return price === null ? 'Preço a combinar' : new Intl.NumberFormat('pt-PT', { style: 'currency', currency }).format(price);
}
function todayLisbon() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return `${parts.find(x => x.type === 'year')?.value}-${parts.find(x => x.type === 'month')?.value}-${parts.find(x => x.type === 'day')?.value}`;
}
function lisbonInputToIso(value: string) {
  const [date, time] = value.split('T');
  if (!date || !time) throw new Error('Indica data e hora.');
  const desired = Date.parse(`${date}T${time}:00Z`);
  let guess = desired;
  for (let index = 0; index < 4; index++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(guess));
    const local = `${parts.find(x => x.type === 'year')?.value}-${parts.find(x => x.type === 'month')?.value}-${parts.find(x => x.type === 'day')?.value}T${parts.find(x => x.type === 'hour')?.value}:${parts.find(x => x.type === 'minute')?.value}:00Z`;
    guess += desired - Date.parse(local);
  }
  return new Date(guess).toISOString();
}
function errorText(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String(error.message);
    if (/no longer available|occupies this time|outside availability|blocked/i.test(message)) return 'Este horário deixou de estar disponível. Escolhe outra hora.';
    if (/approved hotel|approved professional|approved service/i.test(message)) return 'A reserva exige um hotel aprovado, um profissional aprovado e um serviço ativo.';
  }
  return fallback;
}
function serviceQueryErrorText(error: { code?: string } & { status?: number }) {
  if (error.status === 401 || error.status === 403 || error.code === '42501') {
    return 'A conta HOTEL não tem autorização para consultar os serviços deste perfil. Confirma que o hotel e o profissional estão ativos e aprovados.';
  }
  if (!error.status || error.status === 0) return 'Não foi possível ligar ao catálogo de serviços. Verifica a ligação ao Supabase local e tenta novamente.';
  return `Não foi possível consultar os serviços (erro ${error.code ?? error.status}). Tenta novamente.`;
}

export function BookingRequestPage({ profileId, account, go, setNotice }: { profileId: string; account: Account; go: (path: string) => void; setNotice: (text: string) => void }) {
  const [hotels, setHotels] = useState<HotelChoice[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState('');
  const [hotelId, setHotelId] = useState('');
  const [date, setDate] = useState(todayLisbon());
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotStart, setSlotStart] = useState('');
  const [participants, setParticipants] = useState('1');
  const [guest, setGuest] = useState('');
  const [notes, setNotes] = useState('');
  const [step, setStep] = useState<'form' | 'review' | 'sent'>('form');
  const [reference, setReference] = useState('');
  const [loading, setLoading] = useState(true);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    void (async () => {
      if (!supabase || account.account_type !== 'HOTEL') { setError('Esta ação está disponível apenas para hotéis autenticados.'); setLoading(false); return; }
      const { data: memberships, error: membershipError } = await supabase.from('hotel_members').select('hotel_id').eq('user_id', account.id).eq('status', 'ACTIVE');
      const ids = (memberships ?? []).map(row => row.hotel_id);
      if (membershipError) { if (live) { const status = (membershipError as typeof membershipError & { status?: number }).status; setError(status === 401 || status === 403 || membershipError.code === '42501' ? 'A sessão HOTEL não tem autorização para consultar os alojamentos associados.' : 'Não foi possível carregar os alojamentos. Verifica a ligação ao Supabase local e tenta novamente.'); setLoading(false); } return; }
      const [hotelResult, serviceResult] = await Promise.all([
        ids.length ? supabase.from('hotels').select('id,name,city,approval_status').in('id', ids).order('name') : Promise.resolve({ data: [], error: null }),
        supabase.from('professional_services').select('id,name,description,modality_slug,duration_minutes,price,currency,active').eq('professional_profile_id', profileId).eq('active', true).not('duration_minutes', 'is', null).gte('duration_minutes', 5).lte('duration_minutes', 1440).order('name'),
      ]);
      if (!live) return;
      if (hotelResult.error) { const status = (hotelResult.error as typeof hotelResult.error & { status?: number }).status; setError(status === 401 || status === 403 || hotelResult.error.code === '42501' ? 'A sessão HOTEL não tem autorização para consultar os alojamentos associados.' : 'Não foi possível carregar os alojamentos. Verifica a ligação ao Supabase local e tenta novamente.'); setLoading(false); return; }
      if (serviceResult.error) { setError(serviceQueryErrorText(serviceResult.error)); setHotels((hotelResult.data ?? []) as HotelChoice[]); setLoading(false); return; }
      const hotelRows = (hotelResult.data ?? []) as HotelChoice[];
      const serviceRows = (serviceResult.data ?? []) as Service[];
      setHotels(hotelRows); setServices(serviceRows);
      setHotelId(hotelRows.find(h => h.approval_status === 'APPROVED')?.id ?? '');
      setServiceId(serviceRows[0]?.id ?? '');
      setLoading(false);
    })().catch(() => {
      if (live) { setError('A ligação ao Supabase local falhou ao carregar serviços ou alojamentos. Verifica a rede e tenta novamente.'); setLoading(false); }
    });
    return () => { live = false; };
  }, [account.account_type, account.id, profileId]);

  useEffect(() => {
    let live = true;
    setSlots([]); setSlotStart('');
    if (!supabase || !serviceId || !date || !hotelId || !hotels.find(h => h.id === hotelId && h.approval_status === 'APPROVED')) return;
    setSlotsLoading(true);
    void supabase.rpc('wellweb_available_booking_slots', { p_professional_profile_id: profileId, p_service_id: serviceId, p_from: date, p_to: date })
      .then(({ data, error: rpcError }) => {
        if (!live) return;
        if (rpcError) setError(errorText(rpcError, 'Não foi possível consultar horários.'));
        else { setError(''); setSlots(parseRows<Slot>(data)); }
        setSlotsLoading(false);
      });
    return () => { live = false; };
  }, [date, hotelId, hotels, profileId, serviceId]);

  const service = services.find(item => item.id === serviceId);
  const hotel = hotels.find(item => item.id === hotelId);
  const slot = slots.find(item => item.starts_at === slotStart);
  const submit = async () => {
    if (!supabase || !service || !hotel || !slot) return;
    setBusy(true); setError('');
    const { data, error: submitError } = await supabase.rpc('request_wellweb_booking', {
      p_hotel_id: hotel.id, p_professional_profile_id: profileId, p_service_id: service.id,
      p_starts_at: slot.starts_at, p_participants: Number(participants), p_guest_name: guest.trim() || null, p_notes: notes.trim() || null,
    });
    setBusy(false);
    if (submitError) { setError(errorText(submitError, 'Não foi possível enviar o pedido. Atualiza os horários e tenta novamente.')); return; }
    const result = data as { reference?: string };
    setReference(result.reference ?? ''); setStep('sent'); setNotice('Pedido enviado ao profissional para aprovação.');
  };

  if (loading) return <section className="booking-page"><div className="loading-line"><div className="spinner"/> A preparar o pedido…</div></section>;
  if (error) return <section className="booking-page"><button className="back-link" onClick={() => go(`/profissional/${profileId}`)}>← Voltar ao perfil profissional</button><div className="inline-alert" role="alert">{error}</div><button className="secondary-button" onClick={() => window.location.reload()}>Tentar novamente</button></section>;
  if (step === 'sent') return <section className="booking-page"><div className="booking-confirmation"><BadgeCheck size={36}/><p className="eyebrow">PEDIDO ENVIADO</p><h1>A experiência começa com um pedido.</h1><p>O profissional irá analisar o horário e responder. A reserva não fica confirmada antes dessa aprovação.</p><div className="booking-reference"><span>Referência</span><strong>{reference}</strong><span>Estado · Pendente</span></div><button className="primary-button" onClick={() => go('/reservas')}>Acompanhar pedido</button></div></section>;
  if (!hotels.some(h => h.approval_status === 'APPROVED')) return <section className="booking-page"><button className="back-link" onClick={() => go('/profissionais')}>← Voltar aos profissionais</button><div className="inline-alert">A conta ainda não tem um alojamento aprovado. Só hotéis ativos e aprovados podem solicitar reservas.</div></section>;
  if (!services.length) return <section className="booking-page"><button className="back-link" onClick={() => go(`/profissional/${profileId}`)}>← Voltar ao perfil profissional</button><div className="inline-alert">Este profissional não tem serviços ativos com duração válida disponíveis para reserva.</div></section>;
  return <section className="booking-page">
    <button className="back-link" onClick={() => go(`/profissional/${profileId}`)}>← Voltar ao perfil profissional</button>
    <div className="booking-heading"><p className="eyebrow">PEDIDO DE RESERVA · SUJEITO A APROVAÇÃO</p><h1>Escolhe uma experiência.</h1><p>O horário só fica reservado quando o profissional aceitar o pedido.</p></div>
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {step === 'form' ? <div className="profile-card booking-form-card"><div className="form-grid">
      <label className="field"><span>Alojamento</span><select value={hotelId} onChange={e => setHotelId(e.target.value)}>{hotels.map(item => <option key={item.id} value={item.id} disabled={item.approval_status !== 'APPROVED'}>{item.name} · {item.city}{item.approval_status !== 'APPROVED' ? ' (aguarda aprovação)' : ''}</option>)}</select></label>
      <label className="field"><span>Serviço</span><select value={serviceId} onChange={e => setServiceId(e.target.value)}>{services.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label className="field"><span>Data · hora de Lisboa</span><input type="date" min={todayLisbon()} value={date} onChange={e => setDate(e.target.value)}/></label>
      <label className="field"><span>Horário disponível</span><select disabled={slotsLoading || !slots.length} value={slotStart} onChange={e => setSlotStart(e.target.value)}><option value="">{slotsLoading ? 'A consultar…' : slots.length ? 'Escolhe um horário' : 'Sem horários disponíveis'}</option>{slots.map(item => <option key={item.starts_at} value={item.starts_at}>{new Date(item.starts_at).toLocaleTimeString('pt-PT',{timeZone:'Europe/Lisbon',hour:'2-digit',minute:'2-digit'})}</option>)}</select></label>
      <label className="field"><span>Número de participantes</span><input type="number" min="1" max="100" value={participants} onChange={e => setParticipants(e.target.value)}/></label>
      <label className="field"><span>Nome do hóspede/responsável · opcional</span><input maxLength={200} value={guest} onChange={e => setGuest(e.target.value)}/></label>
    </div>
    <label className="field"><span>Observações ou necessidades especiais · opcional</span><textarea rows={4} maxLength={3000} value={notes} onChange={e => setNotes(e.target.value)}/></label>
    {service && <div className="booking-service-summary"><strong>{service.name}</strong><span>{service.duration_minutes} min</span><span>{formatPrice(service.price,service.currency)}</span></div>}
    <button className="primary-button" disabled={!slot || Number(participants)<1 || Number(participants)>100} onClick={() => setStep('review')}>Rever pedido</button>
    </div> : <div className="profile-card booking-review"><p className="eyebrow">CONFIRMA OS DETALHES</p><h2>{service?.name}</h2><dl><div><dt>Alojamento</dt><dd>{hotel?.name}</dd></div><div><dt>Data e hora</dt><dd>{slot && formatDate(slot.starts_at)}</dd></div><div><dt>Duração</dt><dd>{service?.duration_minutes} minutos</dd></div><div><dt>Preço indicativo</dt><dd>{formatPrice(service?.price ?? null,service?.currency)}</dd></div><div><dt>Participantes</dt><dd>{participants}</dd></div>{guest&&<div><dt>Responsável</dt><dd>{guest}</dd></div>}{notes&&<div><dt>Observações</dt><dd>{notes}</dd></div>}</dl><p>O pedido fica pendente até o profissional aceitar. Não será enviada uma confirmação automática.</p><div className="booking-actions"><button className="secondary-button" disabled={busy} onClick={() => setStep('form')}>Editar</button><button className="primary-button" disabled={busy} onClick={() => void submit()}>{busy?'A enviar…':'Enviar pedido'}</button></div></div>}
  </section>;
}

export function BookingCenter({ account, go }: { account: Account; go: (path: string) => void }) {
  const isProfessional = account.account_type === 'PROFESSIONAL';
  const [tab, setTab] = useState<'bookings'|'services'|'availability'>(() => {
    const requested = new URLSearchParams(location.search).get('tab');
    return isProfessional && (requested === 'services' || requested === 'availability') ? requested : 'bookings';
  });
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [weekly, setWeekly] = useState<Weekly[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [modalities, setModalities] = useState<Modality[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [filter, setFilter] = useState<'ALL'|BookingStatus>('ALL');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [history, setHistory] = useState<Record<string, History[]>>({});
  const [reason, setReason] = useState<Record<string,string>>({});
  const [serviceForm, setServiceForm] = useState({ id:'',name:'',description:'',modality_slug:'',duration:'60',price:'',active:true });
  const [weeklyForm, setWeeklyForm] = useState({ day:'1',start:'09:00',end:'17:00' });
  const [overrideForm, setOverrideForm] = useState({ starts:'',ends:'',type:'BLOCKED' as 'AVAILABLE'|'BLOCKED',reason:'' });

  const reload = useCallback(async () => {
    if (!supabase) { setLoading(false); setError('Supabase local não está configurado.'); return; }
    setError('');
    const [bookingResult, notificationResult, serviceResult, weeklyResult, overrideResult, modalityResult] = await Promise.all([
      supabase.rpc('my_list_wellweb_bookings'),
      supabase.from('wellweb_notifications').select('id,booking_id,event_type,title,body,created_at,read_at').order('created_at',{ascending:false}).limit(30),
      isProfessional ? supabase.from('professional_services').select('id,name,description,modality_slug,duration_minutes,price,currency,active').order('name') : Promise.resolve({ data: [], error: null }),
      isProfessional ? supabase.from('professional_weekly_availability').select('id,day_of_week,start_time,end_time').order('day_of_week').order('start_time') : Promise.resolve({ data: [], error: null }),
      isProfessional ? supabase.from('professional_availability_overrides').select('id,starts_at,ends_at,override_type,reason').order('starts_at') : Promise.resolve({ data: [], error: null }),
      isProfessional ? supabase.from('modality_catalog').select('slug,name,active').order('name') : Promise.resolve({ data: [], error: null }),
    ]);
    if (bookingResult.error) setError('Não foi possível carregar as reservas desta conta.');
    else setBookings(parseRows<Booking>(bookingResult.data));
    if (notificationResult.error) setError(current => current || 'Não foi possível carregar notificações.');
    else setNotifications((notificationResult.data ?? []) as Notification[]);
    if (serviceResult.error || weeklyResult.error || overrideResult.error) setError(current => current || 'Não foi possível carregar serviços ou disponibilidade.');
    setServices((serviceResult.data ?? []) as Service[]); setWeekly((weeklyResult.data ?? []) as Weekly[]);
    setOverrides((overrideResult.data ?? []) as Override[]); setModalities((modalityResult.data ?? []) as Modality[]);
    setLoading(false);
  }, [isProfessional]);
  useEffect(() => { void reload(); }, [reload]);

  const visible = useMemo(() => bookings.filter(item => filter === 'ALL' || item.status === filter), [bookings,filter]);
  const runAction = async (fn: () => PromiseLike<{error: {message:string}|null}>, success: string) => {
    setBusy(true); setError(''); setNotice(''); const result = await fn(); setBusy(false);
    if (result.error) setError(errorText(result.error, 'A operação não foi concluída. Atualiza a lista e tenta novamente.'));
    else { setNotice(success); await reload(); }
  };
  const decide = (booking: Booking, accept: boolean) => runAction(
    () => supabase!.rpc('decide_wellweb_booking',{p_booking_id:booking.id,p_accept:accept,p_reason:reason[booking.id]?.trim()||null}),
    accept?'Pedido aceite e horário confirmado.':'Pedido rejeitado e hotel notificado.',
  );
  const cancel = (booking: Booking) => runAction(
    () => supabase!.rpc('cancel_wellweb_booking',{p_booking_id:booking.id,p_reason:reason[booking.id]?.trim()||null}),
    'Reserva cancelada e a outra parte foi notificada.',
  );
  const complete = (booking: Booking) => runAction(
    () => supabase!.rpc('complete_wellweb_booking',{p_booking_id:booking.id,p_reason:null}),
    'Experiência marcada como concluída.',
  );
  const toggleHistory = async (id: string) => {
    if (selectedId === id) { setSelectedId(''); return; }
    setSelectedId(id);
    if (history[id] || !supabase) return;
    const { data, error: historyError } = await supabase.rpc('my_wellweb_booking_history',{p_booking_id:id});
    if (historyError) setError('Não foi possível carregar o histórico.'); else setHistory(current=>({...current,[id]:parseRows<History>(data)}));
  };
  const markNotification = async (item: Notification) => {
    if (!supabase) return;
    if (!item.read_at) { const {error: markError}=await supabase.rpc('mark_wellweb_notification_read',{p_notification_id:item.id}); if(markError){setError('Não foi possível atualizar a notificação.');return;} }
    const { data, error: historyError } = await supabase.rpc('my_wellweb_booking_history',{p_booking_id:item.booking_id});
    if (!historyError) setHistory(current=>({...current,[item.booking_id]:parseRows<History>(data)}));
    await reload(); setSelectedId(item.booking_id); setFilter('ALL');
    window.setTimeout(()=>document.getElementById(`booking-${item.booking_id}`)?.scrollIntoView({behavior:'smooth',block:'center'}),80);
  };

  const saveService = async (event: React.FormEvent) => {
    event.preventDefault(); if(!supabase)return;
    const serviceId=serviceForm.id||null;
    await runAction(()=>supabase!.rpc('save_wellweb_professional_service',{
      p_service_id:serviceId,p_name:serviceForm.name,p_description:serviceForm.description||null,
      p_modality_slug:serviceForm.modality_slug||null,p_duration_minutes:Number(serviceForm.duration),
      p_price:serviceForm.price===''?null:Number(serviceForm.price),p_active:serviceForm.active,
    }),serviceId?'Serviço atualizado.':'Serviço criado.');
    setServiceForm({id:'',name:'',description:'',modality_slug:'',duration:'60',price:'',active:true});
  };
  const serviceEdit = (item:Service) => setServiceForm({id:item.id,name:item.name,description:item.description??'',modality_slug:item.modality_slug??'',duration:String(item.duration_minutes??60),price:item.price===null?'':String(item.price),active:item.active});
  const saveWeekly = async (event:React.FormEvent) => {
    event.preventDefault(); if(!supabase)return;
    await runAction(()=>supabase!.rpc('save_wellweb_weekly_availability',{p_slot_id:null,p_day_of_week:Number(weeklyForm.day),p_start_time:weeklyForm.start,p_end_time:weeklyForm.end}),'Disponibilidade semanal guardada.');
  };
  const removeWeekly = (item:Weekly) => runAction(()=>supabase!.rpc('delete_wellweb_weekly_availability',{p_slot_id:item.id}),'Intervalo removido.');
  const saveOverride = async (event:React.FormEvent) => {
    event.preventDefault(); if(!supabase)return;
    try {
      const starts_at=lisbonInputToIso(overrideForm.starts),ends_at=lisbonInputToIso(overrideForm.ends);
      await runAction(()=>supabase!.rpc('save_wellweb_availability_override',{p_override_id:null,p_starts_at:starts_at,p_ends_at:ends_at,p_override_type:overrideForm.type,p_reason:overrideForm.reason||null}),overrideForm.type==='BLOCKED'?'Bloqueio criado.':'Exceção de disponibilidade criada.');
    } catch { setError('Indica uma data e hora válidas para o fuso Europe/Lisbon.'); }
  };
  const removeOverride = (item:Override) => runAction(()=>supabase!.rpc('delete_wellweb_availability_override',{p_override_id:item.id}),'Exceção removida.');

  if(loading)return <section className="booking-page"><div className="loading-line"><div className="spinner"/> A carregar a área de reservas…</div></section>;
  return <section className="booking-page">
    <div className="booking-heading"><p className="eyebrow">ÁREA PRIVADA · {isProfessional?'PROFISSIONAL':'ALOJAMENTO'}</p><h1>{isProfessional?'Experiências na tua agenda.':'Pedidos e experiências.'}</h1><p>{isProfessional?'Gere serviços, disponibilidade e pedidos de reserva.':'Acompanha os pedidos enviados aos profissionais.'}</p></div>
    <div className="booking-tabs">{[['bookings','Reservas'],...(isProfessional?[['services','Serviços'],['availability','Disponibilidade']]:[])].map(([key,label])=><button type="button" key={key} className={tab===key?'active':''} onClick={()=>setTab(key as typeof tab)}>{label}</button>)}</div>
    {error&&<div className="inline-alert" role="alert">{error}</div>}{notice&&<div className="admin-notice"><Check size={15}/>{notice}</div>}
    {tab==='bookings'&&<>
      <div className="notification-panel"><div><Bell size={17}/><strong>Notificações</strong><span>{notifications.filter(item=>!item.read_at).length} por ler</span></div>{notifications.length?notifications.map(item=><button className={`notification-item ${item.read_at?'read':''}`} key={item.id} onClick={()=>void markNotification(item)}><span><strong>{item.title}</strong><small>{item.body}</small></span><time>{formatDate(item.created_at)}</time></button>):<p>Ainda não tens notificações.</p>}</div>
      <div className="booking-list-head"><h2>{isProfessional?'Pedidos e reservas recebidos':'As reservas do teu alojamento'}</h2><label><Search size={15}/><select value={filter} onChange={event=>setFilter(event.target.value as typeof filter)}><option value="ALL">Todos os estados</option>{Object.entries(statusNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
      {visible.length?visible.map(item=><BookingCard key={item.id} booking={item} isProfessional={isProfessional} busy={busy} reason={reason[item.id]??''} setReason={value=>setReason(current=>({...current,[item.id]:value}))} expanded={selectedId===item.id} history={history[item.id]} onToggleHistory={()=>void toggleHistory(item.id)} onAccept={()=>void decide(item,true)} onReject={()=>void decide(item,false)} onCancel={()=>void cancel(item)} onComplete={()=>void complete(item)}/>):<div className="profile-card booking-empty"><CalendarDays/><h2>Sem reservas neste estado.</h2><p>Os pedidos e respetivas atualizações aparecem aqui.</p>{!isProfessional&&<button className="secondary-button" onClick={()=>go('/profissionais')}>Encontrar profissionais</button>}</div>}
    </>}
    {tab==='services'&&isProfessional&&<section className="booking-management-grid"><div className="profile-card"><h2>{serviceForm.id?'Editar serviço':'Novo serviço'}</h2><form className="form" onSubmit={event=>void saveService(event)}><label className="field"><span>Nome</span><input required maxLength={120} value={serviceForm.name} onChange={e=>setServiceForm({...serviceForm,name:e.target.value})}/></label><label className="field"><span>Descrição</span><textarea rows={3} value={serviceForm.description} onChange={e=>setServiceForm({...serviceForm,description:e.target.value})}/></label><label className="field"><span>Modalidade</span><select value={serviceForm.modality_slug} onChange={e=>setServiceForm({...serviceForm,modality_slug:e.target.value})}><option value="">Sem modalidade específica</option>{modalities.filter(item=>item.active).map(item=><option value={item.slug} key={item.slug}>{item.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>Duração · minutos</span><input required type="number" min="5" max="1440" value={serviceForm.duration} onChange={e=>setServiceForm({...serviceForm,duration:e.target.value})}/></label><label className="field"><span>Preço indicativo · EUR</span><input type="number" min="0" step="0.01" value={serviceForm.price} onChange={e=>setServiceForm({...serviceForm,price:e.target.value})}/></label></div><label className="publish-toggle"><input type="checkbox" checked={serviceForm.active} onChange={e=>setServiceForm({...serviceForm,active:e.target.checked})}/><span><strong>Serviço ativo</strong><small>Serviços ativos podem receber pedidos.</small></span></label><div className="booking-actions"><button type="submit" className="primary-button"><Save size={15}/>{serviceForm.id?'Guardar alterações':'Criar serviço'}</button>{serviceForm.id&&<button type="button" className="secondary-button" onClick={()=>setServiceForm({id:'',name:'',description:'',modality_slug:'',duration:'60',price:'',active:true})}>Cancelar edição</button>}</div></form></div><div className="profile-card"><h2>Catálogo de serviços</h2>{services.length?services.map(item=><article className="service-manage-item" key={item.id}><div><strong>{item.name}</strong><span>{item.duration_minutes??'—'} min · {formatPrice(item.price,item.currency)} · {item.active?'Ativo':'Inativo'}</span><small>{item.description}</small></div><button className="secondary-button" onClick={()=>serviceEdit(item)}>Editar</button></article>):<p>Ainda não adicionaste serviços.</p>}</div></section>}
    {tab==='availability'&&isProfessional&&<>
      <section className="availability-grid"><div className="profile-card"><h2>Disponibilidade semanal</h2><p>Define um ou mais intervalos por dia. Não configures dias sem disponibilidade.</p><form className="form weekly-form" onSubmit={event=>void saveWeekly(event)}><label className="field"><span>Dia</span><select value={weeklyForm.day} onChange={e=>setWeeklyForm({...weeklyForm,day:e.target.value})}>{weekdays.map((day,index)=><option value={index} key={day}>{day}</option>)}</select></label><div className="form-grid"><label className="field"><span>Início · Lisboa</span><input type="time" value={weeklyForm.start} onChange={e=>setWeeklyForm({...weeklyForm,start:e.target.value})}/></label><label className="field"><span>Fim · Lisboa</span><input type="time" value={weeklyForm.end} onChange={e=>setWeeklyForm({...weeklyForm,end:e.target.value})}/></label></div><button className="primary-button" type="submit"><Plus size={16}/> Adicionar intervalo</button></form><div className="availability-items">{weekly.map(item=><div key={item.id}><span><strong>{weekdays[item.day_of_week]}</strong>{item.start_time.slice(0,5)}–{item.end_time.slice(0,5)}</span><button className="icon-danger" aria-label="Remover intervalo" onClick={()=>void removeWeekly(item)}><Trash2 size={16}/></button></div>)}</div></div><div className="profile-card"><h2>Exceções e bloqueios</h2><p>Cria períodos extra disponíveis ou bloqueia dias/horários. Os horários são interpretados em Europe/Lisbon.</p><form className="form" onSubmit={event=>void saveOverride(event)}><label className="field"><span>Tipo</span><select value={overrideForm.type} onChange={e=>setOverrideForm({...overrideForm,type:e.target.value as 'AVAILABLE'|'BLOCKED'})}><option value="BLOCKED">Bloquear horário</option><option value="AVAILABLE">Abrir exceção</option></select></label><div className="form-grid"><label className="field"><span>Início</span><input type="datetime-local" required value={overrideForm.starts} onChange={e=>setOverrideForm({...overrideForm,starts:e.target.value})}/></label><label className="field"><span>Fim</span><input type="datetime-local" required value={overrideForm.ends} onChange={e=>setOverrideForm({...overrideForm,ends:e.target.value})}/></label></div><label className="field"><span>Nota · opcional</span><input maxLength={500} value={overrideForm.reason} onChange={e=>setOverrideForm({...overrideForm,reason:e.target.value})}/></label><button className="primary-button" type="submit"><Plus size={16}/> Guardar exceção</button></form><div className="availability-items">{overrides.map(item=><div key={item.id}><span><strong>{item.override_type==='BLOCKED'?'Bloqueio':'Disponível'}</strong>{formatDate(item.starts_at)}–{formatDate(item.ends_at)}{item.reason&&<small>{item.reason}</small>}</span><button className="icon-danger" aria-label="Remover exceção" onClick={()=>void removeOverride(item)}><Trash2 size={16}/></button></div>)}</div></div></section>
      <section className="profile-card booking-calendar"><div className="booking-calendar-heading"><CalendarDays size={19}/><div><h2>Próximas reservas confirmadas</h2><p>Horários apresentados no fuso Europe/Lisbon.</p></div></div>{bookings.filter(item=>item.status==='CONFIRMED'&&new Date(item.starts_at)>=new Date()).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)).length?bookings.filter(item=>item.status==='CONFIRMED'&&new Date(item.starts_at)>=new Date()).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)).map(item=><article key={item.id}><time>{formatDate(item.starts_at)}</time><div><strong>{item.hotel_name} · {item.service_name_snapshot}</strong><span>{item.participants} participante(s) · {item.booking_reference}</span></div><button className="secondary-button" onClick={()=>{setTab('bookings');setFilter('CONFIRMED');setSelectedId(item.id);window.setTimeout(()=>document.getElementById(`booking-${item.id}`)?.scrollIntoView({behavior:'smooth',block:'center'}),100);}}>Ver reserva</button></article>):<p className="booking-calendar-empty">Ainda não tens reservas futuras confirmadas.</p>}</section>
    </>}
  </section>;
}

function BookingCard({booking,isProfessional,busy,reason,setReason,expanded,history,onToggleHistory,onAccept,onReject,onCancel,onComplete}:{booking:Booking;isProfessional:boolean;busy:boolean;reason:string;setReason:(value:string)=>void;expanded:boolean;history?:History[];onToggleHistory:()=>void;onAccept:()=>void;onReject:()=>void;onCancel:()=>void;onComplete:()=>void}) {
  const canRespond=isProfessional&&booking.status==='PENDING';
  const canCancel=['PENDING','CONFIRMED'].includes(booking.status);
  const canComplete=isProfessional&&booking.status==='CONFIRMED'&&new Date(booking.ends_at)<=new Date();
  return <article id={`booking-${booking.id}`} className={`profile-card booking-card ${expanded?'expanded':''}`}>
    <header><div><p className="eyebrow">{booking.booking_reference}</p><h2>{isProfessional?booking.hotel_name:booking.professional_name}</h2><span className={`review-badge ${booking.status.toLowerCase()}`}>{statusNames[booking.status]}</span></div><div className="booking-date"><CalendarDays size={16}/><span>{formatDate(booking.starts_at)}</span></div></header>
    <div className="booking-card-main"><div><span className="booking-icon">{isProfessional?<Building2 size={16}/>:<UserRound size={16}/>} {booking.service_name_snapshot}</span><span><Clock3 size={15}/>{booking.service_duration_minutes_snapshot} minutos</span><span>{booking.participants} participantes</span><span>{formatPrice(booking.service_price_snapshot,booking.service_currency_snapshot)}</span></div><p><strong>Responsável:</strong> {booking.guest_name||'Não indicado'}</p>{booking.notes&&<p><strong>Observações:</strong> {booking.notes}</p>}<small>Pedido criado em {formatDate(booking.created_at)}</small></div>
    {canRespond&&<div className="booking-action-area"><label className="field"><span>Motivo · opcional (pedido rejeitado)</span><textarea rows={2} maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Indica um motivo ao rejeitar, se necessário."/></label><div className="booking-actions"><button className="secondary-button danger-button" disabled={busy} onClick={onReject}><X size={15}/> Rejeitar</button><button className="primary-button" disabled={busy} onClick={onAccept}><Check size={15}/> Aceitar e confirmar</button></div></div>}
    {canCancel&&<details className="cancel-booking"><summary>Cancelar {booking.status==='PENDING'?'pedido':'reserva'}</summary><label className="field"><span>Motivo · opcional</span><textarea rows={2} maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)}/></label><button className="secondary-button danger-button" disabled={busy} onClick={onCancel}>Confirmar cancelamento</button></details>}
    {canComplete&&<button className="secondary-button" disabled={busy} onClick={onComplete}>Marcar experiência concluída</button>}
    <button className="history-toggle" onClick={onToggleHistory}>{expanded?'Ocultar histórico':'Ver histórico'}</button>
    {expanded&&<ol className="booking-history">{history?.length?history.map(item=><li key={item.id}><strong>{statusNames[item.to_status as BookingStatus]??item.to_status}</strong><span>{item.actor_name} · {item.actor_type} · {formatDate(item.created_at)}</span>{item.reason&&<small>{item.reason}</small>}</li>):<li>Sem eventos disponíveis.</li>}</ol>}
  </article>;
}

export function AdminBookingManager() {
  const [bookings,setBookings]=useState<Booking[]>([]);
  const [filter,setFilter]=useState(''); const [from,setFrom]=useState(''); const [to,setTo]=useState('');
  const [hotelId,setHotelId]=useState(''); const [profileId,setProfileId]=useState('');
  const [history,setHistory]=useState<Record<string,History[]>>({}); const [expanded,setExpanded]=useState('');
  const [loading,setLoading]=useState(true); const [busy,setBusy]=useState(false); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const load=useCallback(async()=>{
    if(!supabase)return;
    setLoading(true);const {data,error:loadError}=await supabase.rpc('admin_list_wellweb_bookings',{
      p_status:null,p_hotel_id:null,p_professional_profile_id:null,p_from:null,p_to:null,
    });
    if(loadError)setError('Não foi possível consultar as reservas administrativas.');else{setError('');setBookings(parseRows<Booking>(data));}
    setLoading(false);
  },[]);
  useEffect(()=>{void load();},[load]);
  const hotels=useMemo(()=>[...new Map(bookings.map(b=>[b.hotel_id,{id:b.hotel_id,name:b.hotel_name}])).values()], [bookings]);
  const professionals=useMemo(()=>[...new Map(bookings.map(b=>[b.professional_profile_id,{id:b.professional_profile_id,name:b.professional_name}])).values()], [bookings]);
  const visible=useMemo(()=>bookings.filter(item=>{
    const localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Lisbon',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(item.starts_at));
    return (!filter||item.status===filter)&&(!hotelId||item.hotel_id===hotelId)&&(!profileId||item.professional_profile_id===profileId)&&(!from||localDate>=from)&&(!to||localDate<=to);
  }),[bookings,filter,from,hotelId,profileId,to]);
  const showHistory=async(id:string)=>{if(expanded===id){setExpanded('');return;}setExpanded(id);if(history[id]||!supabase)return;const {data,error:historyError}=await supabase.rpc('my_wellweb_booking_history',{p_booking_id:id});if(historyError)setError('Não foi possível carregar o histórico.');else setHistory(current=>({...current,[id]:parseRows<History>(data)}));};
  const complete=async(item:Booking)=>{
    if(!window.confirm(`Marcar ${item.booking_reference} como concluída? Esta ação ficará registada no histórico.`))return;
    setBusy(true);const {error:actionError}=await supabase!.rpc('admin_complete_wellweb_booking',{p_booking_id:item.id,p_reason:'Conclusão registada pela administração.'});setBusy(false);
    if(actionError)setError(errorText(actionError,'Não foi possível concluir a reserva.'));else{setNotice('Conclusão registada e notificação enviada.');await load();}
  };
  return <section className="profile-card admin-bookings"><div className="admin-booking-head"><div><p className="eyebrow">OPERAÇÃO</p><h2>Reservas</h2><p>Consulta global de pedidos e histórico. A conclusão fica registada como ação administrativa.</p></div><span className="admin-booking-count">{bookings.length}</span></div>
    {error&&<div className="inline-alert" role="alert">{error}</div>}{notice&&<div className="admin-notice"><Check size={15}/>{notice}</div>}
    <div className="admin-booking-filters"><label className="field"><span>Estado</span><select value={filter} onChange={e=>setFilter(e.target.value)}><option value="">Todos</option>{Object.entries(statusNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="field"><span>Hotel</span><select value={hotelId} onChange={e=>setHotelId(e.target.value)}><option value="">Todos</option>{hotels.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>Profissional</span><select value={profileId} onChange={e=>setProfileId(e.target.value)}><option value="">Todos</option>{professionals.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="field"><span>De</span><input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label className="field"><span>Até</span><input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div>
    {loading?<div className="loading-line"><div className="spinner"/> A carregar reservas…</div>:visible.length?visible.map(item=><article className="admin-booking-row" key={item.id}><div><strong>{item.booking_reference} · {item.hotel_name} → {item.professional_name}</strong><span>{item.service_name_snapshot} · {formatDate(item.starts_at)} · {statusNames[item.status]}</span></div><div className="admin-booking-buttons"><button className="secondary-button" onClick={()=>void showHistory(item.id)}>{expanded===item.id?'Ocultar histórico':'Detalhes / histórico'}</button>{item.status==='CONFIRMED'&&new Date(item.ends_at)<=new Date()&&<button className="primary-button" disabled={busy} onClick={()=>void complete(item)}>Concluir</button>}</div>{expanded===item.id&&<AdminHistory history={history[item.id]??[]} booking={item}/>}</article>):<p className="booking-empty">Ainda não há reservas com estes filtros.</p>}
  </section>;
}

function AdminHistory({history,booking}:{history:History[];booking:Booking}){
  return <div className="admin-booking-details"><p>{booking.participants} participantes · {booking.service_duration_minutes_snapshot} min · {formatPrice(booking.service_price_snapshot,booking.service_currency_snapshot)}</p>{booking.guest_name&&<p>Responsável: {booking.guest_name}</p>}{booking.notes&&<p>Observações: {booking.notes}</p>}<ol className="booking-history">{history.map(item=><li key={item.id}><strong>{statusNames[item.to_status as BookingStatus]??item.to_status}</strong><span>{item.actor_name} · {item.actor_type} · {formatDate(item.created_at)}</span>{item.reason&&<small>{item.reason}</small>}</li>)}</ol></div>;
}
