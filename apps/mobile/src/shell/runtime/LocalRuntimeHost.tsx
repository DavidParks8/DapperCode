import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import {
  OnDeviceProvider,
  useOnDeviceRuntime,
} from '../../features/on-device/runtime/OnDeviceProvider';
import { createRuntimeAgentPort } from '../../features/on-device/transport/runtimePort';
import { LocalBridgeServer } from '../../features/on-device/transport/server';
import { activeProfileIsLocalAtom, localProfileAvailableAtom } from '@shell/state/bridge/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import {
  localAgentPresenceAtom,
  localRuntimeAtom,
  localTransportAtom,
} from '@shell/state/local/atoms';
import {
  describeLocalAgentPresence,
  LOCAL_PRESENCE_SLICES,
  repairedLocalStartCwd,
  sameLocalAgentPresence,
} from './localAgentPresence';
import { useRecordLocalSetupCompletion } from '@shell/profiles/localSetup';
import { LocalBridgeWsClient } from './LocalBridgeWsClient';
import { importLegacyLocalDrafts } from './localDraftImport';
import { LocalRuntimeRecovery } from './LocalRuntimeRecovery';

/**
 * Owns the single on-device runtime for the whole app. It exists only while the local profile is
 * open and disposes the runtime — stopping runs, unloading the model, pausing downloads, cancelling
 * sign-in — as soon as it closes.
 *
 * While the runtime starts, the profile route shows its loading state; if it fails to start, the
 * recovery page covers the shell. Once ready the host renders nothing and only publishes the
 * runtime and its transport.
 */
export function LocalRuntimeHost() {
  const available = useAtomValue(localProfileAvailableAtom);
  const localProfile = useAtomValue(activeProfileIsLocalAtom);
  const pathname = usePathname();
  // Onboarding never shows local runtime pages, even while a local selection is being closed.
  if (!available || !localProfile || pathname === '/onboarding') {
    return null;
  }
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none" testID="local-runtime-host">
      <OnDeviceProvider fallback={(startup) => <LocalRuntimeRecovery {...startup} />}>
        <LocalTransportBinder />
        <LocalPresencePublisher />
        <LocalIssueAnnouncer />
        <LocalSetupCompletionRecorder />
      </OnDeviceProvider>
    </View>
  );
}

function LocalTransportBinder() {
  const runtime = useOnDeviceRuntime();
  const setRuntime = useSetAtom(localRuntimeAtom);
  const setTransport = useSetAtom(localTransportAtom);
  useEffect(() => {
    let active = true;
    let transport: LocalBridgeWsClient | null = null;
    const publish = () => {
      if (!active) {
        return;
      }
      transport = new LocalBridgeWsClient(new LocalBridgeServer(createRuntimeAgentPort(runtime)));
      transport.connect();
      setRuntime(runtime);
      setTransport(transport);
    };
    if (runtime.legacyDrafts().size === 0) {
      publish();
    } else {
      // Chats open only once the transport exists, so no composer can overwrite the import.
      void importLegacyLocalDrafts(runtime)
        .catch((error: unknown) =>
          runtime.report(
            new Error(
              `Unsent drafts from an earlier version could not be moved into your chats and were kept on this iPhone. ${error instanceof Error ? error.message : ''}`.trim(),
            ),
          ),
        )
        .finally(publish);
    }
    return () => {
      active = false;
      setTransport(null);
      setRuntime(null);
      transport?.dispose();
    };
  }, [runtime, setRuntime, setTransport]);
  return null;
}

function LocalSetupCompletionRecorder() {
  useRecordLocalSetupCompletion(useOnDeviceRuntime());
  return null;
}

/**
 * Tells VoiceOver about each runtime issue once when it appears (again only if it clears and
 * recurs). The drawer status and Settings keep showing it until it is retried or dismissed.
 */
function LocalIssueAnnouncer() {
  const runtime = useOnDeviceRuntime();
  useEffect(() => {
    const announced = new Set<string>();
    const announce = () => {
      const issues = runtime.issues();
      const current = new Set(issues.map((issue) => issue.id));
      for (const id of announced) {
        if (!current.has(id)) {
          announced.delete(id);
        }
      }
      for (const issue of issues) {
        if (!announced.has(issue.id)) {
          announced.add(issue.id);
          AccessibilityInfo.announceForAccessibility(`On this iPhone: ${issue.message}`);
        }
      }
    };
    announce();
    return runtime.subscribe(announce, ['issues']);
  }, [runtime]);
  return null;
}

/**
 * Publishes the local agent's status and new-chat readiness for the drawer and the empty chat, and
 * seeds the new-chat workspace with the one the agent would use so the picker shows it. Whenever
 * the workspaces change, a remembered workspace that no longer exists is repaired the same way.
 */
function LocalPresencePublisher() {
  const runtime = useOnDeviceRuntime();
  const store = useStore();
  const startCwd = useAtomValue(defaultStartCwdAtom);
  const setPresence = useSetAtom(localAgentPresenceAtom);
  useEffect(() => {
    let current: ReturnType<typeof describeLocalAgentPresence> | null = null;
    const publish = () => {
      const next = describeLocalAgentPresence(runtime, startCwd);
      if (!sameLocalAgentPresence(current, next)) {
        current = next;
        setPresence(next);
      }
    };
    publish();
    const unsubscribe = runtime.subscribe(publish, LOCAL_PRESENCE_SLICES);
    return () => {
      unsubscribe();
    };
  }, [runtime, setPresence, startCwd]);
  useEffect(() => () => setPresence(null), [setPresence]);
  useEffect(() => {
    // Reads the remembered path when it runs, never a render's copy, so a rename that has already
    // re-pointed it is not undone.
    const repair = () => {
      const next = repairedLocalStartCwd(runtime, store.get(defaultStartCwdAtom));
      if (next !== undefined) {
        store.set(defaultStartCwdAtom, next);
      }
    };
    repair();
    const stopRuntime = runtime.subscribe(repair, ['workspaces', 'preferences']);
    const stopDefault = store.sub(defaultStartCwdAtom, repair);
    return () => {
      stopRuntime();
      stopDefault();
    };
  }, [runtime, store]);
  return null;
}
