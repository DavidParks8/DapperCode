import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Provider, createStore } from 'jotai';
import type { ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { router } from 'expo-router';
import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { localModelDefinition } from '../../on-device/models/catalog';
import type { LocalContextLoader } from '../../on-device/models/engine';
import { modelMemoryBytes } from '../../on-device/models/memory';
import { OnDeviceRuntimeScope } from '../../on-device/runtime/OnDeviceProvider';
import { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import {
  createFakeOnDeviceNative,
  FakeLlama,
  FakeNetwork,
  type FakeNativeOptions,
} from '../../on-device/runtime/testing';
import { LocalModelFamilyScreen } from './LocalModelFamilyScreen';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }));

let mockLlama = new FakeLlama();
jest.mock('../../on-device/models/engine', () => ({
  ...jest.requireActual<object>('../../on-device/models/engine'),
  loadNativeModelContext: (...args: Parameters<LocalContextLoader>) => mockLlama.loader(...args),
}));

const SMALL = 'qwen3-0.6b-q4-0';
const MEDIUM = 'qwen3-1.7b-q4-k-m';
const LARGE = 'qwen3-4b-q4-k-m';
const runtimes: OnDeviceRuntime[] = [];

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 30; index += 1) {
      await Promise.resolve();
    }
    jest.advanceTimersByTime(300);
    for (let index = 0; index < 30; index += 1) {
      await Promise.resolve();
    }
  });
}

/** The real runtime (downloads controller, model session, residency) over in-memory native. */
async function openQwen3(options: FakeNativeOptions = {}) {
  mockLlama = new FakeLlama();
  const fake = createFakeOnDeviceNative(mockLlama, options);
  const runtime = new OnDeviceRuntime(fake.native, { network: new FakeNetwork() });
  runtimes.push(runtime);
  await act(async () => {
    await runtime.initialize();
  });
  router.replace({
    pathname: '/profiles/[profileId]/settings/models/[familyId]',
    params: { profileId: 'on-device', familyId: 'qwen3' },
  });
  const wrap = (children: ReactNode) => (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <Provider store={createStore()}>
        <OnDeviceRuntimeScope runtime={runtime}>{children}</OnDeviceRuntimeScope>
      </Provider>
    </SafeAreaProvider>
  );
  render(wrap(<LocalModelFamilyScreen />));
  await flush();
  return { fake, runtime };
}

function row(modelId: string) {
  return within(screen.getAllByTestId(`local-model-${modelId}`)[0]!);
}

async function pressIn(modelId: string, label: string): Promise<void> {
  fireEvent.press(row(modelId).getByLabelText(label));
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  resetRouterMock();
  jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
});

afterEach(async () => {
  await act(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
  });
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('Models settings over the real on-device runtime', () => {
  it('runs two downloads at once, queues a third, and pauses one model without touching others', async () => {
    const { fake, runtime } = await openQwen3();
    await pressIn(SMALL, 'Download Qwen3 0.6B Q4_0');
    await pressIn(MEDIUM, 'Download Qwen3 1.7B Q4_K_M');
    await pressIn(LARGE, 'Download Qwen3 4B Q4_K_M');

    expect(fake.calls.filter((call) => call.startsWith('startModelDownload'))).toEqual([
      `startModelDownload:["${SMALL}"]`,
      `startModelDownload:["${MEDIUM}"]`,
    ]);
    expect(row(LARGE).getByText('Queued · starts when a download finishes')).toBeTruthy();
    // Other models stay actionable while transfers run.
    expect(row(MEDIUM).getByLabelText('Pause Qwen3 1.7B Q4_K_M')).toBeTruthy();
    expect(row(LARGE).getByLabelText('Cancel Qwen3 4B Q4_K_M')).toBeTruthy();

    const small = localModelDefinition(SMALL);
    fake.progressDownload(SMALL, Math.round(small.bytes / 2));
    await flush();
    expect(row(SMALL).getByText(/^Downloading 50% · /u)).toBeTruthy();
    const progress = screen.getAllByTestId(`local-model-progress-${SMALL}`)[0]!;
    expect(progress.props['accessibilityValue']).toMatchObject({ now: 50 });

    // Pausing one model frees its slot for the queued one and leaves the other running.
    await pressIn(MEDIUM, 'Pause Qwen3 1.7B Q4_K_M');
    expect(fake.calls).toContain(`pauseModelDownload:["${MEDIUM}"]`);
    expect(fake.calls).not.toContain(`pauseModelDownload:["${SMALL}"]`);
    expect(fake.calls).toContain(`startModelDownload:["${LARGE}"]`);
    expect(row(MEDIUM).getByLabelText('Resume Qwen3 1.7B Q4_K_M')).toBeTruthy();
    expect(runtime.downloads.snapshot(SMALL).phase).toBe('downloading');
    expect(runtime.downloads.snapshot(LARGE).phase).toBe('downloading');

    // A finished transfer is verified, then becomes a usable model.
    fake.completeDownload(SMALL);
    await flush();
    await flush();
    expect(fake.calls).toContain(`finalizeModelDownload:["${SMALL}"]`);
    expect(runtime.downloads.snapshot(SMALL).phase).toBe('ready');
    expect(row(SMALL).getByLabelText('Load Qwen3 0.6B Q4_0')).toBeTruthy();
    expect(runtime.downloads.snapshot(MEDIUM).phase).toBe('paused');
  });

  it('loads a larger model that only fits once the resident model is released', async () => {
    const large = localModelDefinition(LARGE);
    const { fake, runtime } = await openQwen3({
      downloaded: [MEDIUM, LARGE],
      availableBytes: modelMemoryBytes(large) + 16 * 1024 * 1024,
    });
    await pressIn(MEDIUM, 'Load Qwen3 1.7B Q4_K_M');
    expect(runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId: MEDIUM });

    // Free memory alone is below what Qwen3 4B needs while Qwen3 1.7B is resident.
    expect(fake.native.getMemoryInfo().availableBytes).toBeLessThan(modelMemoryBytes(large));
    const larger = row(LARGE);
    expect(larger.getByText('Loading replaces the current model in memory.')).toBeTruthy();
    expect(larger.getByLabelText('Load Qwen3 4B Q4_K_M').props['accessibilityState']).toMatchObject(
      { disabled: false },
    );

    await pressIn(LARGE, 'Load Qwen3 4B Q4_K_M');
    expect(runtime.models.snapshot()).toMatchObject({ phase: 'ready', modelId: LARGE });
    expect(mockLlama.loads.map((load) => load.modelId)).toEqual([MEDIUM, LARGE]);
    expect([...mockLlama.resident.values()].map((entry) => entry.modelId)).toEqual([LARGE]);
    expect(row(LARGE).getByText(/^Loaded · /u)).toBeTruthy();
    expect(runtime.preferences().modelId).toBe(LARGE);
  });
});
