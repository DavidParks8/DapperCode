import { act, render } from '@testing-library/react-native';
import { Provider, createStore } from 'jotai';
import type { ReactElement } from 'react';
import { Alert, type AlertButton } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { OnDeviceRuntimeScope } from '../../on-device/runtime/OnDeviceProvider';
import { OnDeviceRuntime } from '../../on-device/runtime/runtime';
import { createFakeOnDeviceNative, FakeLlama, FakeNetwork } from '../../on-device/runtime/testing';
import type { LocalWorkspace } from '../../on-device/workspaces/types';

/** Test-only harness: Skills settings pages over a real runtime and in-memory native services. */
export const SKILL_WORKSPACES: LocalWorkspace[] = [
  { id: 'ws-one', name: 'App', isRepository: true },
  { id: 'ws-two', name: 'Skills Repo', isRepository: true },
];

export const skillFile = (name: string, fields = '') =>
  `---\nname: ${name}\ndescription: ${name} description.\n${fields}---\n${name} body`;

const runtimes: OnDeviceRuntime[] = [];

/** Lets in-memory native calls a press started finish inside act. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

export async function openSkillsPage(
  element: ReactElement,
  files: Record<string, string>,
  {
    workspaces = SKILL_WORKSPACES,
    prepare,
  }: { workspaces?: LocalWorkspace[]; prepare?: (runtime: OnDeviceRuntime) => Promise<void> } = {},
) {
  const fake = createFakeOnDeviceNative(new FakeLlama(), { files, workspaces });
  const runtime = new OnDeviceRuntime(fake.native, {
    emitIntervalMs: 0,
    threadProgressDelayMs: 0,
    network: new FakeNetwork(),
  });
  runtimes.push(runtime);
  await act(async () => {
    await runtime.initialize();
    await prepare?.(runtime);
  });
  render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, left: 0, right: 0, bottom: 34 },
      }}
    >
      <Provider store={createStore()}>
        <OnDeviceRuntimeScope runtime={runtime}>{element}</OnDeviceRuntimeScope>
      </Provider>
    </SafeAreaProvider>,
  );
  await settle();
  return { fake, runtime };
}

export async function disposeSkillRuntimes(): Promise<void> {
  await act(async () => {
    await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.dispose()));
  });
}

export function lastAlertButton(label: string): AlertButton {
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? [];
  const button = buttons.find((entry) => entry.text === label);
  if (!button) {
    throw new Error(`No ${label} button`);
  }
  return button;
}
