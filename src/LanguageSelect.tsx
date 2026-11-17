import { useMemo, useState } from 'react';
import { Check, ChevronDown, Languages, Search } from 'lucide-react';
import { LANGUAGE_OPTIONS, languageLabel } from './lib/catalog';

export function LanguageBadges({ values, className = '' }: { values: string[]; className?: string }) {
  if (!values.length) return null;
  return <div className={`language-tags ${className}`} aria-label="Idiomas">
    {values.map(value => {
      const option = LANGUAGE_OPTIONS.find(language => language.value === value);
      return <span className="language-badge" key={value}>
        {option && <img className="language-flag" src={option.flag} alt=""/>}
        {languageLabel(value)}
      </span>;
    })}
  </div>;
}

export function LanguageFilter({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = LANGUAGE_OPTIONS.find(language => language.value === value);
  const options = useMemo(() => LANGUAGE_OPTIONS.filter(language => language.label
    .toLocaleLowerCase('pt-PT').includes(query.trim().toLocaleLowerCase('pt-PT'))), [query]);

  const choose = (nextValue: string) => {
    onChange(nextValue);
    setQuery('');
    setOpen(false);
  };

  return <div className="language-filter">
    <button type="button" className="language-filter-trigger" aria-label="Filtrar por idioma" aria-expanded={open} onClick={() => setOpen(current => !current)}>
      {selected ? <img className="language-flag" src={selected.flag} alt=""/> : <Languages size={17}/>}
      <span>{selected?.label ?? 'Todos os idiomas'}</span><ChevronDown size={14}/>
    </button>
    {open && <><button type="button" className="language-filter-dismiss" aria-label="Fechar seleção de idiomas" onClick={() => setOpen(false)}/><div className="language-filter-menu" role="listbox" aria-label="Selecionar idioma">
      <label className="language-filter-search"><Search size={14}/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Pesquisar idioma…" aria-label="Pesquisar idioma"/></label>
      <div className="language-filter-options">
        <button type="button" role="option" aria-selected={!value} onClick={() => choose('')}><span>Todos os idiomas</span>{!value && <Check size={14}/>}</button>
        {options.map(option => <button type="button" role="option" aria-selected={value === option.value} key={option.value} onClick={() => choose(option.value)}>
          <span className="language-option-label"><img className="language-flag" src={option.flag} alt=""/>{option.label}</span>
          {value === option.value && <Check size={14}/>}
        </button>)}
        {!options.length && <p>Não há idiomas correspondentes.</p>}
      </div>
    </div></>}
  </div>;
}
