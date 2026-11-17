export const LANGUAGE_OPTIONS = [
  { value: 'pt', label: 'Português', flag: '/flags/pt.png' },
  { value: 'en', label: 'Inglês', flag: '/flags/en.png' },
  { value: 'es', label: 'Espanhol', flag: '/flags/es.png' },
  { value: 'fr', label: 'Francês', flag: '/flags/fr.png' },
  { value: 'it', label: 'Italiano', flag: '/flags/it.png' },
  { value: 'de', label: 'Alemão', flag: '/flags/de.png' },
] as const;

export function modalitySlug(name: string) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-PT')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function languageLabel(code: string) {
  return LANGUAGE_OPTIONS.find(language => language.value === code)?.label ?? code.toUpperCase();
}
