import { screenAtom } from './registry';

/**
 * Which tool invocation rows are expanded, keyed by tool call id. It cannot live
 * in the row component: `FlatList` unmounts rows that scroll out of view, so
 * component state would silently collapse them again.
 */
export const expandedToolInvocationIdsAtom = screenAtom<Record<string, boolean>>(
  (): Record<string, boolean> => ({}),
);
