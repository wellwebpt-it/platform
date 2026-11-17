import { useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';

export type TagOption = { value: string; label: string; flag?: string };

export function TagSelect({ label, options, value, onChange, hint }: {
  label: string;
  options: TagOption[];
  value: string[];
  onChange: (value: string[]) => void;
  hint?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => options.filter(option => value.includes(option.value)), [options, value]);
  const matches = useMemo(() => options.filter(option => !value.includes(option.value)
    && (!query.trim() || option.label.toLocaleLowerCase('pt-PT').includes(query.trim().toLocaleLowerCase('pt-PT')))), [options, query, value]);

  return <div className="tag-select">
    <label className="tag-select-label">{label}</label>
    <div className="tag-select-control" onClick={() => setOpen(true)}>
      {selected.map(option => <span className="selected-tag" key={option.value}>{option.flag&&<img className="language-flag" src={option.flag} alt=""/>}{option.label}<button type="button" aria-label={`Remover ${option.label}`} onClick={event => { event.stopPropagation(); onChange(value.filter(item => item !== option.value)); }}><X size={12}/></button></span>)}
      <div className="tag-select-search"><Search size={15}/><input value={query} onFocus={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }} placeholder={selected.length ? 'Adicionar…' : 'Pesquisar e selecionar…'} aria-label={`Pesquisar ${label.toLocaleLowerCase('pt-PT')}`}/></div>
    </div>
    {hint && <small className="tag-select-hint">{hint}</small>}
    {open && <><button type="button" className="tag-select-dismiss" aria-label="Fechar opções" onClick={() => setOpen(false)}/><div className="tag-select-options">{matches.length ? matches.map(option => <button type="button" key={option.value} onClick={() => { onChange([...value, option.value]); setQuery(''); }}><span className="tag-select-option-label">{option.flag&&<img className="language-flag" src={option.flag} alt=""/>}{option.label}</span><Check size={14}/></button>) : <p>Não há mais opções correspondentes.</p>}</div></>}
  </div>;
}
