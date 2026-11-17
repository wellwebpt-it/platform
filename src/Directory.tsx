import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Building2, MapPin, Search, Sparkles, UserRound } from 'lucide-react';
import { publicImageUrl } from './lib/media';
import { supabase } from './lib/supabase';
import { LanguageBadges } from './LanguageSelect';
import { ProfessionalFilterBar } from './search/ProfessionalFilterBar';
import { EMPTY_PROFESSIONAL_SEARCH, type PublicProfessionalResult } from './lib/publicProfessionalSearch';
import { usePublicProfessionalSearch } from './hooks/usePublicProfessionalSearch';
import { ProfessionalReviews, ReviewRatingSummary } from './Reviews';

type DirectoryMode = 'professionals' | 'hotels';
type Professional = PublicProfessionalResult;
type Hotel = {
  id: string; name: string; city: string; country_code: string; description: string;
  public_contact_email: string | null; public_phone: string | null; website_url: string | null;
  primary_photo_path: string | null; gallery_photo_paths: string[];
};
type DirectoryProps = { mode: DirectoryMode; go: (path: string) => void; detailId?: string; account?: {account_type:'HOTEL'|'PROFESSIONAL'|'ADMIN';status:string}|null };

function publicWebsiteUrl(value: string | null) {
  if (!value) return null;
  try { const parsed = new URL(value); return ['https:','http:'].includes(parsed.protocol) ? parsed.href : null; }
  catch { return null; }
}

export function Directory({ mode, go, detailId, account }: DirectoryProps) {
  const isProfessional = mode === 'professionals';
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [filters, setFilters] = useState(EMPTY_PROFESSIONAL_SEARCH);
  const [hotelSearch, setHotelSearch] = useState('');
  const [hotelCity, setHotelCity] = useState('');
  const [modalityOptions, setModalityOptions] = useState<{slug:string;name:string}[]>([]);
  const [professionalDetail, setProfessionalDetail] = useState<Professional | undefined>();
  const [selectedHotel, setSelectedHotel] = useState<Hotel | undefined>();
  const [pageLoading, setPageLoading] = useState(true);
  const [pageProblem, setPageProblem] = useState('');
  const professionalSearch = usePublicProfessionalSearch(filters, { pageSize: 24, enabled: isProfessional && !detailId });

  useEffect(() => {
    let live = true;
    async function loadPageData() {
      setPageLoading(true);
      setPageProblem('');
      setProfessionalDetail(undefined);
      setSelectedHotel(undefined);
      if (!supabase) {
        if (live) { setPageProblem('Liga o Supabase local para consultar os perfis publicados.'); setPageLoading(false); }
        return;
      }
      const { data: catalog } = await supabase.from('modality_catalog').select('slug,name').eq('active', true).order('name');
      if (live && catalog) setModalityOptions(catalog);

      if (isProfessional && detailId) {
        const { data, error } = await supabase.from('public_professional_directory')
          .select('id,public_name,city,service_area,description,services,service_details,modalities,languages,primary_photo_path,gallery_photo_paths,published_at,guest_rating_average,guest_rating_count,hotel_rating_average,hotel_rating_count,guest_rating_bayesian')
          .eq('id', detailId).maybeSingle();
        if (!live) return;
        if (error) setPageProblem('Não foi possível carregar este perfil profissional.');
        else setProfessionalDetail((data ?? undefined) as Professional | undefined);
        setPageLoading(false);
        return;
      }

      if (!isProfessional) {
        const { data, error } = await supabase.from('public_hotel_directory')
          .select('id,name,city,country_code,description,public_contact_email,public_phone,website_url,primary_photo_path,gallery_photo_paths')
          .limit(100);
        if (!live) return;
        if (error) setPageProblem('Não foi possível carregar o diretório de alojamentos.');
        else {
          const items = (data ?? []) as Hotel[];
          setHotels(items);
          if (detailId) setSelectedHotel(items.find(item => item.id === detailId));
        }
      }
      if (live) setPageLoading(false);
    }
    void loadPageData();
    return () => { live = false; };
  }, [detailId, isProfessional]);

  const filteredHotels = useMemo(() => hotels.filter((hotel) => {
    const text = `${hotel.name} ${hotel.city} ${hotel.description}`.toLocaleLowerCase('pt-PT');
    return (!hotelSearch || text.includes(hotelSearch.toLocaleLowerCase('pt-PT')))
      && (!hotelCity || hotel.city.toLocaleLowerCase('pt-PT').includes(hotelCity.toLocaleLowerCase('pt-PT')));
  }), [hotelCity, hotelSearch, hotels]);

  const loading = isProfessional && !detailId ? professionalSearch.loading : pageLoading;
  const problem = isProfessional && !detailId ? professionalSearch.problem : pageProblem;
  const professionals = isProfessional && detailId ? (professionalDetail ? [professionalDetail] : []) : professionalSearch.profiles;
  const records = isProfessional ? professionals : filteredHotels;
  const selectedProfessional = isProfessional ? professionalDetail : undefined;
  if (detailId) {
    if (loading) return <div className="directory-state"><div className="spinner"/><p>A carregar perfil…</p></div>;
    if (problem || (!selectedProfessional && !selectedHotel)) return <div className="directory-state"><p>{problem || 'Este perfil não está publicado ou já não está disponível.'}</p><button className="secondary-button" onClick={() => go(isProfessional ? '/profissionais' : '/hoteis')}>Voltar ao diretório <ArrowRight size={16}/></button></div>;
    return <ProfileDetail professional={selectedProfessional} hotel={selectedHotel} go={go} account={account} />;
  }

  return <section className="directory-page">
    <div className="directory-heading"><p className="eyebrow">DESCOBRE A COMUNIDADE WELLWEB</p><h1>{isProfessional ? 'Profissionais' : 'Hotéis e alojamentos'}<em> com propósito.</em></h1><p>Encontra pessoas e lugares que tornam cada estadia mais especial.</p></div>
    {isProfessional
      ? <ProfessionalFilterBar filters={filters} modalities={modalityOptions} onChange={setFilters}/>
      : <div className="directory-search" role="search"><label><Search size={18}/><span className="sr-only">Pesquisar</span><input value={hotelSearch} onChange={(event) => setHotelSearch(event.target.value)} placeholder="Nome do alojamento ou localidade"/></label><label><MapPin size={18}/><span className="sr-only">Localidade</span><input value={hotelCity} onChange={(event) => setHotelCity(event.target.value)} placeholder="Localidade"/></label></div>}
    <div className="directory-meta"><span>{loading ? 'A procurar perfis…' : `${records.length}${isProfessional && professionalSearch.hasMore ? '+' : ''} ${records.length === 1 ? 'perfil encontrado' : 'perfis encontrados'}`}</span><button className="directory-switch" onClick={() => go(isProfessional ? '/hoteis' : '/profissionais')}>Ver {isProfessional ? 'alojamentos' : 'profissionais'} <ArrowRight size={15}/></button></div>
    {problem && <div className="inline-alert" role="alert">{problem}</div>}
    {loading ? <div className="directory-state"><div className="spinner"/><p>A preparar a seleção…</p></div> : records.length ? <>
      <div className="directory-grid">{isProfessional
        ? professionals.map((profile) => <ProfessionalCard key={profile.id} profile={profile} name={profile.public_name} onOpen={() => go(`/profissional/${profile.id}`)} onRequest={account?.account_type==='HOTEL'&&account.status==='ACTIVE'?()=>go(`/reservar/${profile.id}`):undefined}/> )
        : filteredHotels.map((hotel) => <HotelCard key={hotel.id} hotel={hotel} onOpen={() => go(`/hotel/${hotel.id}`)}/> )}</div>
      {isProfessional && professionalSearch.hasMore && <button type="button" className="secondary-button directory-load-more" disabled={professionalSearch.loadingMore} onClick={() => void professionalSearch.loadMore()}>{professionalSearch.loadingMore ? 'A carregar…' : 'Carregar mais profissionais'}</button>}
    </> : !problem && <div className="directory-empty"><div className="empty-emblem">{isProfessional ? <UserRound/> : <Building2/>}</div><p className="eyebrow">PRIMEIROS A CHEGAR</p><h2>{isProfessional && Object.values(filters).some(Boolean) || !isProfessional && (hotelSearch || hotelCity) ? 'Não encontrámos resultados.' : 'Este diretório está a começar.'}</h2><p>{isProfessional && Object.values(filters).some(Boolean) || !isProfessional && (hotelSearch || hotelCity) ? 'Experimenta ajustar os filtros.' : 'Ainda não há perfis publicados. Se fazes parte desta comunidade, podes ser dos primeiros a aparecer.'}</p>{!(isProfessional && Object.values(filters).some(Boolean) || !isProfessional && (hotelSearch || hotelCity)) && <button className="primary-button" onClick={() => go(isProfessional ? '/registar/profissional' : '/registar/hotel')}>Criar perfil {isProfessional ? 'profissional' : 'de alojamento'} <ArrowRight size={16}/></button>}</div>}
  </section>;
}

function ProfessionalCard({ profile, name, onOpen, onRequest }: { profile: Professional; name: string; onOpen: () => void; onRequest?: () => void }) {
  const photo = publicImageUrl(profile.primary_photo_path);
  return <article className="directory-card"><button className="card-photo" onClick={onOpen} aria-label={`Ver perfil de ${name}`}>{photo ? <img src={photo} alt="" loading="lazy"/> : <div className="photo-placeholder"><UserRound/></div>}<span className="card-kind">Profissional</span></button><div className="directory-card-copy"><div className="card-location"><MapPin size={14}/>{profile.city}</div><h2>{name}</h2><ReviewRatingSummary summary={profile}/><p>{profile.service_area}</p><div className="service-tags">{profile.modalities.slice(0, 3).map((item) => <span key={item}>{item}</span>)}</div>{profile.services.length>0&&<p className="offer-list">{profile.services.slice(0,2).join(' · ')}</p>}<LanguageBadges values={profile.languages}/><button className="card-link" onClick={onOpen}>Conhecer perfil <ArrowRight size={16}/></button>{onRequest&&<button className="request-card-button" onClick={onRequest}>Solicitar reserva <ArrowRight size={15}/></button>}</div></article>;
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
  const website = hotel ? publicWebsiteUrl(hotel.website_url) : null;
  return <article className="profile-detail"><button className="back-link" onClick={() => go(professional ? '/profissionais' : '/hoteis')}><ArrowRight className="back-arrow" size={16}/> Voltar ao diretório</button><div className="profile-detail-head"><div className="profile-detail-copy"><p className="eyebrow">{professional ? 'PERFIL PROFISSIONAL' : 'ALOJAMENTO WELLWEB'}</p><h1>{name}</h1><p className="detail-location"><MapPin size={17}/>{location}</p><p className="detail-description">{description || 'Mais informação sobre este perfil será partilhada em breve.'}</p>{professional && <><ReviewRatingSummary summary={professional}/><div className="service-tags detail-tags">{professional.modalities.map((item) => <span key={item}>{item}</span>)}</div><LanguageBadges values={professional.languages} className="detail-languages"/>{professional.service_details?.length>0&&<div className="public-service-list"><h2>Serviços disponíveis</h2>{professional.service_details.map(item=><article className="public-service-item" key={item.id}><header><h3>{item.name}</h3>{item.modality_slug&&<span>{item.modality_slug}</span>}</header>{item.description&&<p className="public-service-description">{item.description}</p>}<div className="public-service-meta"><div><span>Preço</span><strong>{item.price===null?'Preço a combinar':new Intl.NumberFormat('pt-PT',{style:'currency',currency:item.currency||'EUR'}).format(item.price)}{item.allows_group&&item.price_per_student?' · por aluno':' · por serviço'}</strong></div><div><span>Duração</span><strong>{item.duration_minutes?`${item.duration_minutes} min`:'A combinar'}</strong></div>{item.has_material?<div><span>Material</span><strong>Disponível</strong></div>:<span className="service-meta-placeholder" aria-hidden="true"/>}{item.allows_group?<div><span>Formato</span><strong>Aula de grupo · até {item.max_students} alunos</strong></div>:<span className="service-meta-placeholder" aria-hidden="true"/>}</div></article>)}</div>}{account?.account_type==='HOTEL'&&account.status==='ACTIVE'?<button className="primary-button booking-cta" onClick={()=>go(`/reservar/${professional.id}`)}>Solicitar reserva <ArrowRight size={16}/></button>:!account&&<div className="booking-cta-note"><p>Apenas hotéis autenticados e aprovados podem solicitar reservas.</p><button className="secondary-button" onClick={()=>go('/entrar')}>Iniciar sessão</button></div>}</>}{hotel && <div className="detail-contact">{hotel.public_contact_email && <a href={`mailto:${hotel.public_contact_email}`}>{hotel.public_contact_email}</a>}{hotel.public_phone && <a href={`tel:${hotel.public_phone}`}>{hotel.public_phone}</a>}{website && <a href={website} target="_blank" rel="noopener noreferrer">Visitar website <ArrowRight size={15}/></a>}</div>}</div><div className="detail-cover">{photos[0] ? <img src={photos[0]} alt={`Fotografia de ${name}`}/> : <div className="photo-placeholder"><Building2/></div>}</div></div>{photos.length > 1 && <div className="detail-gallery">{photos.slice(1).map((photo, index) => <img key={`${photo}-${index}`} src={photo} alt={`Fotografia ${index + 2} de ${name}`} loading="lazy"/>)}</div>}{professional&&<ProfessionalReviews profileId={professional.id} summary={professional} account={account}/>}</article>;
}
