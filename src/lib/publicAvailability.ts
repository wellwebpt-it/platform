import { supabase } from './supabase';
import { getProfessionalAvailabilitySummary as getSummaryBatch, type AvailabilitySummary } from './featuredProfessionals';

async function callAvailabilityRpc(profileIds: string[]) {
  if (!supabase) throw new Error('Supabase não está configurado.');
  const { data, error } = await supabase.rpc('wellweb_public_professional_availability', { p_profile_ids: profileIds });
  return { data: data as AvailabilitySummary[] | null, error };
}

/** One aggregate, public-safe RPC call for a batch of at most 50 visible profiles. */
export async function getProfessionalAvailabilitySummary(
  profileIds: readonly string[],
): Promise<Map<string, AvailabilitySummary>> {
  return getSummaryBatch(profileIds, callAvailabilityRpc);
}
