import catalog from './catalog.json';
import type { LocalModelDefinition, LocalModelFamily } from './types';

export const LOCAL_MODEL_CATALOG: readonly LocalModelDefinition[] = catalog;

export const LOCAL_MODEL_FAMILIES: readonly LocalModelFamily[] = [
  {
    id: 'lfm3',
    name: 'LFM3',
    publisher: 'Liquid AI',
    icon: 'sparkles-outline',
    description:
      'Liquid AI text models that reason before answering, so replies are slower. Review coding edits; LFM Open License v1.0 terms apply.',
    badge: 'Experimental',
    featured: true,
  },
  {
    id: 'bonsai-2',
    name: 'Bonsai 2',
    publisher: 'Prism ML',
    icon: 'leaf-outline',
    description: 'Compact ternary models with small downloads and memory use.',
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

export function findLocalModelDefinition(id: string): LocalModelDefinition | null {
  return LOCAL_MODEL_CATALOG.find((entry) => entry.id === id) ?? null;
}

/**
 * The one user-facing model name, such as "Qwen3 1.7B Q4_K_M", used everywhere a local model is
 * named (picker, header, drawer status, Settings, announcements); never the raw catalog id.
 */
export function localModelName(model: Pick<LocalModelDefinition, 'name' | 'quantization'>): string {
  return `${model.name} ${model.quantization}`;
}

/** `localModelName` for a catalog id, or "Unavailable model" when it is no longer offered. */
export function localModelDisplayName(id: string): string {
  const model = findLocalModelDefinition(id);
  return model ? localModelName(model) : 'Unavailable model';
}

export function localModelDefinition(id: string): LocalModelDefinition {
  const model = LOCAL_MODEL_CATALOG.find((entry) => entry.id === id);
  if (!model) {
    throw new Error('This model is not in the on-device catalog.');
  }
  return model;
}
