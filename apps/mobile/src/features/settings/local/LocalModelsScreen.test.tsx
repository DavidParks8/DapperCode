import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { Provider, createStore } from 'jotai';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Alert, Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { router } from 'expo-router';
import { resetRouterMock } from '@shared/testing/expoRouterMock';
import { OnDeviceRuntimeScope } from '../../on-device/runtime/OnDeviceProvider';
import { LocalModelFamilyScreen } from './LocalModelFamilyScreen';
import { LocalModelsScreen } from './LocalModelsScreen';
import { MEMORY_REFRESH_MS } from './hooks';
import { FakeSettingsRuntime } from './testing';

jest.mock('expo-router', () => jest.requireActual('@shared/testing/expoRouterMock'));
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

const GiB = 1024 ** 3;
const MB = 1e6;

function wrap(runtime: FakeSettingsRuntime, children: ReactNode) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <Provider store={createStore()}>
        <OnDeviceRuntimeScope runtime={runtime.asRuntime()}>{children}</OnDeviceRuntimeScope>
      </Provider>
    </SafeAreaProvider>
  );
}

function openFamily(runtime: FakeSettingsRuntime, familyId: string) {
  router.replace({
    pathname: '/profiles/[profileId]/settings/models/[familyId]',
    params: { profileId: 'on-device', familyId },
  });
  return render(wrap(runtime, <LocalModelFamilyScreen />));
}

function row(modelId: string) {
  return within(screen.getAllByTestId(`local-model-${modelId}`)[0]!);
}

let announce: jest.SpyInstance;

beforeEach(() => {
  resetRouterMock();
  router.replace({
    pathname: '/profiles/[profileId]/settings/models',
    params: { profileId: 'on-device' },
  });
  announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => undefined);
  announce.mockClear();
});

afterEach(() => {
  announce.mockRestore();
  jest.useRealTimers();
});

describe('Models settings', () => {
  it('shows two downloads in parallel with readable, accessible progress and per-model controls', () => {
    const runtime = new FakeSettingsRuntime();
    const alert = jest.spyOn(Alert, 'alert');
    runtime.setDownload('qwen35-0.8b-q4-0', {
      phase: 'downloading',
      bytesWritten: 310 * MB,
      totalBytes: 740 * MB,
      bytesPerSecond: 4_200_000,
      etaSeconds: 95,
    });
    runtime.setDownload('qwen3-0.6b-q4-0', { phase: 'queued', totalBytes: 428_970_080 });
    runtime.setDownload('gemma-4-e2b-q4-0', {
      phase: 'downloading',
      bytesWritten: 1_000 * MB,
      totalBytes: 2_000 * MB,
    });
    render(wrap(runtime, <LocalModelsScreen />));

    const first = row('qwen35-0.8b-q4-0');
    expect(
      first.getByText('Downloading 41% · 310 MB of 740 MB · 4.2 MB/s · 2 min left'),
    ).toBeTruthy();
    const progress = screen.getAllByTestId('local-model-progress-qwen35-0.8b-q4-0')[0]!;
    expect(progress.props['accessibilityRole']).toBe('progressbar');
    expect(progress.props['accessibilityValue']).toEqual({
      min: 0,
      max: 100,
      now: 41,
      text: '41%, 310 MB of 740 MB, 4.2 megabytes per second, 2 min left',
    });
    // Without a measured rate yet, the row shows no speed rather than "0 MB/s".
    expect(row('gemma-4-e2b-q4-0').getByText('Downloading 50% · 1.0 GB of 2.0 GB')).toBeTruthy();
    expect(
      row('qwen3-0.6b-q4-0').getByText('Queued · starts when a download finishes'),
    ).toBeTruthy();

    fireEvent.press(first.getByLabelText('Pause Qwen3.5 0.8B Q4_0'));
    expect(runtime.downloads.pause).toHaveBeenCalledWith('qwen35-0.8b-q4-0');
    fireEvent.press(row('gemma-4-e2b-q4-0').getByLabelText('Cancel Gemma 4 E2B Q4_0'));
    expect(runtime.downloads.cancel).toHaveBeenCalledWith('gemma-4-e2b-q4-0');
    expect(runtime.downloads.cancel).not.toHaveBeenCalledWith('qwen35-0.8b-q4-0');
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('keeps the measured download speed current on the row and its progress value', () => {
    const runtime = new FakeSettingsRuntime();
    const id = 'qwen35-0.8b-q4-0';
    runtime.setDownload(id, { phase: 'preparing', totalBytes: 740 * MB });
    render(wrap(runtime, <LocalModelsScreen />));
    const progressText = () =>
      (
        screen.getAllByTestId(`local-model-progress-${id}`)[0]!.props['accessibilityValue'] as {
          text: string;
        }
      ).text;
    expect(row(id).getByText('Starting download…')).toBeTruthy();

    // A rate below 1 KB/s, or one that is not a finite number, is not worth showing.
    act(() =>
      runtime.setDownload(id, {
        phase: 'downloading',
        bytesWritten: 10 * MB,
        bytesPerSecond: 500,
        etaSeconds: null,
      }),
    );
    expect(row(id).getByText('Downloading 1% · 10 MB of 740 MB')).toBeTruthy();
    expect(progressText()).toBe('1%, 10 MB of 740 MB');
    act(() => runtime.setDownload(id, { bytesPerSecond: Number.NaN }));
    expect(row(id).getByText('Downloading 1% · 10 MB of 740 MB')).toBeTruthy();

    act(() => runtime.setDownload(id, { bytesPerSecond: 850_000, etaSeconds: 860 }));
    expect(
      row(id).getByText('Downloading 1% · 10 MB of 740 MB · 850 KB/s · 15 min left'),
    ).toBeTruthy();
    expect(progressText()).toBe('1%, 10 MB of 740 MB, 850 kilobytes per second, 15 min left');

    act(() =>
      runtime.setDownload(id, {
        bytesWritten: 370 * MB,
        bytesPerSecond: 123_400_000,
        etaSeconds: 3,
      }),
    );
    expect(
      row(id).getByText('Downloading 50% · 370 MB of 740 MB · 123 MB/s · less than a minute left'),
    ).toBeTruthy();

    // Speed describes moving bytes only; a paused transfer drops it.
    act(() => runtime.setDownload(id, { phase: 'paused' }));
    expect(row(id).getByText('Paused at 50% · 370 MB of 740 MB')).toBeTruthy();
    expect(row(id).queryByText(/MB\/s/u)).toBeNull();
    expect(progressText()).toBe('50%, paused');
  });

  it('announces a completed download but not the state rows already had when shown', () => {
    const runtime = new FakeSettingsRuntime();
    runtime.setDownload('qwen3-1.7b-q4-k-m', { phase: 'ready' });
    runtime.setDownload('qwen35-2b-q4-k-m', {
      phase: 'verifying',
      verifiedBytes: 600 * MB,
      totalBytes: 1_280_835_840,
    });
    render(wrap(runtime, <LocalModelsScreen />));
    expect(row('qwen35-2b-q4-k-m').getByText('Verifying 46%')).toBeTruthy();
    expect(announce).not.toHaveBeenCalled();

    act(() => runtime.setDownload('qwen35-2b-q4-k-m', { phase: 'ready' }));
    expect(announce).toHaveBeenCalledWith('Qwen3.5 2B Q4_K_M downloaded.');
    expect(screen.queryAllByTestId('local-model-qwen35-2b-q4-k-m')).toHaveLength(0);
  });

  it('announces each change once while a family page is stacked on the Models page', () => {
    const runtime = new FakeSettingsRuntime();
    router.replace({
      pathname: '/profiles/[profileId]/settings/models/[familyId]',
      params: { profileId: 'on-device', familyId: 'qwen3.5' },
    });
    const { rerender } = render(
      wrap(
        runtime,
        <>
          <LocalModelsScreen />
          <LocalModelFamilyScreen />
        </>,
      ),
    );
    act(() =>
      runtime.setDownload('qwen35-0.8b-q4-0', { phase: 'downloading', totalBytes: 740 * MB }),
    );
    expect(
      announce.mock.calls.filter(([message]) => message === 'Downloading Qwen3.5 0.8B Q4_0.'),
    ).toHaveLength(1);

    // Popping the family page leaves the Models page as the only announcer.
    rerender(wrap(runtime, <LocalModelsScreen />));
    announce.mockClear();
    act(() => runtime.setDownload('qwen35-0.8b-q4-0', { phase: 'ready' }));
    expect(announce.mock.calls).toEqual([['Qwen3.5 0.8B Q4_0 downloaded.']]);
  });

  it('shows storage used and free, and finds families by size or quant', () => {
    const runtime = new FakeSettingsRuntime();
    render(wrap(runtime, <LocalModelsScreen />));
    expect(screen.getByLabelText('Used by models, 1.3 GB')).toBeTruthy();
    expect(screen.getByLabelText('Available, 42 GB')).toBeTruthy();
    expect(runtime.downloads.refreshStorage).toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('settings-local-models-search'), 'q8');
    expect(screen.getByTestId('settings-local-family-qwen3.5')).toBeTruthy();
    expect(screen.queryByTestId('settings-local-family-bonsai-2')).toBeNull();
    expect(screen.queryByTestId('settings-local-family-qwen3')).toBeNull();

    fireEvent.changeText(screen.getByTestId('settings-local-models-search'), '0.6b');
    expect(screen.getByTestId('settings-local-family-qwen3')).toBeTruthy();
    expect(screen.queryByTestId('settings-local-family-qwen3.5')).toBeNull();

    fireEvent.press(screen.getByTestId('settings-local-family-qwen3'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/profiles/[profileId]/settings/models/[familyId]',
      params: { profileId: 'on-device', familyId: 'qwen3' },
    });
  });

  it('shows which model is loaded and which one new chats use, separately', () => {
    const runtime = new FakeSettingsRuntime();
    runtime.setDownload('qwen3-1.7b-q4-k-m', { phase: 'ready' });
    runtime.setDownload('qwen3-0.6b-q4-0', { phase: 'ready' });
    runtime.setSession({ phase: 'ready', modelId: 'qwen3-0.6b-q4-0', contextTokens: 8192 });
    runtime.setPreferences({ modelId: 'qwen3-1.7b-q4-k-m' });
    render(wrap(runtime, <LocalModelsScreen />));
    expect(row('qwen3-0.6b-q4-0').getByText('Loaded · 8K context')).toBeTruthy();
    expect(row('qwen3-1.7b-q4-k-m').getByText('Used for new chats')).toBeTruthy();
    expect(screen.getByText('Start a new chat')).toBeTruthy();
  });
});

describe('Model family settings', () => {
  it('lists quants per size with one Recommended badge style and labels unsupported packings', () => {
    const runtime = new FakeSettingsRuntime();
    runtime.memory = { physicalBytes: 16 * GiB, availableBytes: 12 * GiB, isSimulator: false };
    openFamily(runtime, 'bonsai-2');
    expect(screen.getByText('2B')).toBeTruthy();
    expect(screen.getByText('4B')).toBeTruthy();
    const unsupported = row('bonsai-2-2b-pq2-0');
    expect(unsupported.getByText('Not supported in this build')).toBeTruthy();
    expect(unsupported.getByText(/PQ2_0 needs the PrismML-specific runtime/)).toBeTruthy();
    expect(unsupported.queryByLabelText('Download Bonsai 2 2B PQ2_0')).toBeNull();
    expect(row('bonsai-2-2b-q2-0').getByLabelText('Download Bonsai 2 2B Q2_0')).toBeTruthy();
    expect(row('bonsai-2-2b-q2-0').getByText('547 MB · 4K–16K context')).toBeTruthy();
    expect(screen.queryByText(/next page/)).toBeNull();

    runtime.memory = { physicalBytes: 16 * GiB, availableBytes: 12 * GiB, isSimulator: false };
    openFamily(runtime, 'qwen3.5');
    expect(row('qwen35-2b-q4-k-m').getByText('Recommended')).toBeTruthy();
    expect(
      row('qwen35-2b-q4-k-m').getByLabelText('Source and Apache-2.0 license for Qwen3.5 2B Q4_K_M'),
    ).toBeTruthy();
  });

  it('credits the resident model when another model only fits after it is released', () => {
    const runtime = new FakeSettingsRuntime();
    runtime.setDownload('qwen3-1.7b-q4-k-m', { phase: 'ready' });
    runtime.setDownload('qwen3-4b-q4-k-m', { phase: 'ready' });
    runtime.setSession({ phase: 'ready', modelId: 'qwen3-1.7b-q4-k-m', contextTokens: 4096 });
    // Free memory alone cannot hold Qwen3 4B, but it can once Qwen3 1.7B is released.
    runtime.memory = {
      physicalBytes: 16 * GiB,
      availableBytes: Math.round(2.2 * GiB),
      isSimulator: false,
    };
    openFamily(runtime, 'qwen3');
    const larger = row('qwen3-4b-q4-k-m');
    expect(larger.getByText('Loading replaces the current model in memory.')).toBeTruthy();
    const load = larger.getByLabelText('Load Qwen3 4B Q4_K_M');
    expect(load.props['accessibilityState']).toMatchObject({ disabled: false });
    fireEvent.press(load);
    expect(runtime.selectModel).toHaveBeenCalledWith('qwen3-4b-q4-k-m');
  });

  it('re-measures memory instead of keeping a stale reading', () => {
    jest.useFakeTimers();
    const runtime = new FakeSettingsRuntime();
    runtime.setDownload('qwen3-4b-q4-k-m', { phase: 'ready' });
    runtime.memory = { physicalBytes: 16 * GiB, availableBytes: 1 * GiB, isSimulator: false };
    openFamily(runtime, 'qwen3');
    expect(
      row('qwen3-4b-q4-k-m').getByLabelText('Load Qwen3 4B Q4_K_M').props['accessibilityState'],
    ).toMatchObject({ disabled: true });
    runtime.memory = { physicalBytes: 16 * GiB, availableBytes: 12 * GiB, isSimulator: false };
    act(() => {
      jest.advanceTimersByTime(MEMORY_REFRESH_MS);
    });
    expect(
      row('qwen3-4b-q4-k-m').getByLabelText('Load Qwen3 4B Q4_K_M').props['accessibilityState'],
    ).toMatchObject({ disabled: false });
  });

  it('loads, announces, and keeps action errors on the model row', async () => {
    const runtime = new FakeSettingsRuntime();
    runtime.memory = { physicalBytes: 16 * GiB, availableBytes: 12 * GiB, isSimulator: false };
    runtime.setDownload('qwen3-1.7b-q4-k-m', { phase: 'ready' });
    runtime.setDownload('qwen3-0.6b-q4-0', { phase: 'ready' });
    runtime.selectModel.mockImplementationOnce(async (id: string) => {
      runtime.setPreferences({ modelId: id });
      runtime.setSession({ phase: 'ready', modelId: id, contextTokens: 8192 });
    });
    runtime.removeModel.mockRejectedValueOnce(
      new Error('Stop the running local conversation before deleting the model it uses.'),
    );
    openFamily(runtime, 'qwen3');
    await act(async () => {
      fireEvent.press(row('qwen3-1.7b-q4-k-m').getByLabelText('Load Qwen3 1.7B Q4_K_M'));
    });
    expect(
      row('qwen3-1.7b-q4-k-m').getByText('Loaded · 8K context · Used for new chats'),
    ).toBeTruthy();
    expect(announce).toHaveBeenCalledWith('Qwen3 1.7B Q4_K_M loaded. New chats use it.');
    expect(row('qwen3-1.7b-q4-k-m').getByLabelText('Unload Qwen3 1.7B Q4_K_M')).toBeTruthy();

    await act(async () => {
      fireEvent.press(row('qwen3-0.6b-q4-0').getByLabelText('Delete Qwen3 0.6B Q4_0'));
    });
    expect(
      row('qwen3-0.6b-q4-0').getByText(
        'Stop the running local conversation before deleting the model it uses.',
      ),
    ).toBeTruthy();
    expect(
      row('qwen3-1.7b-q4-k-m').queryByText(
        'Stop the running local conversation before deleting the model it uses.',
      ),
    ).toBeNull();
  });

  it('opens the model source only when asked', () => {
    const runtime = new FakeSettingsRuntime();
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    openFamily(runtime, 'qwen3');
    expect(open).not.toHaveBeenCalled();
    fireEvent.press(row('qwen3-0.6b-q4-0').getByLabelText(/Source and Apache-2.0 license/));
    expect(open).toHaveBeenCalledWith(expect.stringContaining('huggingface.co'));
    open.mockRestore();
  });
});
