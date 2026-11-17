import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { type AvailabilitySummary } from '../lib/featuredProfessionals';
import { getProfessionalAvailabilitySummary as getAvailabilityBatch } from '../lib/publicAvailability';
import { supabase } from '../lib/supabase';
import { usePublicProfessionalSearch } from '../hooks/usePublicProfessionalSearch';
import { EMPTY_PROFESSIONAL_SEARCH, type ProfessionalSearchFilters } from '../lib/publicProfessionalSearch';
import { ProfessionalFilterBar } from '../search/ProfessionalFilterBar';
import { ProfessionalCard } from './ProfessionalCard';

const PAGE_SIZE = 10;

export function ProfessionalCarousel({ go }: { go: (path: string) => void }) {
  const [filters, setFilters] = useState<ProfessionalSearchFilters>(EMPTY_PROFESSIONAL_SEARCH);
  const [modalities, setModalities] = useState<{ slug: string; name: string }[]>([]);
  const [filterProblem, setFilterProblem] = useState(false);
  const [summaries, setSummaries] = useState<Map<string, AvailabilitySummary>>(new Map());
  const [availabilityProblem, setAvailabilityProblem] = useState(false);
  const search = usePublicProfessionalSearch(filters, { pageSize: PAGE_SIZE });
  const track = useRef<HTMLDivElement>(null);
  const availabilityRequest = useRef(0);
  const availabilityRequested = useRef(new Set<string>());
  const filterKey = JSON.stringify(filters);

  useEffect(() => {
    let live = true;
    if (!supabase) return;
    void supabase.from('modality_catalog').select('slug,name').eq('active', true).order('name').then(({ data, error }) => {
      if (!live) return;
      if (error) setFilterProblem(true);
      else setModalities(data ?? []);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    setSummaries(new Map());
    setAvailabilityProblem(false);
    availabilityRequested.current.clear();
    if (track.current) track.current.scrollLeft = 0;
  }, [filterKey]);

  useEffect(() => {
    const missingIds = search.profiles.map(profile => profile.id).filter(id => !availabilityRequested.current.has(id));
    if (!missingIds.length) return;
    missingIds.forEach(id => availabilityRequested.current.add(id));
    const requestId = ++availabilityRequest.current;
    let live = true;
    void getAvailabilityBatch(missingIds).then(result => {
      if (live && requestId === availabilityRequest.current) setSummaries(current => new Map([...current, ...result]));
    }).catch(() => {
      if (live && requestId === availabilityRequest.current) setAvailabilityProblem(true);
    });
    return () => { live = false; };
  }, [search.profiles, summaries]);

  const move = useCallback((direction: -1 | 1) => {
    const node = track.current;
    if (!node) return;
    const card = node.querySelector<HTMLElement>('.about-professional-card');
    const distance = card ? card.getBoundingClientRect().width + 18 : node.clientWidth * 0.8;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    node.scrollBy({ left: direction * distance, behavior: reduceMotion ? 'instant' : 'smooth' });
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
  };

  const handleScroll = () => {
    const node = track.current;
    if (node && node.scrollWidth - node.scrollLeft - node.clientWidth < 260 && search.hasMore && !search.loadingMore) {
      void search.loadMore();
    }
  };

  return <section className="about-community page-section" aria-labelledby="community-title">
    <div className="about-section-heading">
      <div><p className="eyebrow">A COMUNIDADE WELLWEB</p><h2 id="community-title">Encontre o próximo parceiro</h2><p>Conheça profissionais com perfil público na plataforma.</p></div>
      <div className="carousel-controls" aria-label="Navegação dos profissionais">
        <button type="button" onClick={() => move(-1)} aria-label="Ver profissionais anteriores"><ArrowLeft size={18}/></button>
        <button type="button" onClick={() => move(1)} aria-label="Ver profissionais seguintes"><ArrowRight size={18}/></button>
      </div>
    </div>
    <ProfessionalFilterBar filters={filters} modalities={modalities} onChange={setFilters} className="about-professional-filters"/>
    {filterProblem && <p className="about-filter-note" role="status">Não foi possível carregar as opções de modalidade. Os restantes filtros continuam disponíveis.</p>}
    {search.loading ? <div className="about-carousel-state" role="status"><span className="spinner"/>A carregar profissionais publicados…</div>
      : search.problem ? <p className="about-carousel-state" role="alert">{search.problem}</p>
      : search.profiles.length === 0 ? <div className="about-carousel-state">Não encontrámos profissionais com estes filtros.</div>
      : <>
        <div className="about-carousel-track" ref={track} tabIndex={0} onKeyDown={handleKeyDown} onScroll={handleScroll} role="region" aria-label="Carrossel de profissionais; usa as setas esquerda e direita para navegar">
          {search.profiles.map(profile => <ProfessionalCard key={profile.id} profile={profile} summary={summaries.get(profile.id)} onOpen={() => go(`/profissional/${profile.id}`)}/>)}
        </div>
        {search.loadingMore && <p className="about-carousel-state" role="status">A carregar mais profissionais…</p>}
        {search.hasMore && <button type="button" className="about-load-more" disabled={search.loadingMore} onClick={() => void search.loadMore()}>{search.loadingMore ? 'A carregar…' : 'Carregar mais profissionais'}</button>}
      </>}
    <p className="availability-disclaimer" role={availabilityProblem ? 'status' : undefined}>{availabilityProblem ? 'A disponibilidade está temporariamente indisponível.' : 'A disponibilidade é indicativa e pode mudar antes da confirmação de um pedido.'}</p>
  </section>;
}
