import type { ModelOption } from '@bridge/types/types';

export function formatModelOptionLabel(model: ModelOption | null | undefined): string {
  if (!model) {
    return 'Default model';
  }

  const providerName = model.providerName?.trim();
  if (providerName) {
    return `${providerName} · ${model.displayName}`;
  }

  return model.displayName;
}

export function formatModelOptionDescription(model: ModelOption): string {
  const parts: string[] = [];
  const providerName = model.providerName?.trim();
  const description = model.description?.trim();

  if (providerName) {
    parts.push(providerName);
  }
  if (description) {
    parts.push(description);
  }
  if (model.contextWindow && model.contextWindow > 0) {
    parts.push(`${formatContextWindow(model.contextWindow)} context`);
  }

  if (parts.length === 0) {
    return model.id;
  }

  return parts.join(' · ');
}

function formatContextWindow(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }

  // Context windows are usually powers of two: 4,096 tokens reads as "4K", not "4.1K".
  if (value >= 1_024 && value % 1_024 === 0 && value % 1_000 !== 0 && value < 1_048_576) {
    return `${value / 1_024}K`;
  }

  if (value >= 1_000) {
    const thousands = value / 1_000;
    return `${thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
  }

  return String(value);
}
