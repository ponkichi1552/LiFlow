import { useMemo } from 'react';
import { searchJapaneseMunicipalities } from './municipality-search';
import type { WeatherRegionCandidate } from './municipality-search';

export type MunicipalitySearchStatus = 'idle' | 'results' | 'empty';
export interface MunicipalitySuggestions {
  query: string;
  candidates: WeatherRegionCandidate[];
  status: MunicipalitySearchStatus;
  error: null;
}
/** The reviewed municipality index is bundled; suggestions never wait for HTTP. */
export function useMunicipalitySuggestions(query: string, enabled = true): MunicipalitySuggestions {
  const normalized = query.trim();
  return useMemo(() => {
    const candidates = enabled ? searchJapaneseMunicipalities(normalized) : [];
    return { query: normalized, candidates, status: !enabled || normalized.length < 2 ? 'idle' : candidates.length ? 'results' : 'empty', error: null };
  }, [enabled, normalized]);
}
