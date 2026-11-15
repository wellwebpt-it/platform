import { MapPin, Search, Sparkles } from 'lucide-react';
import { LanguageFilter } from '../LanguageSelect';
import type { ProfessionalSearchFilters } from '../lib/publicProfessionalSearch';

export function ProfessionalFilterBar({
  filters,
  modalities,
  onChange,
  className = '',
}: {
  filters: ProfessionalSearchFilters;
  modalities: { slug: string; name: string }[];
  onChange: (filters: ProfessionalSearchFilters) => void;
  className?: string;
}) {
  const update = (field: keyof ProfessionalSearchFilters, value: string | boolean) => onChange({ ...filters, [field]: value });
  return <div className={`directory-search ${className}`} role="search">
    <label><Search size={18}/><span className="sr-only">Pesquisar</span><input value={filters.search} onChange={event => update('search', event.target.value)} placeholder="Modalidade, nome ou palavra-chave…"/></label>
    <label><MapPin size={18}/><span className="sr-only">Localidade</span><input value={filters.city} onChange={event => update('city', event.target.value)} placeholder="Toda a região"/></label>
    <label><Sparkles size={17}/><span className="sr-only">Modalidade</span><select value={filters.modality} onChange={event => update('modality', event.target.value)} aria-label="Filtrar por modalidade"><option value="">Todas as modalidades</option>{modalities.map(item => <option value={item.name} key={item.slug}>{item.name}</option>)}</select></label>
    <label className="material-filter"><input type="checkbox" checked={filters.hasMaterial} onChange={event => update('hasMaterial', event.target.checked)}/>Com material disponível</label>
    <label><span className="sr-only">Ordenar profissionais</span><select value={filters.sort} onChange={event => update('sort', event.target.value)} aria-label="Ordenar profissionais"><option value="RECENT">Mais recentes</option><option value="BEST_RATED">Melhor avaliados</option></select></label>
    <LanguageFilter value={filters.language} onChange={value => update('language', value)}/>
  </div>;
}
