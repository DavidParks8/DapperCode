import type { ModelDownloadSnapshot } from '../../on-device/models/downloads';
import type { ModelMemoryAdmission } from '../../on-device/models/memory';
import type { LocalModelSessionSnapshot } from '../../on-device/models/session';
import type { LocalModelDefinition, LocalModelFamily } from '../../on-device/models/types';

/** Storage sizes use decimal units, as the iOS Settings storage pages do. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 MB';
  }
  if (bytes >= 1e9) {
    const gigabytes = bytes / 1e9;
    return `${gigabytes >= 10 ? gigabytes.toFixed(0) : gigabytes.toFixed(1)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Context sizes are conventionally binary: 4,096 tokens is "4K". */
export function formatContextTokens(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) {
    return `${tokens / 1024}K`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return String(tokens);
}

export function formatContextRange(model: LocalModelDefinition): string {
  const minimum = formatContextTokens(model.contextTokens);
  return model.maxContextTokens > model.contextTokens
    ? `${minimum}–${formatContextTokens(model.maxContextTokens)} context`
    : `${minimum} context`;
}

export function formatTimeLeft(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  if (seconds < 60) {
    return 'less than a minute left';
  }
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min left`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} hr ${rest} min left` : `${hours} hr left`;
}

/** Transfer speed in decimal units, or null when there is no meaningful rate to show yet. */
export function formatSpeed(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond < 1e3) {
    return null;
  }
  if (bytesPerSecond >= 1e9) {
    return `${(bytesPerSecond / 1e9).toFixed(1)} GB/s`;
  }
  if (bytesPerSecond >= 1e6) {
    const megabytes = bytesPerSecond / 1e6;
    return `${megabytes >= 100 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB/s`;
  }
  return `${Math.round(bytesPerSecond / 1e3)} KB/s`;
}

/** VoiceOver reads "MB/s" letter by letter, so spoken values spell the unit out. */
function spokenSpeed(speed: string): string {
  return speed
    .replace(/ GB\/s$/u, ' gigabytes per second')
    .replace(/ MB\/s$/u, ' megabytes per second')
    .replace(/ KB\/s$/u, ' kilobytes per second');
}

function percentOf(done: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}

export type ModelTransferKind =
  'none' | 'checking' | 'queued' | 'downloading' | 'verifying' | 'paused' | 'error' | 'ready';

export interface ModelTransferPresentation {
  kind: ModelTransferKind;
  /**
   * Short state shown on the row, such as
   * "Downloading 42% · 310 MB of 740 MB · 4.2 MB/s · 2 min left".
   */
  label: string;
  /** 0–100 while bytes are moving or being verified (or paused part-way); null otherwise. */
  progress: number | null;
  /** What VoiceOver reads as the progress bar's value; null when there is no progress bar. */
  progressText: string | null;
  /** True while queued, running, or verifying work exists that pause and cancel apply to. */
  active: boolean;
}

/** Human, sentence-case download state. Never exposes raw phase identifiers. */
export function describeTransfer(
  download: ModelDownloadSnapshot,
  model: LocalModelDefinition,
): ModelTransferPresentation {
  const total = download.totalBytes > 0 ? download.totalBytes : model.bytes;
  switch (download.phase) {
    case 'ready':
      return {
        kind: 'ready',
        label: 'Downloaded',
        progress: null,
        progressText: null,
        active: false,
      };
    case 'queued':
      return {
        kind: 'queued',
        label: 'Queued · starts when a download finishes',
        progress: null,
        progressText: null,
        active: true,
      };
    case 'preparing':
      return {
        kind: 'downloading',
        label: 'Starting download…',
        progress: 0,
        progressText: 'Starting download',
        active: true,
      };
    case 'downloading': {
      const progress = percentOf(download.bytesWritten, total);
      const amount = `${formatBytes(download.bytesWritten)} of ${formatBytes(total)}`;
      const speed = formatSpeed(download.bytesPerSecond);
      const timeLeft = formatTimeLeft(download.etaSeconds);
      return {
        kind: 'downloading',
        label: [`Downloading ${progress}%`, amount, speed, timeLeft].filter(Boolean).join(' · '),
        progress,
        progressText: [`${progress}%`, amount, speed && spokenSpeed(speed), timeLeft]
          .filter(Boolean)
          .join(', '),
        active: true,
      };
    }
    case 'verifying': {
      const progress = percentOf(download.verifiedBytes, total);
      const timeLeft = formatTimeLeft(download.etaSeconds);
      return {
        kind: 'verifying',
        label: [`Verifying ${progress}%`, timeLeft].filter(Boolean).join(' · '),
        progress,
        progressText: [`${progress}%`, timeLeft].filter(Boolean).join(', '),
        active: true,
      };
    }
    case 'paused': {
      if (download.verificationPending) {
        return {
          kind: 'paused',
          label: 'Downloaded · verification paused',
          progress: null,
          progressText: null,
          active: false,
        };
      }
      const progress = percentOf(download.bytesWritten, total);
      return {
        kind: 'paused',
        label: `Paused at ${progress}% · ${formatBytes(download.bytesWritten)} of ${formatBytes(total)}`,
        progress,
        progressText: `${progress}%, paused`,
        active: false,
      };
    }
    case 'error':
      return {
        kind: 'error',
        label: download.canResume ? 'Download stopped' : 'Download failed',
        progress: null,
        progressText: null,
        active: false,
      };
    case 'loading':
      return {
        kind: 'checking',
        label: 'Checking…',
        progress: null,
        progressText: null,
        active: false,
      };
    default:
      return {
        kind: 'none',
        label: 'Not downloaded',
        progress: null,
        progressText: null,
        active: false,
      };
  }
}

/** Whether `model` is the resident model, and what it is doing. */
export type ModelResidency = 'loaded' | 'loading' | 'unloading' | 'none';

export function modelResidency(
  session: LocalModelSessionSnapshot,
  model: LocalModelDefinition,
): ModelResidency {
  if (session.modelId !== model.id) {
    return 'none';
  }
  switch (session.phase) {
    case 'ready':
    case 'running':
      return 'loaded';
    case 'loading':
      return 'loading';
    case 'stopping':
      return 'unloading';
    default:
      return 'none';
  }
}

/**
 * The usage line for a downloaded model. "Used for new chats" is the selected model; "Loaded"
 * means its weights are resident in memory. Either can be true without the other.
 */
export function describeUsage(input: {
  residency: ModelResidency;
  session: LocalModelSessionSnapshot;
  selected: boolean;
}): string | null {
  const { residency, session, selected } = input;
  const parts: string[] = [];
  if (residency === 'loaded') {
    parts.push(
      session.contextTokens
        ? `Loaded · ${formatContextTokens(session.contextTokens)} context`
        : 'Loaded',
    );
  } else if (residency === 'loading') {
    parts.push(`Loading ${Math.max(0, Math.min(100, Math.floor(session.progress)))}%`);
  } else if (residency === 'unloading') {
    parts.push('Unloading…');
  }
  if (selected) {
    parts.push('Used for new chats');
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Plain-language memory guidance; null when the model fits without caveats. */
export function describeAdmission(
  admission: ModelMemoryAdmission,
  options: { simulator: boolean },
): string | null {
  switch (admission.status) {
    case 'unsupported':
      return `Needs about ${formatBytes(admission.requiredBytes)} of memory, more than this ${
        options.simulator ? 'simulator' : 'iPhone'
      } can give an app.`;
    case 'memory_pressure':
      return admission.releasableBytes > 0
        ? 'Not enough free memory, even after unloading the current model. Close other apps or choose a smaller model.'
        : 'Not enough free memory right now. Close other apps or choose a smaller model.';
    case 'unavailable':
      return 'Free memory could not be measured. Try again in a moment.';
    default:
      return admission.unloadsResident ? 'Loading replaces the current model in memory.' : null;
  }
}

export interface ModelFilters {
  query: string;
  downloadedOnly: boolean;
  showLarger: boolean;
}

function searchText(model: LocalModelDefinition, family: LocalModelFamily | undefined): string {
  return [
    family?.name,
    family?.publisher,
    family?.description,
    model.name,
    model.parameters,
    model.quantization,
    model.quantization.replaceAll('_', ' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** True when every whitespace-separated term appears in the family, size, or quant text. */
export function modelMatchesQuery(
  model: LocalModelDefinition,
  family: LocalModelFamily | undefined,
  query: string,
): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return true;
  }
  const text = searchText(model, family);
  return terms.every((term) => text.includes(term));
}

export function filterModels(
  models: readonly LocalModelDefinition[],
  families: readonly LocalModelFamily[],
  filters: ModelFilters,
  state: {
    downloaded: (model: LocalModelDefinition) => boolean;
    tooLarge: (model: LocalModelDefinition) => boolean;
  },
): LocalModelDefinition[] {
  return models.filter(
    (model) =>
      modelMatchesQuery(
        model,
        families.find((family) => family.name === model.family),
        filters.query,
      ) &&
      (!filters.downloadedOnly || state.downloaded(model)) &&
      (filters.showLarger || !state.tooLarge(model)),
  );
}

/** Quants of one size: runnable before unsupported, recommended first, then smallest. */
export function sortQuants(models: readonly LocalModelDefinition[]): LocalModelDefinition[] {
  return [...models].sort(
    (left, right) =>
      Number(Boolean(left.runtimeIssue)) - Number(Boolean(right.runtimeIssue)) ||
      Number(right.recommended) - Number(left.recommended) ||
      left.bytes - right.bytes,
  );
}

/** Distinct sizes of a family in catalog order, such as ["0.8B", "2B"]. */
export function familySizes(models: readonly LocalModelDefinition[]): string[] {
  return [...new Set(models.map((model) => model.parameters))];
}
