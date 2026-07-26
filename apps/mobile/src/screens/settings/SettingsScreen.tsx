import { Ionicons } from '@expo/vector-icons';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AgentDescriptor, BridgeCapabilities } from '../../api/types';
import { AgentIcon } from '../../components/AgentIcon';
import { disablePush, enablePush, updatePushEvents } from '../../pushController';
import { retryPersistenceAtom } from '../../state/appState/actions';
import { appStatePersistenceErrorAtom, pushSettingsAtom, bridgeProfilesAtom } from '../../state/appState/atoms';
import {
  approvalModeAtom,
  showToolCallsAtom,
  workspaceChatLimitAtom,
} from '../../state/appState/settings';
import {
  addBridgeProfileAtom,
  editBridgeProfileAtom,
  switchBridgeProfileAtom,
} from '../../state/bridge/actions';
import {
  activeBridgeProfileAtom,
  apiClientAtom,
  bridgeConnectedAtom,
} from '../../state/bridge/atoms';
import { drawerCommandsAtom } from '../../state/drawer/atoms';
import { openLegalScreenAtom } from '../../state/navigation/actions';
import { settingsAllowsDrawerGestureAtom } from '../../state/navigation/atoms';
import { useAppTheme } from '../../theme';

export function SettingsScreen() {
  const theme = useAppTheme();
  const store = useStore();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const api = useAtomValue(apiClientAtom);
  const bridgeConnected = useAtomValue(bridgeConnectedAtom);
  const activeBridgeProfile = useAtomValue(activeBridgeProfileAtom);
  const activeBridgeProfileId = activeBridgeProfile?.id ?? null;
  const bridgeProfiles = useAtomValue(bridgeProfilesAtom);
  const pushSettings = useAtomValue(pushSettingsAtom);
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const [approvalMode, setApprovalMode] = useAtom(approvalModeAtom);
  const [showToolCalls, setShowToolCalls] = useAtom(showToolCallsAtom);
  const [workspaceChatLimit, setWorkspaceChatLimit] = useAtom(workspaceChatLimitAtom);
  const retryPersistence = useSetAtom(retryPersistenceAtom);
  const editBridgeProfile = useSetAtom(editBridgeProfileAtom);
  const addBridgeProfile = useSetAtom(addBridgeProfileAtom);
  const switchBridgeProfile = useSetAtom(switchBridgeProfileAtom);
  const openLegalScreen = useSetAtom(openLegalScreenAtom);
  const setDrawerGestureEnabled = useSetAtom(settingsAllowsDrawerGestureAtom);

  const [capabilities, setCapabilities] = useState<BridgeCapabilities | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    setDrawerGestureEnabled(true);
    if (!api) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .readBridgeCapabilities()
      .then((value) => {
        if (!cancelled) setCapabilities(value);
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : 'Could not read bridge capabilities.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, setDrawerGestureEnabled]);

  const updatePush = async (enabled: boolean) => {
    if (!api || !activeBridgeProfileId || pushBusy) return;
    setPushBusy(true);
    setError(null);
    try {
      if (enabled) await enablePush(api, store, activeBridgeProfileId);
      else await disablePush(api, store, activeBridgeProfileId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update notifications.');
    } finally {
      setPushBusy(false);
    }
  };

  const updatePushEvent = async (key: 'turnCompleted' | 'approvalRequested', value: boolean) => {
    if (!api || !activeBridgeProfileId) return;
    await updatePushEvents(api, store, activeBridgeProfileId, {
      ...pushSettings.events,
      [key]: value,
    });
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable
          onPress={() => store.get(drawerCommandsAtom)?.toggleNavigation()}
          accessibilityRole="button"
          accessibilityLabel="Open navigation drawer"
        >
          <Ionicons name="menu" size={22} color={theme.colors.textPrimary} />
        </Pressable>
        <Text style={styles.title}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {persistenceError ? (
          <Notice text={persistenceError.message} action="Retry" onPress={retryPersistence} />
        ) : null}
        {error ? <Notice text={error} /> : null}

        <Section title="Connection">
          <Row
            label={activeBridgeProfile?.name ?? 'Current bridge'}
            value={bridgeConnected ? 'Connected' : 'Disconnected'}
            onPress={editBridgeProfile}
          />
          <Row label="Add bridge" onPress={addBridgeProfile} />
          {bridgeProfiles.map((profile) => (
            <Row
              key={profile.id}
              label={profile.name}
              value={profile.id === activeBridgeProfileId ? 'Active' : undefined}
              onPress={() => void switchBridgeProfile(profile.id)}
            />
          ))}
        </Section>

        <Section title="Installed ACP agents">
          {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
          {!loading && (capabilities?.agents.length ?? 0) === 0 ? (
            <Text style={styles.muted}>No agents reported by this bridge.</Text>
          ) : null}
          {capabilities?.agents.map((agent) => (
            <AgentRow key={agent.agentId} agent={agent} capabilities={capabilities} />
          ))}
        </Section>

        <Section title="Chat">
          <Toggle
            label="Require approvals"
            value={approvalMode !== 'yolo'}
            onChange={(value) => setApprovalMode(value ? 'normal' : 'yolo')}
          />
          <Toggle label="Show tool calls" value={showToolCalls} onChange={setShowToolCalls} />
          <Row
            label="Chats per workspace"
            value={workspaceChatLimit === null ? 'All' : String(workspaceChatLimit)}
            onPress={() =>
              setWorkspaceChatLimit(
                workspaceChatLimit === 5
                  ? 10
                  : workspaceChatLimit === 10
                    ? 25
                    : workspaceChatLimit === 25
                      ? null
                      : 5
              )
            }
          />
        </Section>

        <Section title="Notifications">
          <Toggle
            label="Push notifications"
            value={!pushSettings.optedOut}
            disabled={pushBusy}
            onChange={(value) => void updatePush(value)}
          />
          <Toggle
            label="Turn completed"
            value={pushSettings.events.turnCompleted}
            onChange={(value) => void updatePushEvent('turnCompleted', value)}
          />
          <Toggle
            label="Approval requested"
            value={pushSettings.events.approvalRequested}
            onChange={(value) => void updatePushEvent('approvalRequested', value)}
          />
        </Section>

        <Section title="Legal">
          <Row label="Privacy policy" onPress={() => openLegalScreen('Privacy')} />
          <Row label="Terms of service" onPress={() => openLegalScreen('Terms')} />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function AgentRow({ agent, capabilities }: { agent: AgentDescriptor; capabilities: BridgeCapabilities }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  const statuses = [
    agent.agentId === capabilities.preferredAgentId ? 'Preferred' : null,
    agent.agentId === capabilities.activeAgentId ? 'Active' : null,
    agent.lifecycle,
  ].filter(Boolean).join(' · ');
  return (
    <View style={styles.agentRow}>
      <AgentIcon agent={agent} size={28} />
      <View style={styles.agentText}>
        <Text style={styles.rowLabel}>{agent.displayName}</Text>
        <Text style={styles.muted}>{statuses} · {agent.version} · {agent.provenance}</Text>
        {agent.lastError ? <Text style={styles.error}>Agent unavailable (details redacted)</Text> : null}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
}

function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <Pressable disabled={!onPress} onPress={onPress} style={styles.row}><Text style={styles.rowLabel}>{label}</Text>{value ? <Text style={styles.muted}>{value}</Text> : null}</Pressable>;
}

function Toggle({ label, value, disabled, onChange }: { label: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <View style={styles.row}><Text style={styles.rowLabel}>{label}</Text><Switch value={value} disabled={disabled} onValueChange={onChange} /></View>;
}

function Notice({ text, action, onPress }: { text: string; action?: string; onPress?: () => void | Promise<void> }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme.colors), [theme.colors]);
  return <View style={styles.notice}><Text style={styles.error}>{text}</Text>{action ? <Pressable onPress={() => void onPress?.()}><Text style={styles.action}>{action}</Text></Pressable> : null}</View>;
}

function createStyles(colors: ReturnType<typeof useAppTheme>['colors']) {
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.bgMain },
    header: { minHeight: 52, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', gap: 16 },
    title: { color: colors.textPrimary, fontSize: 20, fontWeight: '700' },
    content: { padding: 18, gap: 24, paddingBottom: 48 },
    section: { gap: 4 },
    sectionTitle: { color: colors.textMuted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', marginBottom: 6 },
    row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
    rowLabel: { color: colors.textPrimary, fontSize: 15, flexShrink: 1 },
    muted: { color: colors.textMuted, fontSize: 13 },
    error: { color: colors.error, fontSize: 13 },
    action: { color: colors.accent, fontWeight: '700' },
    notice: { padding: 12, borderWidth: 1, borderColor: colors.error, gap: 8 },
    agentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.borderLight },
    agentText: { flex: 1, gap: 3 },
  });
}
