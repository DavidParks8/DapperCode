/// <reference types="expo/types/metro-require" />

import { registerRootComponent } from 'expo';
import { File, Paths } from 'expo-file-system';
import { ExpoRoot, useNavigationContainerRef } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { AppState, Text } from 'react-native';
import { useAtomValue, useStore } from 'jotai';

import { getOnDeviceNativeServices } from '../../../src/features/on-device/native/services';
import { localModelDefinition } from '../../../src/features/on-device/models/catalog';
import { emptyLocalPreferences } from '../../../src/features/on-device/runtime/preferences';
import { RootLayout } from '../../../src/shell/boot/RootLayout';
import { AppStateProvider, createAppStore } from '../../../src/shell/state/store';
import { activeChatAtom } from '../../../src/shell/state/chat/atoms';
import { wsClientAtom } from '../../../src/shell/state/bridge/atoms';
import { activeTurnIdAtom, stoppingTurnAtom } from '../../../src/features/chat/state/turn';
import { activityAtom } from '../../../src/features/chat/state/composer';
import { expandedToolInvocationIdsAtom } from '../../../src/features/chat/state/toolInvocations';
import { toRecord } from '../../../src/shared/runtimeValidation';

declare const require: __MetroModuleApi.RequireFunction;

const context = require.context('../../../src/app', true, /\.[jt]sx?$/);
const navigationJournal = new File(Paths.document, 'product-navigation.json');
const navigationEvents: unknown[] = [];
const shellJournal = new File(Paths.document, 'product-shell.json');
const shellEvents: unknown[] = [];
function recordShell(event: unknown) {
  shellEvents.push({ at: Date.now(), event });
  shellJournal.write(JSON.stringify(shellEvents));
}
function ShellObserver() {
  const store = useStore();
  const ws = useAtomValue(wsClientAtom);
  useEffect(() => {
    let previous = '';
    const record = () => {
      const chat = store.get(activeChatAtom);
      const state = {
        chatId: chat?.id,
        status: chat?.status,
        authoritative: chat?.historyAuthoritative,
        messages: chat?.messages.map((message) => ({
          id: message.id,
          role: message.role,
          createdAt: message.createdAt,
        })),
        activeTurnId: store.get(activeTurnIdAtom),
        stopping: store.get(stoppingTurnAtom),
        activity: store.get(activityAtom),
        expandedTools: store.get(expandedToolInvocationIdsAtom),
      };
      const key = JSON.stringify(state);
      if (key !== previous) {
        previous = key;
        recordShell(state);
      }
    };
    const unsubscribes = [
      activeChatAtom,
      activeTurnIdAtom,
      stoppingTurnAtom,
      activityAtom,
      expandedToolInvocationIdsAtom,
    ].map((target) => store.sub(target, record));
    record();
    return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
  }, [store]);
  useEffect(
    () =>
      ws?.onEvent((event) => {
        if (event.method !== 'bridge/agui.event') {
          return;
        }
        const message = toRecord(toRecord(event.params)?.['event']);
        if (
          message &&
          ['RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR'].includes(String(message['type']))
        ) {
          recordShell({ notification: event });
        }
      }),
    [ws],
  );
  return null;
}
function ObservedAppLayout() {
  const store = useMemo(() => createAppStore(), []);
  const navigation = useNavigationContainerRef();
  useEffect(() => {
    const record = () => {
      if (navigation.isReady()) {
        navigationEvents.push({
          at: Date.now(),
          appState: AppState.currentState,
          state: navigation.getRootState(),
        });
        navigationJournal.write(JSON.stringify(navigationEvents));
      }
    };
    const unsubscribe = navigation.addListener('state', record);
    record();
    return unsubscribe;
  }, [navigation]);
  return (
    <AppStateProvider store={store}>
      <RootLayout />
      <ShellObserver />
    </AppStateProvider>
  );
}
const observedContext = Object.assign(
  (key: string) =>
    key === './_layout.tsx' ? { default: ObservedAppLayout } : context<unknown>(key),
  context,
);
const prepared = new File(Paths.document, 'product-prepared.json');
const continueBoot = new File(Paths.document, 'continue-boot');
const result = new File(Paths.document, 'product-network.json');
let networkRequests = 0;
globalThis.fetch = () => {
  networkRequests += 1;
  result.write(JSON.stringify({ networkRequests }));
  return Promise.reject(new Error('Network is disabled for the offline product fixture.'));
};

async function prepare() {
  if (!prepared.exists) {
    const native = getOnDeviceNativeServices();
    const model = localModelDefinition(
      (await new File(Paths.document, 'model-id.txt').text()).trim(),
    );
    const workspace = await native.createWorkspace('Offline UI fixture');
    await native.writeRuntimeDocument(
      'preferences.json',
      JSON.stringify({
        ...emptyLocalPreferences(),
        modelId: model.id,
        workspaceId: workspace.id,
        author: { name: 'Offline UI Fixture', email: 'fixture@example.invalid' },
      }),
    );
    prepared.write(JSON.stringify({ workspaceId: workspace.id }));
  }
  result.write(JSON.stringify({ networkRequests }));
}

/**
 * Prepares a workspace and preferences, then boots the production router with no saved profile or
 * downloaded model. The scenario downloads and loads its real model through Settings.
 */
function ProductFixture() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void prepare()
      .then(() => {
        timer = setInterval(() => {
          if (alive && continueBoot.exists) {
            clearInterval(timer);
            setReady(true);
          }
        }, 100);
      })
      .catch((failure: unknown) => {
        if (alive) {
          setError(failure instanceof Error ? failure.message : 'Fixture preparation failed.');
        }
      });
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  if (error) {
    return <Text>{error}</Text>;
  }
  return ready ? (
    <ExpoRoot context={observedContext} />
  ) : (
    <Text>Preparing isolated offline product fixture…</Text>
  );
}

registerRootComponent(ProductFixture);
