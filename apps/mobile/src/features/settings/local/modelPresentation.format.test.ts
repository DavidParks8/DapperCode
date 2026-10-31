import { localModelDefinition } from '../../on-device/models/catalog';
import {
  initialDownloadSnapshot,
  type ModelDownloadSnapshot,
} from '../../on-device/models/downloadState';
import type { ModelMemoryAdmission } from '../../on-device/models/memory';
import type { LocalModelSessionSnapshot } from '../../on-device/models/session';
import type { LocalModelDefinition, LocalModelFamily } from '../../on-device/models/types';
import {
  describeAdmission,
  describeTransfer,
  describeUsage,
  familySizes,
  filterModels,
  formatBytes,
  formatContextRange,
  formatContextTokens,
  formatTimeLeft,
  modelMatchesQuery,
  modelResidency,
  sortQuants,
} from './modelPresentation';

const BASE = localModelDefinition('qwen3-1.7b-q4-k-m');
const MODEL: LocalModelDefinition = { ...BASE, bytes: 1_000_000_000 };

function download(patch: Partial<ModelDownloadSnapshot>): ModelDownloadSnapshot {
  return { ...initialDownloadSnapshot(MODEL), ...patch };
}

function session(patch: Partial<LocalModelSessionSnapshot>): LocalModelSessionSnapshot {
  return {
    phase: 'empty',
    modelId: null,
    progress: 0,
    error: null,
    contextTokens: null,
    ...patch,
  };
}

function admission(patch: Partial<ModelMemoryAdmission>): ModelMemoryAdmission {
  return {
    status: 'ready',
    requiredBytes: 2_000_000_000,
    releasableBytes: 0,
    unloadsResident: false,
    message: '',
    ...patch,
  };
}

describe('model size and duration formatting', () => {
  it('formats storage in decimal units and never shows zero for a real file', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(-5)).toBe('0 MB');
    expect(formatBytes(Number.NaN)).toBe('0 MB');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 MB');
    expect(formatBytes(1)).toBe('1 MB');
    expect(formatBytes(740_400_000)).toBe('740 MB');
    expect(formatBytes(1_000_000_000)).toBe('1.0 GB');
    expect(formatBytes(9_950_000_000)).toBe('9.9 GB');
    expect(formatBytes(12_400_000_000)).toBe('12 GB');
  });

  it('formats context sizes as binary K only when they divide evenly', () => {
    expect(formatContextTokens(4096)).toBe('4K');
    expect(formatContextTokens(32_768)).toBe('32K');
    expect(formatContextTokens(6000)).toBe('6K');
    expect(formatContextTokens(1500)).toBe('2K');
    expect(formatContextTokens(1000)).toBe('1K');
    expect(formatContextTokens(512)).toBe('512');
  });

  it('shows a context range only when the model can grow its context', () => {
    expect(formatContextRange({ ...MODEL, contextTokens: 4096, maxContextTokens: 32_768 })).toBe(
      '4K–32K context',
    );
    expect(formatContextRange({ ...MODEL, contextTokens: 4096, maxContextTokens: 4096 })).toBe(
      '4K context',
    );
  });

  it('describes time left in minutes and hours, hiding unknown or invalid estimates', () => {
    expect(formatTimeLeft(null)).toBeNull();
    expect(formatTimeLeft(-1)).toBeNull();
    expect(formatTimeLeft(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatTimeLeft(0)).toBe('less than a minute left');
    expect(formatTimeLeft(59)).toBe('less than a minute left');
    expect(formatTimeLeft(61)).toBe('2 min left');
    expect(formatTimeLeft(3540)).toBe('59 min left');
    expect(formatTimeLeft(3599)).toBe('1 hr left');
    expect(formatTimeLeft(3600)).toBe('1 hr left');
    expect(formatTimeLeft(3601)).toBe('1 hr 1 min left');
    expect(formatTimeLeft(2 * 3600 + 25 * 60)).toBe('2 hr 25 min left');
  });
});

describe('download transfer presentation', () => {
  it('shows downloading progress with the catalog size until the server reports one', () => {
    expect(
      describeTransfer(
        download({
          phase: 'downloading',
          bytesWritten: 250_000_000,
          totalBytes: 0,
          etaSeconds: 90,
        }),
        MODEL,
      ),
    ).toEqual({
      kind: 'downloading',
      label: 'Downloading 25% · 250 MB of 1.0 GB · 2 min left',
      progress: 25,
      active: true,
    });
    expect(
      describeTransfer(
        download({
          phase: 'downloading',
          bytesWritten: 250_000_000,
          totalBytes: 500_000_000,
          etaSeconds: null,
        }),
        MODEL,
      ),
    ).toMatchObject({ label: 'Downloading 50% · 250 MB of 500 MB', progress: 50 });
  });

  it('clamps progress to 0–100 when native byte counts overshoot', () => {
    expect(
      describeTransfer(
        download({ phase: 'downloading', bytesWritten: 2_000_000_000, totalBytes: 1_000_000_000 }),
        MODEL,
      ).progress,
    ).toBe(100);
    expect(
      describeTransfer(download({ phase: 'paused', bytesWritten: -10, totalBytes: 0 }), {
        ...MODEL,
        bytes: 0,
      }).progress,
    ).toBe(0);
  });

  it('shows verification progress from hashed bytes, with time left when known', () => {
    expect(
      describeTransfer(
        download({ phase: 'verifying', verifiedBytes: 400_000_000, etaSeconds: 30 }),
        MODEL,
      ),
    ).toEqual({
      kind: 'verifying',
      label: 'Verifying 40% · less than a minute left',
      progress: 40,
      active: true,
    });
    expect(
      describeTransfer(download({ phase: 'verifying', verifiedBytes: 0, etaSeconds: null }), MODEL)
        .label,
    ).toBe('Verifying 0%');
  });

  it('distinguishes a part-way pause from a downloaded file whose verification paused', () => {
    expect(
      describeTransfer(
        download({ phase: 'paused', bytesWritten: 300_000_000, verificationPending: false }),
        MODEL,
      ),
    ).toEqual({
      kind: 'paused',
      label: 'Paused at 30% · 300 MB of 1.0 GB',
      progress: 30,
      active: false,
    });
    expect(
      describeTransfer(
        download({ phase: 'paused', bytesWritten: MODEL.bytes, verificationPending: true }),
        MODEL,
      ),
    ).toEqual({
      kind: 'paused',
      label: 'Downloaded · verification paused',
      progress: null,
      active: false,
    });
  });

  it('says whether a failed download can be resumed', () => {
    expect(describeTransfer(download({ phase: 'error', canResume: true }), MODEL).label).toBe(
      'Download stopped',
    );
    expect(describeTransfer(download({ phase: 'error', canResume: false }), MODEL).label).toBe(
      'Download failed',
    );
  });

  it('maps every remaining phase to sentence-case copy and the right controls', () => {
    expect(describeTransfer(download({ phase: 'ready' }), MODEL)).toEqual({
      kind: 'ready',
      label: 'Downloaded',
      progress: null,
      active: false,
    });
    expect(describeTransfer(download({ phase: 'queued' }), MODEL)).toMatchObject({
      kind: 'queued',
      active: true,
      progress: null,
    });
    expect(describeTransfer(download({ phase: 'preparing' }), MODEL)).toEqual({
      kind: 'downloading',
      label: 'Starting download…',
      progress: 0,
      active: true,
    });
    expect(describeTransfer(download({ phase: 'loading' }), MODEL)).toMatchObject({
      kind: 'checking',
      label: 'Checking…',
      active: false,
    });
    expect(describeTransfer(download({ phase: 'not_downloaded' }), MODEL)).toEqual({
      kind: 'none',
      label: 'Not downloaded',
      progress: null,
      active: false,
    });
  });
});

describe('model residency and usage', () => {
  it('only reports residency for the resident model', () => {
    expect(modelResidency(session({ modelId: 'other', phase: 'ready' }), MODEL)).toBe('none');
    expect(modelResidency(session({ modelId: MODEL.id, phase: 'ready' }), MODEL)).toBe('loaded');
    expect(modelResidency(session({ modelId: MODEL.id, phase: 'running' }), MODEL)).toBe('loaded');
    expect(modelResidency(session({ modelId: MODEL.id, phase: 'loading' }), MODEL)).toBe('loading');
    expect(modelResidency(session({ modelId: MODEL.id, phase: 'stopping' }), MODEL)).toBe(
      'unloading',
    );
    expect(modelResidency(session({ modelId: MODEL.id, phase: 'error' }), MODEL)).toBe('none');
    expect(modelResidency(session({ modelId: MODEL.id, phase: 'empty' }), MODEL)).toBe('none');
  });

  it('combines residency with whether the model is used for new chats', () => {
    expect(
      describeUsage({
        residency: 'loaded',
        session: session({ contextTokens: 8192 }),
        selected: true,
      }),
    ).toBe('Loaded · 8K context · Used for new chats');
    expect(
      describeUsage({
        residency: 'loaded',
        session: session({ contextTokens: null }),
        selected: false,
      }),
    ).toBe('Loaded');
    expect(
      describeUsage({
        residency: 'loading',
        session: session({ progress: 42.9 }),
        selected: false,
      }),
    ).toBe('Loading 42%');
    expect(
      describeUsage({ residency: 'loading', session: session({ progress: 140 }), selected: true }),
    ).toBe('Loading 100% · Used for new chats');
    expect(
      describeUsage({ residency: 'loading', session: session({ progress: -3 }), selected: false }),
    ).toBe('Loading 0%');
    expect(describeUsage({ residency: 'unloading', session: session({}), selected: false })).toBe(
      'Unloading…',
    );
    expect(describeUsage({ residency: 'none', session: session({}), selected: true })).toBe(
      'Used for new chats',
    );
    expect(describeUsage({ residency: 'none', session: session({}), selected: false })).toBeNull();
  });
});

describe('memory admission guidance', () => {
  it('names the device kind when a model can never fit', () => {
    const unsupported = admission({ status: 'unsupported', requiredBytes: 9_000_000_000 });
    expect(describeAdmission(unsupported, { simulator: false })).toBe(
      'Needs about 9.0 GB of memory, more than this iPhone can give an app.',
    );
    expect(describeAdmission(unsupported, { simulator: true })).toBe(
      'Needs about 9.0 GB of memory, more than this simulator can give an app.',
    );
  });

  it('explains memory pressure differently when unloading would not be enough', () => {
    expect(
      describeAdmission(admission({ status: 'memory_pressure', releasableBytes: 1 }), {
        simulator: false,
      }),
    ).toMatch(/^Not enough free memory, even after unloading the current model\./);
    expect(
      describeAdmission(admission({ status: 'memory_pressure', releasableBytes: 0 }), {
        simulator: false,
      }),
    ).toMatch(/^Not enough free memory right now\./);
  });

  it('asks to retry when memory could not be measured', () => {
    expect(describeAdmission(admission({ status: 'unavailable' }), { simulator: false })).toBe(
      'Free memory could not be measured. Try again in a moment.',
    );
  });

  it('warns only when loading replaces the resident model', () => {
    expect(describeAdmission(admission({ unloadsResident: true }), { simulator: false })).toBe(
      'Loading replaces the current model in memory.',
    );
    expect(describeAdmission(admission({}), { simulator: false })).toBeNull();
  });
});

describe('model search, filters, and ordering', () => {
  const family: LocalModelFamily = {
    id: 'qwen3',
    name: 'Qwen3',
    publisher: 'Alibaba',
    description: 'Reasoning models',
    icon: 'sparkles-outline',
    featured: true,
  };
  const small: LocalModelDefinition = {
    ...MODEL,
    id: 'small',
    family: 'Qwen3',
    parameters: '0.6B',
    quantization: 'Q4_K_M',
    bytes: 400,
    recommended: false,
    runtimeIssue: undefined,
  };
  const recommended: LocalModelDefinition = {
    ...small,
    id: 'recommended',
    bytes: 900,
    recommended: true,
  };
  const unsupported: LocalModelDefinition = {
    ...small,
    id: 'unsupported',
    bytes: 100,
    recommended: true,
    runtimeIssue: 'Needs another runtime.',
  };
  const larger: LocalModelDefinition = {
    ...small,
    id: 'larger',
    parameters: '8B',
    quantization: 'Q8_0',
    bytes: 2000,
  };

  it('matches every term across family, publisher, size, and quantization text', () => {
    expect(modelMatchesQuery(small, family, '   ')).toBe(true);
    expect(modelMatchesQuery(small, family, 'alibaba 0.6b')).toBe(true);
    expect(modelMatchesQuery(small, family, 'q4 k m')).toBe(true);
    expect(modelMatchesQuery(small, family, 'q4_k_m')).toBe(true);
    expect(modelMatchesQuery(small, family, 'qwen 8b')).toBe(false);
    expect(modelMatchesQuery(small, undefined, 'alibaba')).toBe(false);
  });

  it('applies the query, downloaded-only, and larger-model filters together', () => {
    const models = [small, recommended, larger];
    const downloaded = (model: LocalModelDefinition) => model.id !== 'recommended';
    const tooLarge = (model: LocalModelDefinition) => model.id === 'larger';
    const state = { downloaded, tooLarge };

    expect(
      filterModels(
        models,
        [family],
        { query: '', downloadedOnly: false, showLarger: false },
        state,
      ),
    ).toEqual([small, recommended]);
    expect(
      filterModels(models, [family], { query: '', downloadedOnly: true, showLarger: true }, state),
    ).toEqual([small, larger]);
    expect(
      filterModels(
        models,
        [family],
        { query: '8b', downloadedOnly: false, showLarger: true },
        state,
      ),
    ).toEqual([larger]);
  });

  it('sorts runnable before unsupported, then recommended, then smallest', () => {
    const tiny: LocalModelDefinition = { ...small, id: 'tiny', bytes: 200 };
    expect(sortQuants([small, unsupported, recommended, tiny]).map((model) => model.id)).toEqual([
      'recommended',
      'tiny',
      'small',
      'unsupported',
    ]);
  });

  it('lists distinct sizes in catalog order', () => {
    expect(familySizes([small, larger, recommended])).toEqual(['0.6B', '8B']);
  });
});
