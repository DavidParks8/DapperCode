import {
  dedupeRecentPreviewTargets,
  LOCAL_PREVIEW_URL_PATTERN,
  normalizePreviewTargetInput,
} from './constants';

export function isLocalPreviewCandidateUrl(value: string): boolean {
  return normalizePreviewTargetInput(value) !== null;
}

export function extractLocalPreviewUrls(value: string): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return [];
  }

  const matches = value.match(LOCAL_PREVIEW_URL_PATTERN) ?? [];
  return dedupeRecentPreviewTargets(
    matches
      .map((match) => normalizePreviewTargetInput(match))
      .filter((entry): entry is string => typeof entry === 'string'),
  );
}

export function pushRecentPreviewTarget(currentValues: string[], nextValue: string): string[] {
  const normalized = normalizePreviewTargetInput(nextValue);
  if (!normalized) {
    return dedupeRecentPreviewTargets(currentValues);
  }

  return dedupeRecentPreviewTargets([normalized, ...currentValues]);
}
