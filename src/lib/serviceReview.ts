export type ReviewService = {
  id: string; name: string; description?: string | null; modality_slug?: string | null;
  duration_minutes?: number | null; price?: number | null; currency?: string | null;
  active?: boolean; has_material?: boolean; allows_group?: boolean;
  max_students?: number | null; price_per_student?: boolean;
};

export type ServiceReviewField = { key: string; label: string; value: string };

export function serviceReviewFields(service: ReviewService, modalityNames: Map<string, string> = new Map()): ServiceReviewField[] {
  const price = service.price == null
    ? 'Preço a combinar'
    : new Intl.NumberFormat('pt-PT', { style: 'currency', currency: service.currency || 'EUR' }).format(service.price);
  return [
    { key: 'name', label: 'Nome', value: service.name || '—' },
    { key: 'description', label: 'Descrição', value: service.description?.trim() || 'Sem descrição' },
    { key: 'modality_slug', label: 'Categoria', value: (service.modality_slug && modalityNames.get(service.modality_slug)) || service.modality_slug || 'Sem categoria' },
    { key: 'duration_minutes', label: 'Duração', value: service.duration_minutes ? `${service.duration_minutes} min` : 'Não definida' },
    { key: 'price', label: 'Preço', value: price },
    { key: 'currency', label: 'Moeda', value: service.currency || 'EUR' },
    { key: 'active', label: 'Estado', value: service.active === false ? 'Inativo' : 'Ativo' },
    { key: 'has_material', label: 'Material', value: service.has_material ? 'Incluído' : 'Não incluído' },
    { key: 'allows_group', label: 'Aulas de grupo', value: service.allows_group ? 'Permitidas' : 'Não permitidas' },
    { key: 'max_students', label: 'Capacidade máxima', value: service.allows_group && service.max_students ? `${service.max_students} alunos` : '—' },
    { key: 'price_per_student', label: 'Modelo de preço', value: service.price_per_student ? 'Por aluno' : 'Por serviço' },
  ];
}

export function compareServiceReview(proposed: ReviewService, current?: ReviewService, modalityNames: Map<string, string> = new Map()) {
  const proposedFields = serviceReviewFields(proposed, modalityNames);
  const currentFields = current ? serviceReviewFields(current, modalityNames) : [];
  return proposedFields.map((field, index) => ({
    ...field,
    previous: currentFields[index]?.value ?? '—',
    changed: !current || currentFields[index]?.value !== field.value,
  }));
}
