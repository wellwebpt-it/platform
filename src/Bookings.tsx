import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { BadgeCheck, Bell, Building2, CalendarDays, Check, Clock3, Pencil, Plus, Save, Search, ShieldCheck, Trash2, UserRound, X } from 'lucide-react';
import { supabase } from './lib/supabase';
import { canCancelBooking, groupBookingTotal } from './lib/build51.js';
import { parseLisbonDateTime, toLisbonLocalDateTime } from './lib/lisbonDateTime';

type AccountType = 'HOTEL' | 'PROFESSIONAL' | 'ADMIN';
type BookingStatus = 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'CANCELLED' | 'COMPLETED';
type Account = { id: string; account_type: AccountType; status: string };
type HotelChoice = { id: string; name: string; city: string; approval_status: string };
type Service = { id: string; name: string; description: string | null; modality_slug: string | null; duration_minutes: number | null; price: number | null; currency: string; active: boolean; has_material:boolean; allows_group:boolean; max_students:number|null; price_per_student:boolean };
type ServiceEntry = Service & { reviewState: 'published'|'pending'|'rejected'; entryKey: string };
type Slot = { starts_at: string; ends_at: string };
type Booking = {
  id: string; booking_reference: string; hotel_id: string; hotel_name: string;
  professional_profile_id: string; professional_name: string; service_id: string | null;
  service_name_snapshot: string; service_duration_minutes_snapshot: number;
  service_price_snapshot: number | null; service_currency_snapshot: string;
  price_type_snapshot:'SERVICE'|'PER_STUDENT'; max_students_snapshot:number|null; students_count:number; total_price_snapshot:number|null;
  starts_at: string; ends_at: string; participants: number; guest_name: string | null;
  notes: string | null; status: BookingStatus; created_at: string;
  response_deadline_at?: string | null; resolution_code?: string | null;
};
type Notification = { id: string; booking_id: string; event_type: string; title: string; body: string; created_at: string; read_at: string | null };
type History = { id: string; from_status: string | null; to_status: string; reason: string | null; created_at: string; actor_name: string; actor_type: string };
type Weekly = { id: string; day_of_week: number; start_time: string; end_time: string };
type Override = { id: string; starts_at: string; ends_at: string; override_type: 'AVAILABLE' | 'BLOCKED'; reason: string | null };
type Modality = { slug: string; name: string; active: boolean };

const statusNames: Record<BookingStatus, string> = { PENDING: 'Pendente', CONFIRMED: 'Confirmada', REJECTED: 'Rejeitada', CANCELLED: 'Cancelada', COMPLETED: 'Concluída' };
const weekdays = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

function parseRows<T>(data: unknown): T[] { return (Array.isArray(data) ? data : []) as T[]; }
function historyActor(item:History, booking?:Booking) {
  if (item.actor_type==='HOTEL') return booking?.hotel_name ? `HOTEL · ${booking.hotel_name}` : 'HOTEL';
  if (item.actor_type==='PROFESSIONAL') return booking?.professional_name ? `PROFESSIONAL · ${booking.professional_name}` : 'PROFESSIONAL';
  if (item.actor_type==='ADMIN') return 'ADMIN';
  return item.actor_type==='SYSTEM'?'WellWeb · sistema':item.actor_type;
}
function formatDate(value: string, includeTime = true) {
  return new Date(value).toLocaleString('pt-PT', { timeZone: 'Europe/Lisbon', dateStyle: 'medium', ...(includeTime ? { timeStyle: 'short' as const } : {}) });
}
function formatCalendarDate(value: string) {
  return new Intl.DateTimeFormat('pt-PT', { timeZone: 'Europe/Lisbon', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value));
}
function formatPrice(price: number | null, currency = 'EUR') {
  return price === null ? 'Preço a combinar' : new Intl.NumberFormat('pt-PT', { style: 'currency', currency }).format(price);
}
function bookingPriceSummary(booking:Booking) {
  const total=booking.total_price_snapshot??booking.service_price_snapshot;
  if(booking.price_type_snapshot==='PER_STUDENT')return `${formatPrice(booking.service_price_snapshot,booking.service_currency_snapshot)} / aluno × ${booking.students_count??booking.participants} = ${formatPrice(total,booking.service_currency_snapshot)} · máximo ${booking.max_students_snapshot??'—'}`;
  return formatPrice(total,booking.service_currency_snapshot);
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
    if (/24 hours notice/i.test(message)) return 'O profissional só pode cancelar com pelo menos 24 horas de antecedência.';
    if (/12 hours notice/i.test(message)) return 'O alojamento só pode cancelar com pelo menos 12 horas de antecedência.';
    if (/cancellation reason is required/i.test(message)) return 'Indica o motivo obrigatório para cancelar.';
    if (/student count exceeds/i.test(message)) return 'O número de alunos excede a capacidade deste serviço.';
    if (/individual services accept/i.test(message)) return 'Este serviço individual admite apenas uma pessoa.';
    if (/at least 4 hours notice/i.test(message)) return 'Os pedidos de reserva devem ser realizados com pelo menos 4 horas de antecedência.';
    if (/confirmed reservation unavailable/i.test(message)) return 'A alteração foi bloqueada porque afetaria uma reserva já confirmada.';
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
        supabase.from('professional_services').select('id,name,description,modality_slug,duration_minutes,price,currency,active,has_material,allows_group,max_students,price_per_student').eq('professional_profile_id', profileId).eq('active', true).not('duration_minutes', 'is', null).gte('duration_minutes', 5).lte('duration_minutes', 1440).order('name'),
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
        else { setError(''); setSlots(parseRows<Slot>(data).filter(slot => Date.parse(slot.starts_at) >= Date.now() + 4 * 60 * 60 * 1000)); }
        setSlotsLoading(false);
      });
    return () => { live = false; };
  }, [date, hotelId, hotels, profileId, serviceId]);

  const service = services.find(item => item.id === serviceId);
  useEffect(()=>{if(service&&!service.allows_group)setParticipants('1');},[serviceId,service?.allows_group]);
  const hotel = hotels.find(item => item.id === hotelId);
  const studentCount = Number(participants);
  const validStudents = service?.allows_group ? Number.isInteger(studentCount) && studentCount >= 1 && studentCount <= (service.max_students ?? 0) : true;
  const totalPrice = service ? groupBookingTotal({price:service.price,allowsGroup:service.allows_group,pricePerStudent:service.price_per_student,students:service.allows_group?studentCount:1}) : null;
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
      {service?.allows_group?<label className="field"><span>Número de alunos · máximo {service.max_students}</span><input required type="number" min="1" max={service.max_students??undefined} step="1" value={participants} onChange={e => setParticipants(e.target.value)}/></label>:<div className="field"><span>Participantes</span><p>1 participante · serviço individual</p></div>}
      <label className="field"><span>Nome do funcionário responsável · opcional</span><input maxLength={200} value={guest} onChange={e => setGuest(e.target.value)}/></label>
    </div>
    <label className="field"><span>Observações ou necessidades especiais · opcional</span><textarea rows={4} maxLength={3000} value={notes} onChange={e => setNotes(e.target.value)}/></label>
    {service && <div className="booking-service-summary"><strong>{service.name}</strong><span>{service.duration_minutes} min</span><span>{service.allows_group&&service.price_per_student?`${formatPrice(service.price,service.currency)} / aluno`:formatPrice(service.price,service.currency)}</span>{service.has_material&&<span>Material disponível</span>}{service.allows_group&&<strong>Total estimado: {formatPrice(totalPrice,service.currency)}</strong>}</div>}
    <button className="primary-button" disabled={!slot || !validStudents} onClick={() => setStep('review')}>Rever pedido</button>
    </div> : <div className="profile-card booking-review"><p className="eyebrow">CONFIRMA OS DETALHES</p><h2>{service?.name}</h2><dl><div><dt>Alojamento</dt><dd>{hotel?.name}</dd></div><div><dt>Data e hora</dt><dd>{slot && formatDate(slot.starts_at)}</dd></div><div><dt>Duração</dt><dd>{service?.duration_minutes} minutos</dd></div><div><dt>{service?.allows_group&&service.price_per_student?'Preço por aluno':'Preço do serviço'}</dt><dd>{formatPrice(service?.price ?? null,service?.currency)}</dd></div>{service?.allows_group&&<div><dt>Alunos · capacidade máxima</dt><dd>{studentCount} de {service.max_students}</dd></div>}<div><dt>Total estimado</dt><dd>{formatPrice(totalPrice,service?.currency)}</dd></div>{guest&&<div><dt>Funcionário responsável</dt><dd>{guest}</dd></div>}{notes&&<div><dt>Observações</dt><dd>{notes}</dd></div>}</dl><p>O pedido fica pendente até o profissional aceitar. Não será enviada uma confirmação automática.</p><div className="booking-actions"><button className="secondary-button" disabled={busy} onClick={() => setStep('form')}>Editar</button><button className="primary-button" disabled={busy || !validStudents} onClick={() => void submit()}>{busy?'A enviar…':'Enviar pedido'}</button></div></div>}
  </section>;
}

export function BookingCenter({ account, go, embedded=false, initialTab }: { account: Account; go: (path: string) => void; embedded?:boolean; initialTab?:'bookings'|'services'|'availability' }) {
  const isProfessional = account.account_type === 'PROFESSIONAL';
  const [tab, setTab] = useState<'bookings'|'services'|'availability'>(() => initialTab??(() => {
    if (location.pathname === '/area/servicos') return 'services';
    if (location.pathname === '/area/disponibilidade') return 'availability';
    const requested = new URLSearchParams(location.search).get('tab');
    return isProfessional && (requested === 'services' || requested === 'availability') ? requested : 'bookings';
  })());
  useEffect(() => {
    if (location.pathname === '/area/servicos') setTab('services');
    else if (location.pathname === '/area/disponibilidade') setTab('availability');
    else if (location.pathname === '/reservas') setTab('bookings');
  }, [location.pathname]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [pendingConfiguration, setPendingConfiguration] = useState<Record<string,unknown>|null>(null);
  const [serviceReviewHistory, setServiceReviewHistory] = useState<{status:string;services?:Service[];reason?:string}[]>([]);
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
  const [serviceForm, setServiceForm] = useState({ id:'',name:'',description:'',modality_slug:'',duration:'60',price:'',active:true,has_material:false,allows_group:false,max_students:'',price_per_student:false });
  const [weeklyForm, setWeeklyForm] = useState({ day:'1',start:'09:00',end:'17:00' });
  const [overrideForm, setOverrideForm] = useState({ id:'',starts:'',ends:'',type:'BLOCKED' as 'AVAILABLE'|'BLOCKED',reason:'' });

  const reload = useCallback(async () => {
    if (!supabase) { setLoading(false); setError('Supabase local não está configurado.'); return; }
    setError('');
    const [bookingResult, notificationResult, serviceResult, weeklyResult, overrideResult, modalityResult, configurationResult] = await Promise.all([
      supabase.rpc('my_list_wellweb_bookings'),
      supabase.from('wellweb_notifications').select('id,booking_id,event_type,title,body,created_at,read_at').order('created_at',{ascending:false}).limit(30),
      isProfessional ? supabase.from('professional_services').select('id,name,description,modality_slug,duration_minutes,price,currency,active,has_material,allows_group,max_students,price_per_student').order('name') : Promise.resolve({ data: [], error: null }),
      isProfessional ? supabase.from('professional_weekly_availability').select('id,day_of_week,start_time,end_time').order('day_of_week').order('start_time') : Promise.resolve({ data: [], error: null }),
      isProfessional ? supabase.from('professional_availability_overrides').select('id,starts_at,ends_at,override_type,reason').order('starts_at') : Promise.resolve({ data: [], error: null }),
      isProfessional ? supabase.from('modality_catalog').select('slug,name,active').order('name') : Promise.resolve({ data: [], error: null }),
      isProfessional ? supabase.from('professional_profiles').select('pending_configuration,service_review_history').eq('user_id',account.id).maybeSingle() : Promise.resolve({data:null,error:null}),
    ]);
    if (bookingResult.error) setError('Não foi possível carregar as reservas desta conta.');
    else setBookings(parseRows<Booking>(bookingResult.data));
    if (notificationResult.error) setError(current => current || 'Não foi possível carregar notificações.');
    else setNotifications((notificationResult.data ?? []) as Notification[]);
    if (serviceResult.error || weeklyResult.error || overrideResult.error) setError(current => current || 'Não foi possível carregar serviços ou disponibilidade.');
    setServices((serviceResult.data ?? []) as Service[]); setWeekly((weeklyResult.data ?? []) as Weekly[]);
    setOverrides((overrideResult.data ?? []) as Override[]); setModalities((modalityResult.data ?? []) as Modality[]);
    setPendingConfiguration((configurationResult.data as {pending_configuration:Record<string,unknown>|null}|null)?.pending_configuration??null);
    setServiceReviewHistory(((configurationResult.data as {service_review_history?:{status:string;services?:Service[];reason?:string}[]}|null)?.service_review_history??[]));
    setLoading(false);
  }, [account.id,isProfessional]);
  useEffect(() => { void reload(); }, [reload]);

  const visible = useMemo(() => bookings.filter(item => filter === 'ALL' || item.status === filter), [bookings,filter]);
  const serviceEntries = useMemo<ServiceEntry[]>(() => {
    const entries:ServiceEntry[]=services.map(item=>({...item,reviewState:'published',entryKey:`published-${item.id}`}));
    const pending=(pendingConfiguration?.services as Service[]|undefined)??[];
    for(const item of pending){
      const current=services.find(row=>row.id===item.id);
      if(!current||JSON.stringify(current)!==JSON.stringify(item))entries.push({...item,reviewState:'pending',entryKey:`pending-${item.id}`});
    }
    const rejected=serviceReviewHistory.at(-1);
    if(rejected?.status==='REJECTED')for(const item of rejected.services??[]){
      const current=services.find(row=>row.id===item.id);
      if(!current||JSON.stringify(current)!==JSON.stringify(item))entries.push({...item,reviewState:'rejected',entryKey:`rejected-${item.id}`});
    }
    return entries;
  },[pendingConfiguration,serviceReviewHistory,services]);
  const runAction = async (fn: () => PromiseLike<{error: {message:string}|null}>, success: string):Promise<boolean> => {
    setBusy(true); setError(''); setNotice(''); const result = await fn(); setBusy(false);
    if (result.error) { setError(errorText(result.error, 'A operação não foi concluída. Atualiza a lista e tenta novamente.')); return false; }
    setNotice(success); await reload(); return true;
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
      p_has_material:serviceForm.has_material,p_allows_group:serviceForm.allows_group,p_max_students:serviceForm.allows_group?Number(serviceForm.max_students):null,p_price_per_student:serviceForm.price_per_student,
    }),serviceId?'Serviço atualizado.':'Serviço criado.');
    setServiceForm({id:'',name:'',description:'',modality_slug:'',duration:'60',price:'',active:true,has_material:false,allows_group:false,max_students:'',price_per_student:false});
  };
  const serviceEdit = (item:Service) => setServiceForm({id:item.id,name:item.name,description:item.description??'',modality_slug:item.modality_slug??'',duration:String(item.duration_minutes??60),price:item.price===null?'':String(item.price),active:item.active,has_material:item.has_material,allows_group:item.allows_group,max_students:item.max_students===null?'':String(item.max_students),price_per_student:item.price_per_student});
  const saveWeekly = async (event:React.FormEvent) => {
    event.preventDefault(); if(!supabase)return;
    if (![weeklyForm.start,weeklyForm.end].every(time=>/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time))) { setError('Indica as horas no formato 24 horas HH:mm.'); return; }
    if (weeklyForm.start >= weeklyForm.end) { setError('A hora de início tem de ser anterior à hora de fim.'); return; }
    if ([weeklyForm.start, weeklyForm.end].some(time => Number(time.slice(3,5)) % 15 !== 0)) { setError('Escolhe horas em intervalos de 15 minutos.'); return; }
    await runAction(()=>supabase!.rpc('save_wellweb_weekly_availability',{p_slot_id:null,p_day_of_week:Number(weeklyForm.day),p_start_time:weeklyForm.start,p_end_time:weeklyForm.end}),'Disponibilidade semanal guardada.');
  };
  const removeWeekly = (item:Weekly) => runAction(()=>supabase!.rpc('delete_wellweb_weekly_availability',{p_slot_id:item.id}),'Intervalo removido.');
  const saveOverride = async (event:React.FormEvent) => {
    event.preventDefault(); if(!supabase)return;
    try {
      const [startDate,startTime]=overrideForm.starts.split('T'); const [endDate,endTime]=overrideForm.ends.split('T');
      const starts_at=parseLisbonDateTime(`${startDate.slice(8,10)}/${startDate.slice(5,7)}/${startDate.slice(0,4)}`,startTime);
      const ends_at=parseLisbonDateTime(`${endDate.slice(8,10)}/${endDate.slice(5,7)}/${endDate.slice(0,4)}`,endTime);
      if (new Date(starts_at) >= new Date(ends_at)) { setError('A data e hora de início têm de ser anteriores ao fim.'); return; }
      const saved=await runAction(()=>supabase!.rpc('save_wellweb_availability_override',{p_override_id:overrideForm.id||null,p_starts_at:starts_at,p_ends_at:ends_at,p_override_type:overrideForm.type,p_reason:overrideForm.reason||null}),overrideForm.id?'Exceção atualizada.':overrideForm.type==='BLOCKED'?'Bloqueio criado.':'Exceção de disponibilidade criada.');
      if(saved)setOverrideForm({id:'',starts:'',ends:'',type:'BLOCKED',reason:''});
    } catch (reason) { setError(reason instanceof Error?reason.message:'Indica uma data e hora válidas para o fuso Europe/Lisbon.'); }
  };
  const removeOverride = (item:Override) => runAction(()=>supabase!.rpc('delete_wellweb_availability_override',{p_override_id:item.id}),'Exceção removida.');
  const editOverride = (item:Override) => setOverrideForm({id:item.id,starts:toLisbonLocalDateTime(item.starts_at),ends:toLisbonLocalDateTime(item.ends_at),type:item.override_type,reason:item.reason??''});

  const selectTab = (next: 'bookings'|'services'|'availability') => {
    setTab(next);
    go(next === 'services' ? '/area/servicos' : next === 'availability' ? '/area/disponibilidade' : '/reservas');
  };

  if(loading)return <section className="booking-page"><div className="loading-line"><div className="spinner"/> A carregar a área de reservas…</div></section>;
  return <section className="booking-page">
    {!embedded&&<><div className="booking-section-heading"><div><p className="eyebrow">ÁREA PRIVADA · {isProfessional?'PROFISSIONAL':'ALOJAMENTO'}</p><h1>{tab==='services'?'Serviços':tab==='availability'?'Disponibilidade':'Reservas'}</h1><p>{tab==='services'?'Gere os serviços que disponibilizas aos alojamentos.':tab==='availability'?'Define os horários e as exceções em que estás disponível.':'Acompanha pedidos, decisões e atividades agendadas.'}</p></div><button className="back-link" onClick={()=>go(isProfessional?'/profissional':'/hotel')}>Voltar ao meu perfil</button></div><div className="booking-tabs">{[['bookings','Reservas'],...(isProfessional?[['services','Serviços'],['availability','Disponibilidade']]:[])].map(([key,label])=><button type="button" key={key} className={tab===key?'active':''} onClick={()=>selectTab(key as typeof tab)}>{label}</button>)}</div></>}
    {Boolean(pendingConfiguration?.services)&&<div className="inline-alert" role="status">As alterações propostas a serviços aguardam aprovação. A versão já publicada continua disponível; a disponibilidade tem efeito imediato.</div>}
    {error&&<div className="inline-alert" role="alert">{error}</div>}{notice&&<div className="admin-notice"><Check size={15}/>{notice}</div>}
    {tab==='bookings'&&<>
      <div className="notification-panel"><div><Bell size={17}/><strong>Notificações</strong><span>{notifications.filter(item=>!item.read_at).length} por ler</span></div>{notifications.length?notifications.map(item=><button className={`notification-item ${item.read_at?'read':''}`} key={item.id} onClick={()=>void markNotification(item)}><span><strong>{item.title}</strong><small>{item.body}</small></span><time>{formatDate(item.created_at)}</time></button>):<p>Ainda não tens notificações.</p>}</div>
      <div className="booking-list-head"><h2>{isProfessional?'Pedidos e reservas recebidos':'As reservas do teu alojamento'}</h2><label><Search size={15}/><select value={filter} onChange={event=>setFilter(event.target.value as typeof filter)}><option value="ALL">Todos os estados</option>{Object.entries(statusNames).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
      {visible.length?visible.map(item=><BookingCard key={item.id} booking={item} isProfessional={isProfessional} busy={busy} reason={reason[item.id]??''} setReason={value=>setReason(current=>({...current,[item.id]:value}))} expanded={selectedId===item.id} history={history[item.id]} onToggleHistory={()=>void toggleHistory(item.id)} onAccept={()=>void decide(item,true)} onReject={()=>void decide(item,false)} onCancel={()=>void cancel(item)} onComplete={()=>void complete(item)}/>):<div className="profile-card booking-empty"><CalendarDays/><h2>Sem reservas neste estado.</h2><p>Os pedidos e respetivas atualizações aparecem aqui.</p>{!isProfessional&&<button className="secondary-button" onClick={()=>go('/profissionais')}>Encontrar profissionais</button>}</div>}
    </>}
    {tab==='services'&&isProfessional&&<section className="booking-management-grid"><div className="profile-card"><h2>{serviceForm.id?'Editar serviço':'Novo serviço'}</h2><form className="form" onSubmit={event=>void saveService(event)}><label className="field"><span>Nome</span><input required maxLength={120} value={serviceForm.name} onChange={e=>setServiceForm({...serviceForm,name:e.target.value})}/></label><label className="field"><span>Descrição</span><textarea rows={3} value={serviceForm.description} onChange={e=>setServiceForm({...serviceForm,description:e.target.value})}/></label><label className="field"><span>Modalidade</span><select value={serviceForm.modality_slug} onChange={e=>setServiceForm({...serviceForm,modality_slug:e.target.value})}><option value="">Sem modalidade específica</option>{modalities.filter(item=>item.active).map(item=><option value={item.slug} key={item.slug}>{item.name}</option>)}</select></label><div className="form-grid"><label className="field"><span>Duração · minutos</span><input required type="number" min="5" max="1440" value={serviceForm.duration} onChange={e=>setServiceForm({...serviceForm,duration:e.target.value})}/></label><label className="field"><span>Preço indicativo · EUR</span><input type="number" min="0" step="0.01" value={serviceForm.price} onChange={e=>setServiceForm({...serviceForm,price:e.target.value})}/></label></div><label className="publish-toggle"><input type="checkbox" checked={serviceForm.has_material} onChange={e=>setServiceForm({...serviceForm,has_material:e.target.checked})}/><span><strong>Tenho material para esta atividade</strong><small>Ex.: tapetes, pranchas, skates ou bolas.</small></span></label><label className="publish-toggle"><input type="checkbox" checked={serviceForm.allows_group} onChange={e=>setServiceForm({...serviceForm,allows_group:e.target.checked,max_students:e.target.checked?serviceForm.max_students:'',price_per_student:e.target.checked?serviceForm.price_per_student:false})}/><span><strong>Este serviço permite aulas em grupo</strong><small>Ativa esta opção para definir a capacidade da aula.</small></span></label>{serviceForm.allows_group&&<div className="form-grid"><label className="field"><span>Número máximo de alunos</span><input required type="number" min="1" max="100" step="1" value={serviceForm.max_students} onChange={e=>setServiceForm({...serviceForm,max_students:e.target.value})}/></label><label className="publish-toggle"><input type="checkbox" checked={serviceForm.price_per_student} onChange={e=>setServiceForm({...serviceForm,price_per_student:e.target.checked})}/><span><strong>O preço indicativo é por aluno</strong><small>Se desativado, o preço é o valor total do serviço.</small></span></label></div>}<label className="publish-toggle"><input type="checkbox" checked={serviceForm.active} onChange={e=>setServiceForm({...serviceForm,active:e.target.checked})}/><span><strong>Serviço ativo</strong><small>Serviços ativos podem receber pedidos.</small></span></label><div className="booking-actions"><button type="submit" className="primary-button"><Save size={15}/>{serviceForm.id?'Guardar alterações':'Criar serviço'}</button>{serviceForm.id&&<button type="button" className="secondary-button" onClick={()=>setServiceForm({id:'',name:'',description:'',modality_slug:'',duration:'60',price:'',active:true,has_material:false,allows_group:false,max_students:'',price_per_student:false})}>Cancelar edição</button>}</div></form></div><div className="profile-card"><h2>Catálogo de serviços</h2>{serviceEntries.length?serviceEntries.map(item=><article className={`service-manage-item service-${item.reviewState}`} key={item.entryKey}><div><strong>{item.name}</strong><span>{item.duration_minutes??'—'} min · {formatPrice(item.price,item.currency)} · {item.reviewState==='published'?(item.active?'Ativo':'Inativo'):item.reviewState==='pending'?'Pendente aprovação':`Rejeitado${serviceReviewHistory.at(-1)?.reason?` · ${serviceReviewHistory.at(-1)?.reason}`:''}`}</span><small>{item.description}</small>{item.has_material&&<small>Material disponível</small>}{item.allows_group&&<small>Grupo até {item.max_students} · {item.price_per_student?'preço por aluno':'preço pelo serviço'}</small>}</div>{item.reviewState==='published'&&<button className="secondary-button" onClick={()=>serviceEdit(item)}>Editar</button>}</article>):<p>Ainda não adicionaste serviços.</p>}</div></section>}
    {tab==='availability'&&isProfessional&&<>
      <section className="availability-grid"><div className="profile-card"><h2>Disponibilidade semanal</h2><p>Define um ou mais intervalos por dia. Não configures dias sem disponibilidade.</p><form className="form weekly-form" onSubmit={event=>void saveWeekly(event)}><label className="field"><span>Dia</span><select value={weeklyForm.day} onChange={e=>setWeeklyForm({...weeklyForm,day:e.target.value})}>{weekdays.map((day,index)=><option value={index} key={day}>{day}</option>)}</select></label><div className="form-grid"><label className="field"><span>Início · HH:mm</span><input type="text" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" title="Usa o formato 24 horas, por exemplo 09:00" placeholder="09:00" maxLength={5} value={weeklyForm.start} onChange={e=>setWeeklyForm({...weeklyForm,start:e.target.value})}/></label><label className="field"><span>Fim · HH:mm</span><input type="text" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" title="Usa o formato 24 horas, por exemplo 18:00" placeholder="18:00" maxLength={5} value={weeklyForm.end} onChange={e=>setWeeklyForm({...weeklyForm,end:e.target.value})}/></label></div><button className="primary-button" type="submit"><Plus size={16}/> Adicionar intervalo</button></form><div className="availability-items">{weekly.map(item=><div key={item.id}><span><strong>{weekdays[item.day_of_week]}</strong>{item.start_time.slice(0,5)}–{item.end_time.slice(0,5)}</span><button className="icon-danger" aria-label="Remover intervalo" onClick={()=>void removeWeekly(item)}><Trash2 size={16}/></button></div>)}</div></div><div className="profile-card"><h2>{overrideForm.id?'Editar exceção':'Exceções e bloqueios'}</h2><form className="form" onSubmit={event=>void saveOverride(event)}><label className="field"><span>Tipo</span><select value={overrideForm.type} onChange={e=>setOverrideForm({...overrideForm,type:e.target.value as 'AVAILABLE'|'BLOCKED'})}><option value="BLOCKED">Bloquear horário</option><option value="AVAILABLE">Abrir exceção</option></select></label><div className="exception-datetime-grid"><LisbonDateTimeField label="Início" value={overrideForm.starts} onChange={value=>setOverrideForm({...overrideForm,starts:value})}/><LisbonDateTimeField label="Fim" value={overrideForm.ends} onChange={value=>setOverrideForm({...overrideForm,ends:value})}/></div><label className="field"><span>Nota · opcional</span><input maxLength={500} value={overrideForm.reason} onChange={e=>setOverrideForm({...overrideForm,reason:e.target.value})}/></label><div className="booking-actions"><button className="primary-button" type="submit">{overrideForm.id?<Save size={16}/>:<Plus size={16}/>} {overrideForm.id?'Guardar alterações':'Guardar exceção'}</button>{overrideForm.id&&<button className="secondary-button" type="button" onClick={()=>setOverrideForm({id:'',starts:'',ends:'',type:'BLOCKED',reason:''})}>Cancelar edição</button>}</div></form><div className="availability-items">{overrides.map(item=><div key={item.id}><span><strong>{item.override_type==='BLOCKED'?'Bloqueio':'Disponível'}</strong>{formatCalendarDate(item.starts_at)} {new Date(item.starts_at).toLocaleTimeString('pt-PT',{timeZone:'Europe/Lisbon',hour:'2-digit',minute:'2-digit'})} – {formatCalendarDate(item.ends_at)} {new Date(item.ends_at).toLocaleTimeString('pt-PT',{timeZone:'Europe/Lisbon',hour:'2-digit',minute:'2-digit'})}{item.reason&&<small>{item.reason}</small>}</span><span className="availability-item-actions"><button className="icon-edit" aria-label="Editar exceção" onClick={()=>editOverride(item)}><Pencil size={15}/></button><button className="icon-danger" aria-label="Remover exceção" onClick={()=>void removeOverride(item)}><Trash2 size={16}/></button></span></div>)}</div></div></section>
      <section className="profile-card booking-calendar"><div className="booking-calendar-heading"><CalendarDays size={19}/><div><h2>Próximas reservas confirmadas</h2><p>Horários apresentados no fuso Europe/Lisbon.</p></div></div>{bookings.filter(item=>item.status==='CONFIRMED'&&new Date(item.starts_at)>=new Date()).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)).length?bookings.filter(item=>item.status==='CONFIRMED'&&new Date(item.starts_at)>=new Date()).sort((a,b)=>a.starts_at.localeCompare(b.starts_at)).map(item=><article key={item.id}><time>{formatDate(item.starts_at)}</time><div><strong>{item.hotel_name} · {item.service_name_snapshot}</strong><span>{item.students_count??item.participants} {item.price_type_snapshot==='PER_STUDENT'?'alunos':'participante(s)'} · {item.booking_reference}</span></div><button className="secondary-button" onClick={()=>{setTab('bookings');setFilter('CONFIRMED');setSelectedId(item.id);window.setTimeout(()=>document.getElementById(`booking-${item.id}`)?.scrollIntoView({behavior:'smooth',block:'center'}),100);}}>Ver reserva</button></article>):<p className="booking-calendar-empty">Ainda não tens reservas futuras confirmadas.</p>}</section>
    </>}
  </section>;
}

function LisbonDateTimeField({label,value,onChange}:{label:string;value:string;onChange:(value:string)=>void}) {
  const [date,time]=value.split('T');
  const visibleDate=date?`${date.slice(8,10)}/${date.slice(5,7)}/${date.slice(0,4)}`:'';
  const [draft,setDraft]=useState(visibleDate);
  useEffect(()=>setDraft(visibleDate),[visibleDate]);
  return <fieldset className="field lisbon-datetime-field"><legend>{label} · Europe/Lisbon</legend><div className="form-grid"><label className="field"><span>Data · DD/MM/AAAA</span><input required inputMode="numeric" pattern="\d{2}/\d{2}/\d{4}" title="Usa o formato DD/MM/AAAA" placeholder="DD/MM/AAAA" value={draft} onChange={event=>{
    setDraft(event.target.value);
    const match=/^(\d{2})\/(\d{2})\/(\d{4})$/.exec(event.target.value);
    if(match)onChange(`${match[3]}-${match[2]}-${match[1]}T${time??''}`);
  }}/></label><label className="field"><span>Hora · HH:mm</span><input required type="text" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" title="Usa o formato 24 horas, por exemplo 09:30" placeholder="09:00" maxLength={5} value={time??''} onChange={event=>onChange(`${date??''}T${event.target.value}`)}/></label></div></fieldset>;
}

function BookingCard({booking,isProfessional,busy,reason,setReason,expanded,history,onToggleHistory,onAccept,onReject,onCancel,onComplete}:{booking:Booking;isProfessional:boolean;busy:boolean;reason:string;setReason:(value:string)=>void;expanded:boolean;history?:History[];onToggleHistory:()=>void;onAccept:()=>void;onReject:()=>void;onCancel:()=>void;onComplete:()=>void}) {
  const deadlinePassed=booking.response_deadline_at?Date.now()>=Date.parse(booking.response_deadline_at):false;
  const canRespond=isProfessional&&booking.status==='PENDING'&&!deadlinePassed;
  const canCancel=(isProfessional?booking.status==='CONFIRMED':['PENDING','CONFIRMED'].includes(booking.status));
  const canComplete=!isProfessional&&booking.status==='CONFIRMED'&&new Date(booking.ends_at)<=new Date();
  const cancellationAllowed=canCancelBooking({role:isProfessional?'PROFESSIONAL':'HOTEL',status:booking.status,startsAt:booking.starts_at});
  return <article id={`booking-${booking.id}`} className={`profile-card booking-card ${expanded?'expanded':''}`}>
    <header><div><p className="eyebrow">{booking.booking_reference}</p><h2>{isProfessional?booking.hotel_name:booking.professional_name}</h2><span className={`review-badge ${booking.status.toLowerCase()}`}>{booking.resolution_code==='PROFESSIONAL_RESPONSE_TIMEOUT'?'Expirada':statusNames[booking.status]}</span></div><div className="booking-date"><CalendarDays size={16}/><span>{formatDate(booking.starts_at)}</span></div></header>
    <div className="booking-card-main"><div><span className="booking-icon">{isProfessional?<Building2 size={16}/>:<UserRound size={16}/>} {booking.service_name_snapshot}</span><span><Clock3 size={15}/>{booking.service_duration_minutes_snapshot} minutos</span><span>{booking.students_count??booking.participants} {booking.price_type_snapshot==='PER_STUDENT'?'alunos':'participante(s)'}</span><span>{bookingPriceSummary(booking)}</span></div><p><strong>Funcionário responsável:</strong> {booking.guest_name||'Não indicado'}</p>{booking.notes&&<p><strong>Observações:</strong> {booking.notes}</p>}{booking.status==='PENDING'&&booking.response_deadline_at&&<p role="status"><strong>Prazo de resposta:</strong> {formatDate(booking.response_deadline_at)} · Europe/Lisbon</p>}{deadlinePassed&&booking.status==='PENDING'&&<p role="status">O prazo terminou. O pedido aguarda a expiração automática do sistema.</p>}{booking.resolution_code==='PROFESSIONAL_RESPONSE_TIMEOUT'&&<p role="status">Cancelada automaticamente porque terminou o prazo de 4 horas sem resposta.</p>}<small>Pedido criado em {formatDate(booking.created_at)}</small></div>
    {canRespond&&<div className="booking-action-area"><label className="field"><span>Motivo · opcional (pedido rejeitado)</span><textarea rows={2} maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Indica um motivo ao rejeitar, se necessário."/></label><div className="booking-actions"><button className="secondary-button danger-button" disabled={busy} onClick={onReject}><X size={15}/> Rejeitar</button><button className="primary-button" disabled={busy} onClick={onAccept}><Check size={15}/> Aceitar e confirmar</button></div></div>}
    {canCancel&&!cancellationAllowed&&<p className="cancellation-expired" role="status">O prazo de cancelamento terminou. Contacta a WellWeb para resolver a situação.</p>}{canCancel&&cancellationAllowed&&<details className="cancel-booking"><summary>Cancelar {booking.status==='PENDING'?'pedido':'reserva'}</summary><label className="field"><span>Motivo · obrigatório</span><textarea required rows={2} maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Indica o motivo do cancelamento."/></label><button className="secondary-button danger-button" disabled={busy||!reason.trim()} onClick={onCancel}>Confirmar cancelamento</button></details>}
    {canComplete&&<button className="secondary-button" disabled={busy} onClick={()=>{if(window.confirm('Confirmas que a atividade foi realizada? Ao concluir esta reserva, confirmas a prestação do serviço e autorizas o futuro processamento da comissão aplicável.'))onComplete();}}>Concluir reserva</button>}
    {!isProfessional&&booking.status==='COMPLETED'&&<GuestReviewInvite booking={booking}/>}
    <button className="history-toggle" onClick={onToggleHistory}>{expanded?'Ocultar histórico':'Ver histórico'}</button>
    {expanded&&<ol className="booking-history">{history?.length?history.map(item=><li key={item.id}><strong>{statusNames[item.to_status as BookingStatus]??item.to_status}</strong><span>{historyActor(item,booking)} · {formatDate(item.created_at)}</span>{item.reason&&<small>{item.reason}</small>}</li>):<li>Sem eventos disponíveis.</li>}</ol>}
  </article>;
}

function GuestReviewInvite({booking}:{booking:Booking}) {
 const [url,setUrl]=useState(''),[qr,setQr]=useState(''),[expires,setExpires]=useState(''),[problem,setProblem]=useState(''),[busy,setBusy]=useState(false);
 const create=async()=>{if(!supabase)return;setBusy(true);setProblem('');const {data,error}=await supabase.rpc('hotel_create_review_invitation',{p_booking_id:booking.id});setBusy(false);if(error||!data?.token){setProblem('Não foi possível criar o link. Confirma o período de 14 dias e o número de participantes registados.');return;}const target=`${location.origin}/avaliar/${data.token}`;try{const image=await QRCode.toDataURL(target,{width:420,margin:2,errorCorrectionLevel:'M'});setUrl(target);setQr(image);setExpires(data.expires_at)}catch{setProblem('O link foi criado, mas não foi possível gerar o QR code. Tenta novamente.')}};
 return <details className="guest-review-invite"><summary>Link de avaliação para hóspedes</summary><p>Disponível após conclusão; válido por 14 dias e limitado ao número de participantes desta reserva.</p><button className="secondary-button" disabled={busy} onClick={()=>void create()}>{busy?'A criar…':url?'Gerar novo link':'Gerar link e QR code'}</button>{problem&&<p role="alert">{problem}</p>}{url&&<div className="guest-review-invite-result"><img src={qr} alt="QR code para abrir o formulário de avaliação"/><p>Expira: {new Date(expires).toLocaleString('pt-PT',{timeZone:'Europe/Lisbon',dateStyle:'medium',timeStyle:'short'})}</p><label className="field"><span>Link do hóspede</span><input readOnly value={url}/></label><div className="booking-actions"><button className="secondary-button" onClick={()=>void navigator.clipboard.writeText(url)}>Copiar link</button><a className="secondary-button" href={qr} download={`wellweb-review-${booking.booking_reference}.png`}>Descarregar QR</a><button className="secondary-button" onClick={()=>window.print()}>Imprimir</button></div></div>}</details>;
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
  return <div className="admin-booking-details"><p>{booking.students_count??booking.participants} {booking.price_type_snapshot==='PER_STUDENT'?'alunos':'participante(s)'} · {booking.service_duration_minutes_snapshot} min · {bookingPriceSummary(booking)}</p>{booking.guest_name&&<p>Funcionário responsável: {booking.guest_name}</p>}{booking.notes&&<p>Observações: {booking.notes}</p>}<ol className="booking-history">{history.map(item=><li key={item.id}><strong>{statusNames[item.to_status as BookingStatus]??item.to_status}</strong><span>{historyActor(item,booking)} · {formatDate(item.created_at)}</span>{item.reason&&<small>{item.reason}</small>}</li>)}</ol></div>;
}
