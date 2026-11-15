import { useCallback, useEffect, useRef, useState } from 'react';
import {
  searchPublicProfessionalsPage,
  type ProfessionalSearchCursor,
  type ProfessionalSearchFilters,
  type PublicProfessionalResult,
} from '../lib/publicProfessionalSearch';

export function usePublicProfessionalSearch(
  filters: ProfessionalSearchFilters,
  options: { pageSize: number; enabled?: boolean },
) {
  const enabled = options.enabled ?? true;
  const filterKey = JSON.stringify([filters.search, filters.city, filters.modality, filters.language, filters.hasMaterial, filters.sort]);
  const version = useRef(0);
  const inFlightMore = useRef<number | null>(null);
  const [resultKey, setResultKey] = useState('');
  const [profiles, setProfiles] = useState<PublicProfessionalResult[]>([]);
  const [loadingState, setLoadingState] = useState(enabled);
  const [loadingMoreState, setLoadingMoreState] = useState(false);
  const [hasMoreState, setHasMoreState] = useState(false);
  const [problemState, setProblemState] = useState('');

  useEffect(() => {
    if (!enabled) { setLoadingState(false); return; }
    const requestVersion = ++version.current;
    let cancelled = false;
    const queryFilters = { ...filters };
    setResultKey('');
    setProfiles([]);
    setLoadingState(true);
    setLoadingMoreState(false);
    setHasMoreState(false);
    setProblemState('');

    const timer = window.setTimeout(() => {
      void searchPublicProfessionalsPage(queryFilters, options.pageSize).then((page) => {
        if (cancelled || version.current !== requestVersion) return;
        setProfiles(page.profiles);
        setHasMoreState(page.hasMore);
        setResultKey(filterKey);
        setLoadingState(false);
      }).catch(() => {
        if (cancelled || version.current !== requestVersion) return;
        setProblemState('Não foi possível pesquisar os profissionais. Tenta novamente.');
        setResultKey(filterKey);
        setLoadingState(false);
      });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (version.current === requestVersion) version.current++;
    };
  }, [enabled, filterKey, options.pageSize]);

  const loadMore = useCallback(async () => {
    const requestVersion = version.current;
    const last = profiles.at(-1);
    if (!enabled || resultKey !== filterKey || !hasMoreState || !last || inFlightMore.current === requestVersion) return;
    const cursor: ProfessionalSearchCursor = { id: last.id, published_at: last.published_at, guest_rating_average:last.guest_rating_average, guest_rating_count:last.guest_rating_count, guest_rating_bayesian:last.guest_rating_bayesian };
    const queryFilters = { ...filters };
    inFlightMore.current = requestVersion;
    setLoadingMoreState(true);
    setProblemState('');
    try {
      const page = await searchPublicProfessionalsPage(queryFilters, options.pageSize, cursor);
      if (version.current !== requestVersion) return;
      setProfiles(current => {
        const seen = new Set(current.map(profile => profile.id));
        return [...current, ...page.profiles.filter(profile => !seen.has(profile.id))];
      });
      setHasMoreState(page.hasMore);
    } catch {
      if (version.current === requestVersion) setProblemState('Não foi possível carregar mais profissionais. Tenta novamente.');
    } finally {
      if (inFlightMore.current === requestVersion) inFlightMore.current = null;
      if (version.current === requestVersion) setLoadingMoreState(false);
    }
  }, [enabled, filterKey, filters, hasMoreState, options.pageSize, profiles, resultKey]);

  const current = resultKey === filterKey;
  return {
    profiles: current ? profiles : [],
    loading: enabled && (!current || loadingState),
    loadingMore: current && loadingMoreState,
    hasMore: current && hasMoreState,
    problem: current ? problemState : '',
    loadMore,
  };
}
