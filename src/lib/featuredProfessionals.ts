export type PublicationCandidate = {
  id: string;
  published_at: string | null;
  is_public?: boolean;
  approval_status?: string;
  account_status?: string;
};

export type AvailabilitySummaryCode = 'AVAILABLE_THIS_WEEK' | 'NEXT_SLOT' | 'NONE_NEXT_7_DAYS' | 'NO_ACTIVE_SERVICE';
export type AvailabilitySummary = { professional_profile_id: string; summary_code: AvailabilitySummaryCode; days_until: number | null };
export type PublicServicePrice = {
  price: number | null;
  currency: string | null;
  allows_group: boolean;
  price_per_student: boolean;
};
export type AvailabilityRpc = (profileIds: string[]) => Promise<{ data: AvailabilitySummary[] | null; error: unknown | null }>;
export type FeaturedSelectionPolicy<T> = {
  limit?: number;
  include?: (profile: T) => boolean;
  compare?: (a: T, b: T) => number;
};

/**
 * The public directory view already enforces these conditions in PostgreSQL.
 * Keeping the selection guard here makes the component safe with mocked data
 * and reusable when public search is rebuilt.
 */
export function selectFeaturedProfessionals<T extends PublicationCandidate>(
  profiles: readonly T[],
  policy: FeaturedSelectionPolicy<T> = {},
): T[] {
  const { limit = 30, include = () => true, compare } = policy;
  return profiles
    .filter((profile) => Boolean(profile.published_at) && Number.isFinite(Date.parse(profile.published_at!))
      && (profile.is_public === undefined || profile.is_public)
      && (profile.approval_status === undefined || profile.approval_status === 'APPROVED')
      && (profile.account_status === undefined || profile.account_status === 'ACTIVE')
      && include(profile))
    .slice()
    .sort((a, b) => {
      if (compare) return compare(a, b) || a.id.localeCompare(b.id);
      const publishedOrder = Date.parse(b.published_at!) - Date.parse(a.published_at!);
      return publishedOrder || a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, limit));
}

export function formatAvailabilitySummary(summary: AvailabilitySummary | undefined): string | null {
  if (!summary) return null;
  switch (summary.summary_code) {
    case 'AVAILABLE_THIS_WEEK': return 'Disponível esta semana';
    case 'NEXT_SLOT':
      if (!Number.isInteger(summary.days_until) || summary.days_until! < 1) return null;
      return summary.days_until === 1 ? 'Próxima vaga amanhã' : `Próxima vaga em ${summary.days_until} dias`;
    case 'NONE_NEXT_7_DAYS': return 'Sem disponibilidade nos próximos 7 dias';
    case 'NO_ACTIVE_SERVICE': return null;
    default: return null;
  }
}

/**
 * Show a starting price only when the public values are genuinely comparable.
 * Per-person group rates are kept separate from per-service prices and currencies.
 */
export function formatStartingServicePrice(services: readonly PublicServicePrice[]): string | null {
  const priced = services.filter((service) => service.price !== null
    && Number.isFinite(service.price) && service.price >= 0
    && typeof service.currency === 'string' && /^[A-Z]{3}$/.test(service.currency));
  if (!priced.length) return null;

  const currencies = new Set(priced.map((service) => service.currency!));
  const bases = new Set(priced.map((service) => service.allows_group && service.price_per_student ? 'PERSON' : 'SERVICE'));
  if (currencies.size !== 1 || bases.size !== 1) return null;

  const currency = priced[0].currency!;
  try {
    const amount = new Intl.NumberFormat('pt-PT', { style: 'currency', currency }).format(Math.min(...priced.map((service) => service.price!)));
    return `Serviços a partir de ${amount}${bases.has('PERSON') ? ' / pessoa' : ''}`;
  } catch {
    return null;
  }
}

/** Submit one deduplicated batch and keep transport errors distinct from no availability. */
export async function getProfessionalAvailabilitySummary(
  profileIds: readonly string[],
  call: AvailabilityRpc,
): Promise<Map<string, AvailabilitySummary>> {
  const uniqueIds = [...new Set(profileIds)];
  if (!uniqueIds.length) return new Map();
  if (uniqueIds.length > 50) throw new Error('A consulta de disponibilidade admite no máximo 50 perfis.');
  const { data, error } = await call(uniqueIds);
  if (error) throw error;
  return new Map((data ?? []).map((summary) => [summary.professional_profile_id, summary]));
}

export function localLisbonWeekday(value: string | Date): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Lisbon', weekday: 'short' }).format(new Date(value));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}
