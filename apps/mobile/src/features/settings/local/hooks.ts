import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { AccessibilityInfo, AppState } from 'react-native';

import type { DeviceMemory } from '../../on-device/models/types';
import type { ModelStorageSnapshot } from '../../on-device/models/downloads';
import { LOCAL_MODEL_CATALOG } from '../../on-device/models/catalog';
import { useOnDeviceSelector } from '../../on-device/runtime/OnDeviceProvider';
import type { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import type { OnDeviceRuntimeSlice } from '../../on-device/runtime/types';
import { describeTransfer, modelResidency } from './modelPresentation';

const PREFERENCE_SLICES: readonly OnDeviceRuntimeSlice[] = ['preferences'];
const DOWNLOAD_SLICES: readonly OnDeviceRuntimeSlice[] = ['downloads'];
const MODEL_SLICES: readonly OnDeviceRuntimeSlice[] = ['models'];
const ANNOUNCEMENT_SLICES: readonly OnDeviceRuntimeSlice[] = ['downloads', 'models'];
export const MEMORY_REFRESH_MS = 5_000;

/** The runtime without subscribing to its frequently changing slices. */
export function useLocalRuntime(): OnDeviceRuntime {
  return useOnDeviceSelector((runtime) => runtime, PREFERENCE_SLICES);
}

/** Ids of downloaded, verified models, as a stable comma-separated key. */
export function useDownloadedModelKey(): string {
  return useOnDeviceSelector(
    (runtime) =>
      LOCAL_MODEL_CATALOG.filter((model) => runtime.downloads.snapshot(model.id).phase === 'ready')
        .map((model) => model.id)
        .join(','),
    DOWNLOAD_SLICES,
  );
}

/**
 * Fresh app-memory headroom. Sampled when shown, whenever the resident model changes, when the
 * app becomes active, and every few seconds, so admission never relies on a stale reading.
 */
export function useDeviceMemory(runtime: OnDeviceRuntime): DeviceMemory {
  const residentKey = useOnDeviceSelector(
    (current) => `${current.models.snapshot().modelId ?? ''}:${current.models.snapshot().phase}`,
    MODEL_SLICES,
  );
  const [memory, setMemory] = useState(() => runtime.native.getMemoryInfo());
  const sample = useCallback(() => {
    const next = runtime.native.getMemoryInfo();
    setMemory((current) =>
      current.availableBytes === next.availableBytes &&
      current.physicalBytes === next.physicalBytes &&
      current.isSimulator === next.isSimulator
        ? current
        : next,
    );
  }, [runtime]);
  useEffect(() => {
    sample();
  }, [residentKey, sample]);
  useEffect(() => {
    const timer = setInterval(sample, MEMORY_REFRESH_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        sample();
      }
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [sample]);
  return memory;
}

/** Model storage and free space, refreshed when shown and whenever a download lands or goes. */
export function useModelStorage(runtime: OnDeviceRuntime): ModelStorageSnapshot | null {
  const downloadedKey = useDownloadedModelKey();
  const [storage, setStorage] = useState<ModelStorageSnapshot | null>(() =>
    runtime.downloads.storage(),
  );
  useEffect(() => {
    let current = true;
    runtime.downloads
      .refreshStorage()
      .then((next) => {
        if (current) {
          setStorage(next);
        }
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [downloadedKey, runtime]);
  return storage;
}

function transferKinds(runtime: OnDeviceRuntime): string {
  const session = runtime.models.snapshot();
  return LOCAL_MODEL_CATALOG.map((model) => {
    const kind = describeTransfer(runtime.downloads.snapshot(model.id), model).kind;
    return `${model.id}=${kind}:${modelResidency(session, model)}`;
  }).join(',');
}

function parseKinds(key: string): Map<string, { kind: string; residency: string }> {
  return new Map(
    key.split(',').map((entry) => {
      const [id = '', state = ''] = entry.split('=');
      const [kind = '', residency = ''] = state.split(':');
      return [id, { kind, residency }];
    }),
  );
}

function transferAnnouncement(kind: string, name: string, error: string | null): string | null {
  switch (kind) {
    case 'queued':
      return `${name} queued.`;
    case 'downloading':
      return `Downloading ${name}.`;
    case 'verifying':
      return `Verifying ${name}.`;
    case 'paused':
      return `${name} paused.`;
    case 'ready':
      return `${name} downloaded.`;
    case 'error':
      return `${name} download stopped. ${error ?? ''}`.trim();
    default:
      return null;
  }
}

/**
 * Announces download and load transitions for every model once per page, even when the row
 * that showed the transfer leaves the screen (a finished download leaves the Downloads group).
 * States that were already present when the page appeared are not announced.
 */
/** Focused model pages, most recently focused last; only the last one announces. */
const focusedAnnouncers: object[] = [];

export function useModelAnnouncements(): void {
  const runtime = useLocalRuntime();
  const key = useOnDeviceSelector(transferKinds, ANNOUNCEMENT_SLICES);
  const previous = useRef(key);
  const token = useRef<object>({});
  // Pages pushed onto Settings stay mounted underneath; only the focused one may announce.
  useFocusEffect(
    useCallback(() => {
      const owner = token.current;
      focusedAnnouncers.push(owner);
      return () => {
        const index = focusedAnnouncers.lastIndexOf(owner);
        if (index >= 0) {
          focusedAnnouncers.splice(index, 1);
        }
      };
    }, []),
  );
  useEffect(() => {
    const before = parseKinds(previous.current);
    previous.current = key;
    if (focusedAnnouncers.at(-1) !== token.current) {
      return;
    }
    for (const [id, now] of parseKinds(key)) {
      const was = before.get(id);
      const model = LOCAL_MODEL_CATALOG.find((entry) => entry.id === id);
      if (!was || !model) {
        continue;
      }
      const name = `${model.name} ${model.quantization}`;
      if (was.kind !== now.kind && was.kind !== 'checking') {
        const message = transferAnnouncement(now.kind, name, runtime.downloads.snapshot(id).error);
        if (message) {
          AccessibilityInfo.announceForAccessibility(message);
        }
      }
      if (was.residency !== now.residency && now.residency === 'loaded') {
        const selected = runtime.preferences().modelId === id;
        AccessibilityInfo.announceForAccessibility(
          `${name} loaded.${selected ? ' New chats use it.' : ''}`,
        );
      }
    }
  }, [key, runtime]);
}
