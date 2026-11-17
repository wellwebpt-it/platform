import { supabase } from './supabase';

export type ProfessionalSearchFilters = {
  search: string;
  city: string;
  modality: string;
  language: string;
  hasMaterial: boolean;
  sort: 'RECENT' | 'BEST_RATED';
};

export const EMPTY_PROFESSIONAL_SEARCH: ProfessionalSearchFilters = {
  search: '', city: '', modality: '', language: '', hasMaterial: false, sort: 'RECENT',
};

export type PublicProfessionalResult = {
  id: string;
  public_name: string;
  city: string;
  service_area: string;
  description: string | null;
  services: string[];
  service_details: {
    id: string;
    name: string;
    description: string | null;
    modality_slug: string | null;
    duration_minutes: number | null;
    price: number | null;
    currency: string;
    has_material: boolean;
    allows_group: boolean;
    max_students: number | null;
    price_per_student: boolean;
  }[];
  modalities: string[];
  languages: string[];
  primary_photo_path: string | null;
  gallery_photo_paths: string[];
  published_at: string;
  guest_rating_average: number | null;
  guest_rating_count: number;
  hotel_rating_average: number | null;
  hotel_rating_count: number;
  guest_rating_bayesian: number | null;
};

export type ProfessionalSearchCursor = Pick<PublicProfessionalResult, 'id' | 'published_at' | 'guest_rating_average' | 'guest_rating_count' | 'guest_rating_bayesian'>;

export async function searchPublicProfessionalsPage(
  filters: ProfessionalSearchFilters,
  pageSize: number,
  cursor?: ProfessionalSearchCursor | null,
): Promise<{ profiles: PublicProfessionalResult[]; hasMore: boolean }> {
  if (!supabase) throw new Error('Supabase não está configurado.');
  const size = Math.min(30, Math.max(1, Math.trunc(pageSize) || 10));
  const { data, error } = await supabase.rpc('wellweb_search_public_professionals_ranked', {
    p_search: filters.search.trim() || null,
    p_city: filters.city.trim() || null,
    p_modality: filters.modality || null,
    p_language: filters.language || null,
    p_has_material: filters.hasMaterial,
    p_sort: filters.sort,
    p_cursor_published_at: cursor?.published_at ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_cursor_bayesian: cursor?.guest_rating_bayesian ?? null,
    p_cursor_guest_average: cursor?.guest_rating_average ?? null,
    p_cursor_guest_count: cursor?.guest_rating_count ?? null,
    p_page_size: size,
  });
  if (error) throw error;
  const rows = (data ?? []) as PublicProfessionalResult[];
  return { profiles: rows.slice(0, size), hasMore: rows.length > size };
}
