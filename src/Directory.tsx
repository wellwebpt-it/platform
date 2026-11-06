import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Building2, MapPin, Search, Sparkles, UserRound } from 'lucide-react';
import { publicImageUrl } from './lib/media';
import { supabase } from './lib/supabase';
import { LanguageBadges, LanguageFilter } from './LanguageSelect';

type DirectoryMode = 'professionals' | 'hotels';
type Professional = {
  id: string; public_name: string; city: string; service_area: string;
  description: string; services: string[]; service_details: {id:string;name:string;description:string|null;modality_slug:string|null;duration_minutes:number|null;price:number|null;currency:string}[];
  modalities: string[]; languages: string[]; primary_photo_path: string | null; gallery_photo_paths: string[];
};
type Hotel = {
  id: string; name: string; city: string; country_code: string; description: string;
  public_contact_email: string | null; public_phone: string | null; website_url: string | null;
  primary_photo_path: string | null; gallery_photo_paths: string[];
};
type DirectoryProps = { mode: DirectoryMode; go: (path: string) => void; detailId?: string; account?: {account_type:'HOTEL'|'PROFESSIONAL'|'ADMIN';status:string}|null };

export function Directory({ mode, go, detailId, account }: DirectoryProps) {
  const isProfessional = mode === 'professionals';
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [search, setSearch] = useState('');
  const [city, setCity] = useState('');
  const [service, setService] = useState('');
  const [language, setLanguage] = useState('');
  const [modalityOptions, setModalityOptions] = useState<{slug:string;name:string}[]>([]);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setProblem('');
    if (!supabase) {
      setLoading(false);
      setProblem('Liga o Supabase local para consultar os perfis publicados.');
      return () => { live = false; };
    }
    void (async () => {
      const { data: catalog } = await supabase.from('modality_catalog').select('slug,name').eq('active', true).order('name');
      if (live && catalog) setModalityOptions(catalog);
      if (isProfessional) {
        const { data, error } = await supabase.from('public_professional_directory')
          .select('id,public_name,city,service_area,description,services,service_details,modalities,languages,primary_photo_path,gallery_photo_paths').limit(100);
        if (error) { if (live) setProblem('Não foi possível carregar o diretório. Confirma que a migration do diretório foi aplicada localmente.'); }
        else if (live) setProfessionals((data ?? []) as Professional[]);
      } else {
        const { data, error } = await supabase.from('public_hotel_directory')
          .select('id,name,city,country_code,description,public_contact_email,public_phone,website_url,primary_photo_path,gallery_photo_paths')
          .limit(100);
        if (error) { if (live) setProblem('Não foi possível carregar o diretório. Confirma que a migration do diretório foi aplicada localmente.'); }
        else if (live) setHotels((data ?? []) as Hotel[]);
      }
      if (live) setLoading(false);
    })();
    return () => { live = false; };
  }, [isProfessional]);

  const filteredProfessionals = useMemo(() => professionals.filter((profile) => {
    const text = `${profile.public_name} ${profile.service_area} ${profile.description} ${profile.modalities.join(' ')}`.toLocaleLowerCase('pt-PT');
    return (!search || text.includes(search.toLocaleLowerCase('pt-PT')))
      && (!city || profile.city.toLocaleLowerCase('pt-PT').includes(city.toLocaleLowerCase('pt-PT')))
      && (!service || profile.modalities.includes(service))
      && (!language || profile.languages.includes(language));
  }), [city, language, professionals, search, service]);
  const filteredHotels = useMemo(() => hotels.filter((hotel) => {
    const text = `${hotel.name} ${hotel.city} ${hotel.description}`.toLocaleLowerCase('pt-PT');
    return (!search || text.includes(search.toLocaleLowerCase('pt-PT')))
      && (!city || hotel.city.toLocaleLowerCase('pt-PT').includes(city.toLocaleLowerCase('pt-PT')));
  }), [city, hotels, search]);

  const title = isProfessional ? 'Profissionais' : 'Hotéis e alojamentos';
  const records = isProfessional ? filteredProfessionals : filteredHotels;
  const selectedProfessional = isProfessional ? professionals.find((item) => item.id === detailId) : undefined;
  const selectedHotel = !isProfessional ? hotels.find((item) => item.id === detailId) : undefined;
  if (detailId) {
    if (loading) return <div className="directory-state"><div className="spinner"/><p>A carregar perfil…</p></div>;
    if (!selectedProfessional && !selectedHotel) return <div className="directory-state"><p>Este perfil não está publicado ou já não está disponível.</p><button className="secondary-button" onClick={() => go(isProfessional ? '/profissionais' : '/hoteis')}>Voltar ao diretório <ArrowRight size={16}/></button></div>;
    return <ProfileDetail professional={selectedProfessional} hotel={selectedHotel} go={go} account={account} />;
  }

  return <section className="directory-page">
    <div className="directory-heading"><p className="eyebrow">DESCOBRE A COMUNIDADE WELLWEB</p><h1>{title}<em> com propósito.</em></h1><p>Encontra pessoas e lugares que tornam cada estadia mais especial.</p></div>
    <div className="directory-search" role="search"><label><Search size={18}/><span className="sr-only">Pesquisar</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={isProfessional ? 'Nome, modalidade ou experiência' : 'Nome do alojamento ou localidade'}/></label><label><MapPin size={18}/><span className="sr-only">Localidade</span><input value={city} onChange={(event) => setCity(event.target.value)} placeholder="Localidade"/></label>{isProfessional && <><label><Sparkles size={17}/><span className="sr-only">Modalidade</span><select value={service} onChange={event => setService(event.target.value)} aria-label="Filtrar por modalidade"><option value="">Todas as modalidades</option>{modalityOptions.map(item => <option value={item.name} key={item.slug}>{item.name}</option>)}</select></label><LanguageFilter value={language} onChange={setLanguage}/></>}</div>
    <div className="directory-meta"><span>{loading ? 'A procurar perfis…' : `${records.length} ${records.length === 1 ? 'perfil encontrado' : 'perfis encontrados'}`}</span><button className="directory-switch" onClick={() => go(isProfessional ? '/hoteis' : '/profissionais')}>Ver {isProfessional ? 'alojamentos' : 'profissionais'} <ArrowRight size={15}/></button></div>
    {problem && <div className="inline-alert">{problem}</div>}
    {loading ? <div className="directory-state"><div className="spinner"/><p>A preparar a seleção…</p></div> : records.length ? <div className="directory-grid">{isProfessional
      ? filteredProfessionals.map((profile) => <ProfessionalCard key={profile.id} profile={profile} name={profile.public_name} onOpen={() => go(`/profissional/${profile.id}`)} onRequest={account?.account_type==='HOTEL'&&account.status==='ACTIVE'?()=>go(`/reservar/${profile.id}`):undefined}/> )
      : filteredHotels.map((hotel) => <HotelCard key={hotel.id} hotel={hotel} onOpen={() => go(`/hotel/${hotel.id}`)}/> )}</div>
      : !problem && <div className="directory-empty"><div className="empty-emblem">{isProfessional ? <UserRound/> : <Building2/>}</div><p className="eyebrow">PRIMEIROS A CHEGAR</p><h2>Este diretório está a começar.</h2><p>Ainda não há perfis publicados{search || city || service ? ' com estes filtros' : ''}. Se fazes parte desta comunidade, podes ser dos primeiros a aparecer.</p><button className="primary-button" onClick={() => go(isProfessional ? '/registar/profissional' : '/registar/hotel')}>Criar perfil {isProfessional ? 'profissional' : 'de alojamento'} <ArrowRight size={16}/></button></div>}
  </section>;
}

function ProfessionalCard({ profile, name, onOpen, onRequest }: { profile: Professional; name: string; onOpen: () => void; onRequest?: () => void }) {
  const photo = publicImageUrl(profile.primary_photo_path);
  return <article className="directory-card"><button className="card-photo" onClick={onOpen} aria-label={`Ver perfil de ${name}`}>{photo ? <img src={photo} alt="" loading="lazy"/> : <div className="photo-placeholder"><UserRound/></div>}<span className="card-kind">Profissional</span></button><div className="directory-card-copy"><div className="card-location"><MapPin size={14}/>{profile.city}</div><h2>{name}</h2><p>{profile.service_area}</p><div className="service-tags">{profile.modalities.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div>{profile.services.length>0&&<p className="offer-list">{profile.services.slice(0,2).join(' · ')}</p>}<LanguageBadges values={profile.languages}/><button className="card-link" onClick={onOpen}>Conhecer perfil <ArrowRight size={16}/></button>{onRequest&&<button className="request-card-button" onClick={onRequest}>Solicitar reserva <ArrowRight size={15}/></button>}</div></article>;
}

function HotelCard({ hotel, onOpen }: { hotel: Hotel; onOpen: () => void }) {
  const photo = publicImageUrl(hotel.primary_photo_path);
  return <article className="directory-card"><button className="card-photo" onClick={onOpen} aria-label={`Ver perfil de ${hotel.name}`}>{photo ? <img src={photo} alt="" loading="lazy"/> : <div className="photo-placeholder"><Building2/></div>}<span className="card-kind">Alojamento</span></button><div className="directory-card-copy"><div className="card-location"><MapPin size={14}/>{hotel.city} · {hotel.country_code}</div><h2>{hotel.name}</h2><p>{hotel.description || 'Um lugar para viver experiências locais com tempo e tranquilidade.'}</p><button className="card-link" onClick={onOpen}>Conhecer alojamento <ArrowRight size={16}/></button></div></article>;
}

function ProfileDetail({ professional, hotel, go, account }: { professional?: Professional; hotel?: Hotel; go: (path: string) => void; account?: DirectoryProps['account'] }) {
  const name = professional ? professional.public_name : hotel?.name ?? '';
  const photoPaths = [professional?.primary_photo_path ?? hotel?.primary_photo_path, ...(professional?.gallery_photo_paths ?? hotel?.gallery_photo_paths ?? [])].filter((item): item is string => Boolean(item));
  const photos = photoPaths.map((path) => publicImageUrl(path)).filter((item): item is string => Boolean(item));
  const location = professional ? `${professional.city} · ${professional.service_area}` : `${hotel?.city ?? ''} · ${hotel?.country_code ?? ''}`;
  const description = professional?.description ?? hotel?.description ?? '';
  return <article className="profile-detail"><button className="back-link" onClick={() => go(professional ? '/profissionais' : '/hoteis')}><ArrowRight className="back-arrow" size={16}/> Voltar ao diretório</button><div className="profile-detail-head"><div className="profile-detail-copy"><p className="eyebrow">{professional ? 'PERFIL PROFISSIONAL' : 'ALOJAMENTO WELLWEB'}</p><h1>{name}</h1><p className="detail-location"><MapPin size={17}/>{location}</p><p className="detail-description">{description || 'Mais informação sobre este perfil será partilhada em breve.'}</p>{professional && <><div className="service-tags detail-tags">{professional.modalities.map((item) => <span key={item}>{item}</span>)}</div><LanguageBadges values={professional.languages} className="detail-languages"/>{professional.service_details?.length>0&&<div className="public-service-list"><h2>Serviços disponíveis</h2>{professional.service_details.map(item=><article key={item.id}><div><strong>{item.name}</strong>{item.description&&<p>{item.description}</p>}<small>{item.duration_minutes??'Duração a combinar'} min</small></div><span>{item.price===null?'Preço a combinar':new Intl.NumberFormat('pt-PT',{style:'currency',currency:item.currency||'EUR'}).format(item.price)}</span></article>)}</div>}{account?.account_type==='HOTEL'&&account.status==='ACTIVE'?<button className="primary-button booking-cta" onClick={()=>go(`/reservar/${professional.id}`)}>Solicitar reserva <ArrowRight size={16}/></button>:!account&&<div className="booking-cta-note"><p>Apenas hotéis autenticados e aprovados podem solicitar reservas.</p><button className="secondary-button" onClick={()=>go('/entrar')}>Iniciar sessão</button></div>}</>}{hotel && <div className="detail-contact">{hotel.public_contact_email && <a href={`mailto:${hotel.public_contact_email}`}>{hotel.public_contact_email}</a>}{hotel.public_phone && <a href={`tel:${hotel.public_phone}`}>{hotel.public_phone}</a>}{hotel.website_url && <a href={hotel.website_url} target="_blank" rel="noreferrer">Visitar website <ArrowRight size={15}/></a>}</div>}</div><div className="detail-cover">{photos[0] ? <img src={photos[0]} alt={`Fotografia de ${name}`}/> : <div className="photo-placeholder"><Building2/></div>}</div></div>{photos.length > 1 && <div className="detail-gallery">{photos.slice(1).map((photo, index) => <img key={`${photo}-${index}`} src={photo} alt={`Fotografia ${index + 2} de ${name}`} loading="lazy"/>)}</div>}</article>;
}
