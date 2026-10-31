import { atom } from 'jotai';

import type { ModelFilters } from './modelPresentation';

/** Model search and filters, shared by the model list and family pages for this session. */
export const localModelFiltersAtom = atom<ModelFilters>({
  query: '',
  downloadedOnly: false,
  showLarger: false,
});
