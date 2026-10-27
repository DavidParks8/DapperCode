import catalog from './catalog.json';
import type { LocalModelDefinition, LocalModelFamily } from './types';

export const LOCAL_MODEL_CATALOG: readonly LocalModelDefinition[] = catalog;

export const LOCAL_MODEL_FAMILIES: readonly LocalModelFamily[] = [
  {
    id: 'bonsai-2',
    name: 'Bonsai 2',
    publisher: 'Prism ML',
    icon: 'leaf-outline',
    description:
      'Compact ternary models with small downloads. Choose a size and packing on the next page.',
    quantizationNote:
      'These are different packings of the same ternary weights, not different precision levels. Q2_0 works in the bundled runtime; PQ2_0 and PTQ1_0 require PrismML-specific kernels.',
    badge: 'Compact',
    featured: true,
  },
  {
    id: 'qwen3.5',
    name: 'Qwen3.5',
    publisher: 'Qwen',
    icon: 'sparkles-outline',
    description:
      'Small hybrid-attention models for coding and tool use, with several precision choices.',
    badge: 'Recommended',
    featured: true,
  },
  {
    id: 'gemma-4',
    name: 'Gemma 4',
    publisher: 'Google',
    icon: 'diamond-outline',
    description:
      'Google Gemma models for text inference and coding tools. Vision and audio are not enabled here.',
    featured: true,
  },
  {
    id: 'qwen3',
    name: 'Qwen3',
    publisher: 'Qwen',
    icon: 'archive-outline',
    description:
      'The original tool-tested catalog. Existing downloads and conversations remain available.',
    featured: false,
  },
];

export function requireLocalModelRuntime(model: LocalModelDefinition): void {
  if (model.runtimeIssue) {
    throw new Error(model.runtimeIssue);
  }
}

export function localModelDefinition(id: string): LocalModelDefinition {
  const model = LOCAL_MODEL_CATALOG.find((entry) => entry.id === id);
  if (!model) {
    throw new Error('This model is not in the on-device catalog.');
  }
  return model;
}
