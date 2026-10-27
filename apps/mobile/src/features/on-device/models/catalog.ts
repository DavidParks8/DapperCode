import catalog from './catalog.json';
import type { LocalModelDefinition } from './types';

export const LOCAL_MODEL_CATALOG: readonly LocalModelDefinition[] = catalog;

export function localModelDefinition(id: string): LocalModelDefinition {
  const model = LOCAL_MODEL_CATALOG.find((entry) => entry.id === id);
  if (!model) {
    throw new Error('This model is not in the on-device catalog.');
  }
  return model;
}
