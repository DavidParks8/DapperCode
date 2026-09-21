import { File, Paths } from 'expo-file-system';
import * as StoreReview from 'expo-store-review';
import { Platform } from 'react-native';
import { writeFile } from '@shared/filesystem';

export const AUTO_STORE_REVIEW_THRESHOLD_MS = 10 * 60 * 1000;

const STORE_REVIEW_STATE_FILE = 'dappercode-store-review.json';

export type AutoStoreReviewState = {
  accumulatedForegroundMs: number;
  automaticRequestAt: string | null;
};

export function createDefaultAutoStoreReviewState(): AutoStoreReviewState {
  return {
    accumulatedForegroundMs: 0,
    automaticRequestAt: null,
  };
}

export function parseAutoStoreReviewState(raw: string): AutoStoreReviewState {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return createDefaultAutoStoreReviewState();
  }

  try {
    const parsed = JSON.parse(raw) as {
      accumulatedForegroundMs?: unknown;
      automaticRequestAt?: unknown;
    };
    return {
      accumulatedForegroundMs: normalizeAccumulatedForegroundMs(parsed.accumulatedForegroundMs),
      automaticRequestAt: normalizeIsoTimestamp(parsed.automaticRequestAt),
    };
  } catch {
    return createDefaultAutoStoreReviewState();
  }
}

export async function loadAutoStoreReviewState(): Promise<AutoStoreReviewState> {
  const path = getAutoStoreReviewStatePath();
  if (!path) {
    return createDefaultAutoStoreReviewState();
  }

  try {
    const raw = await new File(path).text();
    return parseAutoStoreReviewState(raw);
  } catch {
    return createDefaultAutoStoreReviewState();
  }
}

export async function saveAutoStoreReviewState(state: AutoStoreReviewState): Promise<void> {
  const path = getAutoStoreReviewStatePath();
  if (!path) {
    return;
  }

  await writeFile(new File(path), JSON.stringify(state));
}

export function isAutoStoreReviewEligible(state: AutoStoreReviewState): boolean {
  return (
    state.automaticRequestAt === null &&
    state.accumulatedForegroundMs >= AUTO_STORE_REVIEW_THRESHOLD_MS
  );
}

export async function requestNativeStoreReview(): Promise<boolean> {
  if (Platform.OS !== 'ios') {
    return false;
  }

  const available = await StoreReview.isAvailableAsync();
  if (!available) {
    return false;
  }

  await StoreReview.requestReview();
  return true;
}

function getAutoStoreReviewStatePath(): string | null {
  if (Platform.OS === 'web') {
    return null;
  }

  return new File(Paths.document, STORE_REVIEW_STATE_FILE).uri;
}

function normalizeAccumulatedForegroundMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}
