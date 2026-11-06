import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, BadgeCheck, Bell, Building2, Check, CircleAlert, Clock3, Flower2, Languages, LogOut, MapPin, ShieldCheck, UserRound, Users } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { accountHome, canAccessPath, type AccountStatus, type AccountType } from './lib/access';
import { Directory } from './Directory';
import { AdminDashboard } from './Admin';
import { AdminBookingManager, BookingCenter, BookingRequestPage } from './Bookings';
import { TagSelect } from './TagSelect';
import { LANGUAGE_OPTIONS } from './lib/catalog';
import { PROFILE_MEDIA_BUCKET, publicImageUrl, uploadProfileImage } from './lib/media';
import { registrationMetadata, validateRegistration, type RegistrationInput } from './lib/registration';
import { isSupabaseConfigured, supabase, supabaseConfigurationMessage } from './lib/supabase';

type AppUser = { id: string; auth_user_id: string; email: string; display_name: string | null; phone_e164: string | null; account_type: AccountType; status: AccountStatus };
type UploadItem = { id: string; name: string; status: 'loading' | 'success' | 'error'; message: string };
type Profile = {
  id: string; name?: string; address_line1?: string; address_line2?: string | null; postal_code?: string | null;
  city: string; country_code?: string; timezone?: string; service_area?: string; bio?: string | null;
  public_name?: string; description?: string; services?: string[]; public_contact_email?: string | null;
  public_phone?: string | null; website_url?: string | null; primary_photo_path?: string | null;
  gallery_photo_paths?: string[]; is_public?: boolean; approval_status?: 'PENDING'|'APPROVED'|'REJECTED';
  pending_profile?: Record<string, unknown> | null; modalities?: string[]; languages?: string[];
};

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => { const pop = () => setPath(location.pathname); addEventListener('popstate', pop); return () => removeEventListener('popstate', pop); }, []);
  const go = useCallback((to: string) => { history.pushState({}, '', to); setPath(to); scrollTo(0, 0); }, []);
  return [path, go] as const;
}

export default function App() {
  const [path, go] = usePath();
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<AppUser | null>(null);
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState('');

  const loadAccount = useCallback(async (current: User | null) => {
    setUser(current);
    if (!current || !supabase) { setAccount(null); setAuthReady(true); return; }
    setAuthReady(false);
    const { data, error } = await supabase.from('app_users').select('id,auth_user_id,email,display_name,phone_e164,account_type,status').eq('auth_user_id', current.id).maybeSingle();
    setAccount(error ? null : data as AppUser | null);
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession()
      .then(({ data }) => loadAccount(data.session?.user ?? null))
      .catch(() => {
        setUser(null); setAccount(null); setAuthReady(true);
        setProblem('Não foi possível validar a sessão. Verifica a ligação e inicia sessão novamente.');
      });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => { void loadAccount(session?.user ?? null); }, 0);
    });
    return () => subscription.unsubscribe();
  }, [loadAccount]);

  useEffect(() => {
    if (!authReady || !account || !canAccessPath(account.account_type, account.status, path)) return;
    if (path === '/hotel' || path === '/profissional' || path === '/admin') go(accountHome(account.account_type));
  }, [account, authReady, go, path]);

  const signOut = async () => { if (supabase) await supabase.auth.signOut(); setAccount(null); setUser(null); setNotice('Sessão terminada.'); go('/'); };
  const protectedPath = path === '/hotel' || path === '/profissional' || path === '/admin' || path === '/reservas' || path.startsWith('/reservar/');
  if (protectedPath && !authReady) return <Layout go={go}><div className="center-card"><div className="spinner"/><p>A validar a sessão…</p></div></Layout>;
  if (protectedPath && isSupabaseConfigured && !user) return <Layout go={go}><div className="center-card"><ShieldCheck/><h1>Inicia sessão para continuar.</h1><p>Esta área está reservada a contas WellWeb autenticadas.</p><Button onClick={() => go('/entrar')}>Iniciar sessão</Button></div></Layout>;
  if (protectedPath && (!account || account.status !== 'ACTIVE')) return <Layout go={go}><div className="center-card"><ShieldCheck/><h1>Acesso indisponível</h1><p>{account?.status === 'SUSPENDED' ? 'Esta conta está suspensa. Contacta a equipa WellWeb.' : 'A conta ainda não está ativa ou não tem um perfil associado.'}</p><Button onClick={() => go('/entrar')}>Voltar ao início de sessão</Button></div></Layout>;
  if (protectedPath && !canAccessPath(account?.account_type ?? null, account?.status ?? null, path)) return <Layout go={go}><div className="center-card"><ShieldCheck/><h1>Área reservada</h1><p>Este espaço não corresponde ao tipo da tua conta.</p><Button onClick={() => go(accountHome(account!.account_type))}>Ir para a minha área</Button></div></Layout>;

  let page;
  const professionalDetail = path.match(/^\/profissional\/([^/]+)$/);
  const hotelDetail = path.match(/^\/hotel\/([^/]+)$/);
  const bookingRequest = path.match(/^\/reservar\/([^/]+)$/);
  if (path === '/entrar') page = <Login go={go} onSignedIn={loadAccount} setProblem={setProblem} setNotice={setNotice}/>;
  else if (path === '/registar/hotel') page = <Register type="HOTEL" go={go} setProblem={setProblem} setNotice={setNotice}/>;
  else if (path === '/registar/profissional') page = <Register type="PROFESSIONAL" go={go} setProblem={setProblem} setNotice={setNotice}/>;
  else if (path === '/recuperar') page = <Recover go={go} setProblem={setProblem} setNotice={setNotice}/>;
  else if (path === '/nova-palavra-passe') page = <NewPassword go={go} setProblem={setProblem} setNotice={setNotice}/>;
  else if (path === '/hotel' || path === '/profissional') page = <Dashboard account={account!} onSignOut={signOut} setProblem={setProblem} setNotice={setNotice}/>;
  else if (path === '/reservas') page = <BookingCenter account={account!} go={go}/>;
  else if (bookingRequest) page = <BookingRequestPage profileId={bookingRequest[1]} account={account!} go={go} setNotice={setNotice}/>;
  else if (path === '/admin') page = <AdminDashboard/>;
  else if (path === '/profissionais' || professionalDetail) page = <Directory mode="professionals" go={go} detailId={professionalDetail?.[1]} account={account}/>;
  else if (path === '/hoteis' || hotelDetail) page = <Directory mode="hotels" go={go} detailId={hotelDetail?.[1]}/>;
  else page = <Home go={go} account={account} onSignOut={signOut}/>;
  return <Layout go={go} account={account} onSignOut={signOut}>{notice && path !== '/' && <div className="toast success"><Check size={17}/>{notice}<button onClick={() => setNotice('')} aria-label="Fechar">×</button></div>}{problem && <div className="toast error"><span>{problem}</span><button onClick={() => setProblem('')} aria-label="Fechar">×</button></div>}{page}</Layout>;
}

function Layout({ children, go, account, onSignOut }: { children: React.ReactNode; go: (p: string) => void; account?: AppUser | null; onSignOut?: () => void }) {
  const [unreadCount, setUnreadCount] = useState(0);
  useEffect(() => {
    if (!supabase || !account || !['HOTEL','PROFESSIONAL'].includes(account.account_type) || account.status !== 'ACTIVE') { setUnreadCount(0); return; }
    const client = supabase;
    let live = true;
    const refresh = async () => {
      const { count } = await client.from('wellweb_notifications').select('id', { count: 'exact', head: true }).is('read_at', null);
      if (live) setUnreadCount(count ?? 0);
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 30_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [account?.account_type, account?.id, account?.status]);
  return <div className="app-shell"><header className="topbar"><button className="brand" onClick={() => go('/')} aria-label="WellWeb — página inicial"><img src="/brand/wellweb-logo-transparent.png" alt="WellWeb — Wellness · Experiences · Connections"/></button><nav className="main-nav"><button className="nav-link" onClick={() => go('/profissionais')}>Profissionais</button><button className="nav-link" onClick={() => go('/hoteis')}>Alojamentos</button>{account?.status === 'ACTIVE' ? <>{['HOTEL','PROFESSIONAL'].includes(account.account_type)&&<button className="nav-link reservation-nav-link" onClick={() => go('/reservas')}>Reservas{unreadCount>0&&<span className="unread-count">{unreadCount>9?'9+':unreadCount}</span>}</button>}<button className={`nav-link${account.account_type === 'ADMIN' ? ' admin-nav-link' : ''}`} onClick={() => go(accountHome(account.account_type))}>{account.account_type === 'ADMIN' ? 'Administração' : 'A minha área'}</button><button className="nav-logout" onClick={onSignOut}><LogOut size={16}/> Sair</button></> : <button className="nav-cta" onClick={() => go('/entrar')}>Iniciar sessão <ArrowRight size={15}/></button>}</nav></header><main>{children}</main><footer className="site-footer"><button className="footer-brand" onClick={() => go('/')}><img src="/brand/wellweb-logo-transparent.png" alt="WellWeb"/></button><span>Uma comunidade de hospitalidade e bem-estar</span><nav><button onClick={() => go('/profissionais')}>Profissionais</button><button onClick={() => go('/hoteis')}>Alojamentos</button></nav><small>© WellWeb · Portugal</small></footer></div>;
}
function Button({ children, onClick, type = 'button', disabled = false }: { children: React.ReactNode; onClick?: () => void; type?: 'button'|'submit'; disabled?: boolean }) { return <button className="primary-button" type={type} onClick={onClick} disabled={disabled}>{children}<ArrowRight size={17}/></button>; }
function UploadFeedback({ item }: { item: UploadItem }) { return <div className={`upload-feedback ${item.status}`} role={item.status==='error'?'alert':'status'} aria-live="polite">{item.status==='loading'?<span className="upload-spinner" aria-hidden="true"/>:item.status==='success'?<Check size={15} aria-hidden="true"/>:<CircleAlert size={15} aria-hidden="true"/>}<span><strong>{item.name}</strong><small>{item.message}</small></span></div>; }
function Field({ label, name, value, onChange, type = 'text', required = true, placeholder, error, autoComplete }: { label: string; name: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean; placeholder?: string; error?: string; autoComplete?: string }) { return <label className="field"><span>{label}</span><input name={name} type={type} value={value} onChange={e => onChange(e.target.value)} required={required} placeholder={placeholder} autoComplete={autoComplete}/>{error && <small className="field-error">{error}</small>}</label>; }

function Home({ go, account, onSignOut }: { go:(p:string)=>void; account:AppUser|null; onSignOut:()=>void }) {
  return <>
    <section className="marketing-hero"><div className="marketing-copy"><p className="eyebrow"><span/> BEM-ESTAR · EXPERIÊNCIAS · CONEXÕES</p><h1><span>Experiências de</span><span>bem-estar</span><em><span>que fazem a</span><span>diferença.</span></em></h1><p className="intro">Ligamos hotéis e hostels a profissionais locais de bem-estar e saúde desportiva, para oferecer aos hóspedes experiências únicas — do surf ao yoga, do mindfulness à massagem.</p><div className="hero-actions">{account?.status === 'ACTIVE' ? <Button onClick={() => go(accountHome(account.account_type))}>Aceder à minha área</Button> : <><Button onClick={() => go('/profissionais')}>Encontrar profissionais</Button><button className="secondary-button" onClick={() => go('/registar/profissional')}>Sou profissional <ArrowRight size={16}/></button></>}<button className="text-button" onClick={() => account ? onSignOut() : go('/registar/hotel')}>{account ? 'Terminar sessão' : 'Sou um alojamento'}</button></div><div className="trust"><ShieldCheck size={17}/> Experiências locais com significado</div></div><div className="hero-photo"><img src="https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=1200&q=85" alt="Mulher a praticar yoga num ambiente tranquilo"/><div className="hero-photo-caption"><span>ERICEIRA · MAFRA · COSTA OESTE</span><strong>O melhor da região, mais perto.</strong></div><div className="hero-photo-note"><strong>Mais valor para cada estadia.</strong><br/>Experiências locais com significado</div></div></section>
    <section className="editorial-intro"><p className="eyebrow">WELLNESS · EXPERIENCES · CONNECTIONS</p><h2>O melhor de um destino<br/><em>vive-se por dentro.</em></h2><p>De uma aula de surf ao primeiro sol da manhã, a WellWeb aproxima pessoas, alojamentos e experiências que fazem sentido para cada lugar.</p></section>
    <section className="experience-strip"><button className="experience-tile tile-surf" onClick={() => go('/profissionais')}><img src="https://images.unsplash.com/photo-1502680390469-be75c86b636f?auto=format&fit=crop&w=1000&q=85" alt="Surfista a preparar-se para entrar no mar"/><span>01 · MOVIMENTO</span><strong>Mar, corpo e liberdade</strong></button><button className="experience-tile tile-yoga" onClick={() => go('/profissionais')}><img src="https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?auto=format&fit=crop&w=1000&q=85" alt="Prática de yoga num ambiente natural"/><span>02 · BEM-ESTAR</span><strong>Ritmos para abrandar</strong></button><button className="experience-tile tile-massage" onClick={() => go('/profissionais')}><img src="https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=1000&q=85" alt="Ambiente sereno de spa e massagem"/><span>03 · CUIDADO</span><strong>Tempo para cuidar</strong></button><button className="experience-tile tile-stay" onClick={() => go('/hoteis')}><img src="https://images.unsplash.com/photo-1571896349842-33c89424de2d?auto=format&fit=crop&w=1000&q=85" alt="Alojamento acolhedor rodeado de natureza"/><span>04 · HOSPITALIDADE</span><strong>Lugares com identidade</strong></button></section>
    <section className="directory-invite"><div><p className="eyebrow">A COMUNIDADE WELLWEB</p><h2>Talento local.<br/><em>Encontros verdadeiros.</em></h2><p>Descobre profissionais independentes e alojamentos que partilham uma forma mais humana de receber.</p></div><div className="invite-actions"><button onClick={() => go('/profissionais')}><span>Explorar profissionais</span><ArrowRight/></button><button onClick={() => go('/hoteis')}><span>Descobrir alojamentos</span><ArrowRight/></button></div></section>
    <section className="join-banner"><div><p className="eyebrow">FAZ PARTE DE ALGO BOM</p><h2>O próximo encontro<br/><em>pode começar contigo.</em></h2></div><div className="join-actions"><button className="primary-button" onClick={() => go('/registar/hotel')}>Para alojamentos <ArrowRight size={16}/></button><button className="secondary-button" onClick={() => go('/registar/profissional')}>Para profissionais <ArrowRight size={16}/></button></div></section>
  </>;
}

function AuthFrame({ title, intro, children, go, aside = 'Uma comunidade que valoriza o talento local e a hospitalidade.' }: { title:string; intro:string; children:React.ReactNode; go:(p:string)=>void; aside?:string }) { return <section className="auth-layout"><div className="auth-form-wrap"><button className="back-link" onClick={() => go('/')}><ArrowLeft size={16}/> Voltar</button><p className="eyebrow">WELLWEB · COMEÇAR</p><h1>{title}</h1><p className="form-intro">{intro}</p>{supabaseConfigurationMessage && <div className="inline-alert">{supabaseConfigurationMessage}</div>}{children}</div><aside className="auth-aside"><img className="auth-brand-mark" src="/brand/wellweb-logo-transparent.png" alt="WellWeb — Wellness · Experiences · Connections"/><p>“{aside}”</p><span>WELLNESS · EXPERIENCES · CONNECTIONS</span></aside></section>; }

function Login({go,onSignedIn,setProblem,setNotice}:{go:(p:string)=>void;onSignedIn:(u:User|null)=>Promise<void>;setProblem:(s:string)=>void;setNotice:(s:string)=>void}) {
  const [email,setEmail]=useState('');const [password,setPassword]=useState('');const [busy,setBusy]=useState(false);
  const submit=async(e:FormEvent)=>{e.preventDefault();setProblem('');if(!supabase){setProblem(supabaseConfigurationMessage??'Supabase não está configurado.');return;}setBusy(true);const {data,error}=await supabase.auth.signInWithPassword({email:email.trim(),password});if(error){const message=error.message.includes('Invalid login credentials')?'Email ou palavra-passe incorretos.':error.message.includes('Email not confirmed')?'Confirma o teu email antes de iniciar sessão.':error.message;setProblem(message);setBusy(false);return;}await onSignedIn(data.user);const {data:row}=await supabase.from('app_users').select('account_type,status').eq('auth_user_id',data.user.id).maybeSingle();setBusy(false);if(!row||row.status!=='ACTIVE'){await supabase.auth.signOut();setProblem(row?.status==='SUSPENDED'?'A conta está suspensa. Contacta a equipa WellWeb.':'A conta ainda não está ativa ou não tem perfil associado.');return;}setNotice('Sessão iniciada com sucesso.');go(accountHome(row.account_type as AccountType));};
  return <AuthFrame go={go} title="Que bom ter-te de volta." intro="Inicia sessão para continuares na tua área WellWeb."><form className="form" onSubmit={submit}><Field label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email"/><Field label="Palavra-passe" name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password"/><button className="forgot-link" type="button" onClick={()=>go('/recuperar')}>Esqueceste-te da palavra-passe?</button><Button type="submit" disabled={busy}>{busy?'A entrar…':'Iniciar sessão'}</Button></form><p className="form-switch">Ainda não tens conta? <button onClick={()=>go('/')}>Escolhe o teu perfil</button></p></AuthFrame>;
}

function Register({type,go,setProblem,setNotice}:{type:'HOTEL'|'PROFESSIONAL';go:(p:string)=>void;setProblem:(s:string)=>void;setNotice:(s:string)=>void}) {
  const isHotel=type==='HOTEL'; const [values,setValues]=useState<RegistrationInput>({displayName:'',email:'',password:'',passwordConfirmation:'',phone:'',city:'',hotelName:'',address:'',serviceArea:'',bio:''});const [errors,setErrors]=useState<Record<string,string>>({});const [busy,setBusy]=useState(false);
  const set=(k:keyof RegistrationInput)=>(v:string)=>setValues(old=>({...old,[k]:v}));
  const submit=async(e:FormEvent)=>{e.preventDefault();setProblem('');const next=validateRegistration(values,type);setErrors(next);if(Object.keys(next).length)return;if(!supabase){setProblem(supabaseConfigurationMessage??'Supabase não está configurado.');return;}setBusy(true);const {data,error}=await supabase.auth.signUp({email:values.email.trim(),password:values.password,options:{data:registrationMetadata(values,type),emailRedirectTo:`${location.origin}/entrar`}});setBusy(false);if(error){setProblem(error.message);return;}setNotice(data.session?'Conta criada. A tua área já está disponível.':'Conta criada. Confirma o email para ativares o acesso.');go(data.session?accountHome(type):'/entrar');};
  return <AuthFrame go={go} title={isHotel?'O teu alojamento, na WellWeb.':'O teu talento merece espaço.'} intro={isHotel?'Cria uma conta para o teu alojamento e prepara o teu perfil.':'Cria o teu perfil profissional e junta-te à comunidade WellWeb.'} aside={isHotel?'Mais ligação local para proporcionar experiências memoráveis.':'Partilha o que fazes de melhor com novos parceiros locais.'}><form className="form registration-form" onSubmit={submit}><div className="form-grid"><Field label={isHotel?'Nome do responsável':'Nome profissional'} name="displayName" value={values.displayName} onChange={set('displayName')} autoComplete="name" error={errors.displayName}/>{isHotel&&<Field label="Nome do alojamento" name="hotelName" value={values.hotelName??''} onChange={set('hotelName')} error={errors.hotelName}/>}<Field label="Email" name="email" type="email" value={values.email} onChange={set('email')} autoComplete="email" error={errors.email}/><Field label="Contacto telefónico" name="phone" type="tel" value={values.phone} onChange={set('phone')} placeholder="+351912345678" autoComplete="tel" error={errors.phone}/>{isHotel?<Field label="Morada do alojamento" name="address" value={values.address??''} onChange={set('address')} autoComplete="street-address" error={errors.address}/>:<Field label="Área de atuação" name="serviceArea" value={values.serviceArea??''} onChange={set('serviceArea')} placeholder="Ex.: yoga, surf, massagens" error={errors.serviceArea}/>}<Field label="Localidade" name="city" value={values.city} onChange={set('city')} autoComplete="address-level2" error={errors.city}/><Field label="Palavra-passe" name="password" type="password" value={values.password} onChange={set('password')} autoComplete="new-password" error={errors.password}/><Field label="Confirmar palavra-passe" name="passwordConfirmation" type="password" value={values.passwordConfirmation} onChange={set('passwordConfirmation')} autoComplete="new-password" error={errors.passwordConfirmation}/></div><p className="password-hint">Mínimo de 10 caracteres. Usa uma palavra-passe única.</p><Button type="submit" disabled={busy}>{busy?'A criar conta…':'Criar conta'}</Button></form><p className="form-switch">Já tens conta? <button onClick={()=>go('/entrar')}>Iniciar sessão</button></p></AuthFrame>;
}

function Recover({go,setProblem,setNotice}:{go:(p:string)=>void;setProblem:(s:string)=>void;setNotice:(s:string)=>void}) { const [email,setEmail]=useState('');const [busy,setBusy]=useState(false);const submit=async(e:FormEvent)=>{e.preventDefault();setProblem('');if(!supabase){setProblem(supabaseConfigurationMessage??'Supabase não está configurado.');return;}setBusy(true);const {error}=await supabase.auth.resetPasswordForEmail(email.trim(),{redirectTo:`${location.origin}/nova-palavra-passe`});setBusy(false);if(error){setProblem(error.message);return;}setNotice('Se existir uma conta para este email, receberás uma mensagem com os próximos passos.');go('/entrar');};return <AuthFrame go={go} title="Vamos recuperar o acesso." intro="Indica o email associado à tua conta e enviamos um link para definires uma nova palavra-passe."><form className="form" onSubmit={submit}><Field label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email"/><Button type="submit" disabled={busy}>{busy?'A enviar…':'Enviar link de recuperação'}</Button></form><p className="form-switch"><button onClick={()=>go('/entrar')}>Voltar ao início de sessão</button></p></AuthFrame>; }
function NewPassword({go,setProblem,setNotice}:{go:(p:string)=>void;setProblem:(s:string)=>void;setNotice:(s:string)=>void}) { const [password,setPassword]=useState('');const [confirmation,setConfirmation]=useState('');const [busy,setBusy]=useState(false);const submit=async(e:FormEvent)=>{e.preventDefault();setProblem('');if(password.length<10||password!==confirmation){setProblem(password.length<10?'A palavra-passe deve ter pelo menos 10 caracteres.':'As palavras-passe não coincidem.');return;}if(!supabase){setProblem(supabaseConfigurationMessage??'Supabase não está configurado.');return;}setBusy(true);const {error}=await supabase.auth.updateUser({password});setBusy(false);if(error){setProblem(error.message);return;}setNotice('Palavra-passe atualizada. Já podes iniciar sessão.');go('/entrar');};return <AuthFrame go={go} title="Define uma nova palavra-passe." intro="Escolhe uma palavra-passe segura para voltares à tua conta."><form className="form" onSubmit={submit}><Field label="Nova palavra-passe" name="password" type="password" value={password} onChange={setPassword} autoComplete="new-password"/><Field label="Confirmar palavra-passe" name="confirmation" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password"/><Button type="submit" disabled={busy}>{busy?'A guardar…':'Guardar palavra-passe'}</Button></form></AuthFrame>; }

function Dashboard({account,onSignOut,setProblem,setNotice}:{account:AppUser;onSignOut:()=>void;setProblem:(s:string)=>void;setNotice:(s:string)=>void}) {
  const isHotel=account.account_type==='HOTEL';
  const [profile,setProfile]=useState<Profile|null>(null);
  const [displayName,setDisplayName]=useState(account.display_name??'');
  const [phone,setPhone]=useState(account.phone_e164??'');
  const [busy,setBusy]=useState(false),[uploading,setUploading]=useState(false),[loading,setLoading]=useState(true);
  const [modalities,setModalities]=useState<{value:string;label:string}[]>([]);
  const [primaryUpload,setPrimaryUpload]=useState<UploadItem|null>(null);
  const [galleryUploads,setGalleryUploads]=useState<UploadItem[]>([]);

  useEffect(()=>{let live=true;(async()=>{
    if(!supabase){setLoading(false);return;}
    let row:Profile|null=null;
    if(isHotel){
      const {data:member}=await supabase.from('hotel_members').select('hotel_id').eq('user_id',account.id).eq('status','ACTIVE').maybeSingle();
      if(member){const {data}=await supabase.from('hotels').select('*').eq('id',member.hotel_id).maybeSingle();row=data as Profile|null;}
    } else {
      const {data}=await supabase.from('professional_profiles').select('*').eq('user_id',account.id).maybeSingle();row=data as Profile|null;
      const {data:catalog}=await supabase.from('modality_catalog').select('slug,name').eq('active',true).order('name');
      if(live&&catalog)setModalities(catalog.map(item=>({value:item.slug,label:item.name})));
      if(row){
        const {data:links}=await supabase.from('professional_modalities').select('modality_slug').eq('professional_profile_id',row.id);
        row.modalities=(links??[]).map(item=>item.modality_slug);
        if(row.pending_profile){row.modalities=(row.pending_profile.modalities as string[]|undefined)??row.modalities;row.languages=(row.pending_profile.languages as string[]|undefined)??row.languages;row={...row,...row.pending_profile};}
      }
    }
    if(live)setProfile(row);
    if(live)setLoading(false);
  })();return()=>{live=false;};},[account.id,isHotel]);

  const upload=async(file:File,gallery=false,batch?:{index:number;total:number})=>{
    if(!profile)return;const id=crypto.randomUUID();const progress=batch?`A carregar fotografia ${batch.index} de ${batch.total}…`:'A carregar fotografia…';
    const pending:UploadItem={id,name:file.name,status:'loading',message:progress};
    if(gallery)setGalleryUploads(current=>[...current.slice(-4),pending]);else setPrimaryUpload(pending);
    if(!batch)setUploading(true);
    const update=(status:UploadItem['status'],message:string)=>{const item={...pending,status,message};if(gallery)setGalleryUploads(current=>current.map(existing=>existing.id===id?item:existing));else setPrimaryUpload(item);};
    try{
      const path=await uploadProfileImage(file,isHotel?'HOTEL':'PROFESSIONAL');
      setProfile(current=>current?gallery?{...current,gallery_photo_paths:[...(current.gallery_photo_paths??[]),path].slice(0,12)}:{...current,primary_photo_path:path}:current);
      update('success',batch?`Fotografia ${batch.index} de ${batch.total} adicionada com sucesso.`:'Fotografia adicionada com sucesso.');
    }catch(error){
      const reason=error instanceof Error&&(/Escolhe uma imagem|no máximo 10 MB|armazenamento de imagens não está configurado|Inicia sessão novamente/i.test(error.message))?` ${error.message}`:'';
      update('error',`Não foi possível carregar a fotografia.${reason} Verifica e tenta novamente.`);
    }finally{if(!batch)setUploading(false);}
  };
  const uploadGallery=async(files:FileList|null)=>{
    if(!files||!profile)return;
    const room=Math.max(0,12-(profile.gallery_photo_paths?.length??0));
    const selected=Array.from(files).slice(0,room);
    if(files.length>room){const item:UploadItem={id:crypto.randomUUID(),name:'Limite da galeria',status:'error',message:`A galeria admite até 12 fotografias. Só é possível adicionar ${room} agora.`};setGalleryUploads(current=>[...current.slice(-4),item]);}
    if(!selected.length)return;
    setUploading(true);
    try{for(let index=0;index<selected.length;index++)await upload(selected[index],true,{index:index+1,total:selected.length});}
    finally{setUploading(false);}
  };
  // Keep stored originals intact. Removing a published image is staged like other edits.
  const removePhoto=(path:string)=>setProfile(current=>current?{...current,primary_photo_path:current.primary_photo_path===path?null:current.primary_photo_path,gallery_photo_paths:(current.gallery_photo_paths??[]).filter(item=>item!==path)}:current);
  const save=async(e:FormEvent)=>{
    e.preventDefault();setProblem('');if(!supabase||!profile)return;setBusy(true);
    const userResult=await supabase.from('app_users').update({display_name:displayName.trim(),phone_e164:phone.trim()}).eq('id',account.id);
    const payload=isHotel?{
      name:profile.name,address_line1:profile.address_line1,city:profile.city,description:profile.description,
      public_contact_email:profile.public_contact_email,public_phone:profile.public_phone,website_url:profile.website_url,
      primary_photo_path:profile.primary_photo_path,gallery_photo_paths:profile.gallery_photo_paths??[],is_public:profile.is_public,
    }:{
      public_name:displayName.trim(),city:profile.city,service_area:profile.service_area,bio:profile.bio,description:profile.description,
      primary_photo_path:profile.primary_photo_path,gallery_photo_paths:profile.gallery_photo_paths??[],is_public:profile.is_public,
    };
    const result=userResult.error?{error:userResult.error}:await supabase.rpc('submit_wellweb_partner_profile',{
      p_profile:payload,p_modalities:profile.modalities??[],p_languages:profile.languages??[],
    });
    setBusy(false);if(result.error){setProblem('Não foi possível guardar. Confirma os campos e tenta novamente.');return;}
    const pending=(result.data as {pending_review?:boolean}|null)?.pending_review;
    setProfile(current=>current?{...current,pending_profile:pending?payload:null}:current);
    setNotice(pending?'Alterações submetidas à revisão. A versão aprovada continua publicada.':'Perfil guardado e enviado para aprovação.');
  };
  const cover=publicImageUrl(profile?.primary_photo_path);
  const approval=profile?.approval_status??'PENDING';
  const statusLabel=approval==='APPROVED'?'Aprovado':approval==='REJECTED'?'Rejeitado':'Pendente de aprovação';
  const statusIcon=approval==='APPROVED'?<BadgeCheck size={14}/>:<Clock3 size={14}/>;
  const languages=profile?.languages??[];

  return <section className="dashboard">
    <div className="dashboard-head"><div><p className="eyebrow">ÁREA PRIVADA · {isHotel?'ALOJAMENTO':'PROFISSIONAL'}</p><h1>Olá, {account.display_name?.split(' ')[0]||'bem-vindo'}.</h1><p>Gere o teu perfil e acompanha o estado da tua presença na WellWeb.</p></div><div className="profile-avatar">{isHotel?<Building2/>:<UserRound/>}</div></div>
    <div className="partner-status-card"><span className={`review-badge ${approval.toLowerCase()}`}>{statusIcon}{statusLabel}</span><p>{approval==='APPROVED'?'O teu perfil aprovado pode aparecer no diretório quando a opção de publicação estiver ativa.':approval==='REJECTED'?'Atualiza o perfil e volta a submeter para revisão.':'Completa o perfil e submete-o. A equipa WellWeb irá rever antes da publicação.'}</p>{profile?.pending_profile&&<small>Há alterações em revisão; a versão publicada mantém-se visível.</small>}</div>
    <div className="dashboard-grid"><aside className="dashboard-menu"><div className="menu-item active"><UserRound size={17}/> O meu perfil</div><button className="menu-item" onClick={()=>location.assign(isHotel?'/profissionais':'/hoteis')}><Users size={17}/> {isHotel?'Encontrar profissionais':'Ver alojamentos'}</button>{!isHotel&&<><button className="menu-item" onClick={()=>location.assign('/reservas?tab=services')}><BadgeCheck size={17}/> Serviços</button><button className="menu-item" onClick={()=>location.assign('/reservas?tab=availability')}><Clock3 size={17}/> Disponibilidade</button></>}<button className="menu-item" onClick={()=>location.assign('/reservas?tab=bookings')}><Languages size={17}/> Reservas</button><button className="menu-item logout" onClick={onSignOut}><LogOut size={17}/> Terminar sessão</button></aside>
      <div className="profile-card"><div className="card-title"><div><h2>O teu perfil</h2><p>{isHotel?'Os contactos públicos são opcionais.':'Escolhe modalidades e idiomas para ajudar hotéis a encontrar-te.'}</p></div><span className="status-pill">{statusIcon}{statusLabel}</span></div>
      {loading?<div className="loading-line"><div className="spinner"/> A carregar perfil…</div>:!profile?<div className="inline-alert">Não foi possível carregar o perfil associado. Confirma que as migrations foram aplicadas localmente.</div>:<form className="form" onSubmit={save}>
        <div className="profile-media-editor"><div className="profile-cover-preview">{cover?<><img src={cover} alt="Pré-visualização da fotografia principal"/><button type="button" className="remove-photo" onClick={()=>profile.primary_photo_path&&removePhoto(profile.primary_photo_path)} aria-label="Remover fotografia principal">×</button></>:<div className="photo-placeholder">{isHotel?<Building2/>:<UserRound/>}</div>}</div><div><p className="eyebrow">IMAGEM DE DESTAQUE</p><p className="media-help">JPG, PNG ou WebP · máximo 10 MB</p><label className="upload-button">{uploading?'A carregar fotografia…':'Escolher fotografia'}<input type="file" accept="image/jpeg,image/png,image/webp" disabled={uploading} onChange={event=>{const file=event.target.files?.[0];if(file)void upload(file);event.currentTarget.value='';}}/></label>{primaryUpload&&<UploadFeedback item={primaryUpload}/>}</div></div>
        <div className="form-grid"><Field label={isHotel?'Nome do responsável':'Nome profissional'} name="display_name" value={displayName} onChange={setDisplayName} autoComplete="name"/><Field label="Email de acesso" name="email" value={account.email} onChange={()=>{}}/><Field label="Contacto telefónico privado" name="phone" type="tel" value={phone} onChange={setPhone}/>{isHotel?<><Field label="Nome do alojamento" name="name" value={profile.name??''} onChange={v=>setProfile({...profile,name:v})}/><Field label="Morada" name="address" value={profile.address_line1??''} onChange={v=>setProfile({...profile,address_line1:v})}/><Field label="Email público" name="public_contact_email" type="email" required={false} value={profile.public_contact_email??''} onChange={v=>setProfile({...profile,public_contact_email:v})}/><Field label="Telefone público" name="public_phone" type="tel" required={false} value={profile.public_phone??''} onChange={v=>setProfile({...profile,public_phone:v})}/><Field label="Website" name="website_url" type="url" required={false} placeholder="https://" value={profile.website_url??''} onChange={v=>setProfile({...profile,website_url:v})}/></>:<><Field label="Área de atuação" name="service_area" value={profile.service_area??''} onChange={v=>setProfile({...profile,service_area:v})}/></>}<Field label="Localidade" name="city" value={profile.city??''} onChange={v=>setProfile({...profile,city:v})}/></div>
        {!isHotel&&<><TagSelect label="Modalidades" options={modalities} value={profile.modalities??[]} onChange={value=>setProfile({...profile,modalities:value})} hint="Seleciona as modalidades que melhor descrevem a tua atividade."/><TagSelect label="Idiomas" options={LANGUAGE_OPTIONS.map(item=>({value:item.value,label:item.label,flag:item.flag}))} value={languages} onChange={value=>setProfile({...profile,languages:value})} hint="Os idiomas selecionados aparecem no teu perfil público."/></>}
        <label className="field"><span>{isHotel?'Descrição do alojamento':'Apresentação profissional'}</span><textarea rows={5} maxLength={5000} value={profile.description??''} onChange={event=>setProfile({...profile,description:event.target.value})} placeholder="Conta o que torna a tua experiência especial."/></label>
        <div className="gallery-editor"><div><strong>Galeria</strong><span>{profile.gallery_photo_paths?.length??0}/12 fotografias</span></div><div className="gallery-preview">{(profile.gallery_photo_paths??[]).map((path,index)=>{const url=publicImageUrl(path);return url?<div className="gallery-photo" key={`${path}-${index}`}><img src={url} alt={`Imagem da galeria ${index+1}`}/><button type="button" className="remove-photo" onClick={()=>removePhoto(path)} aria-label={`Remover fotografia ${index+1}`}>×</button></div>:null;})}</div><label className="upload-button">{uploading?'A carregar fotografias…':'Adicionar fotografias'}<input type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={uploading||(profile.gallery_photo_paths?.length??0)>=12} onChange={event=>{void uploadGallery(event.target.files);event.currentTarget.value='';}}/></label>{galleryUploads.map(item=><UploadFeedback key={item.id} item={item}/>)}</div>
        <label className="publish-toggle"><input type="checkbox" checked={profile.is_public??false} onChange={event=>setProfile({...profile,is_public:event.target.checked})}/><span><strong>Publicar no diretório</strong><small>O perfil só fica visível após aprovação e ativação desta opção.</small></span></label>
        <div className="profile-foot"><span><MapPin size={15}/> Apenas os dados definidos como públicos aparecem no diretório.</span><Button type="submit" disabled={busy||uploading}>{busy?'A guardar…':'Guardar e submeter'}</Button></div>
      </form>}</div>
    </div>
    <div className="future-work"><p className="eyebrow">PRÓXIMA ETAPA</p><h2>Serviços, disponibilidade e reservas</h2><p>Estes fluxos ainda não estão ativos. Os pedidos e estados persistidos serão implementados na próxima fase.</p></div>
  </section>;
}
