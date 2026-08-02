import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { AgentDescriptor, BridgeCapabilities } from '../../api/types';
import type { WorkspaceChatLimit } from '../../appSettings';
import { AgentIcon } from '../../components/AgentIcon';
import { feedback } from '../../feedback';
import { disablePush, enablePush, updatePushEvents } from '../../pushController';
import { retryPersistenceAtom } from '../../state/appState/actions';
import {
  appStatePersistenceErrorAtom,
  pushSettingsAtom,
  bridgeProfilesAtom,
} from '../../state/appState/atoms';
import {
  approvalModeAtom,
  showToolCallsAtom,
  workspaceChatLimitAtom,
} from '../../state/appState/settings';
import {
  activeBridgeProfileAtom,
  apiClientAtom,
  bridgeConnectedAtom,
} from '../../state/bridge/atoms';
import { useBridgeCapabilitiesResource } from '../../state/bridge/capabilities';
import { drawerCommandsAtom } from '../../state/drawer/atoms';
import { routes } from '../../navigation/routes';
import { replaceRoot } from '../../navigation/routeNavigation';
import { useAppTheme, type AppTheme } from '../../theme';

function cycleWorkspaceChatLimit(current: WorkspaceChatLimit): WorkspaceChatLimit {
  if (current === 5) return 10;
  if (current === 10) return 25;
  if (current === 25) return null;
  return 5;
}

interface ConnectionSectionProps {
  activeBridgeProfile: { id: string; name: string } | null;
  activeBridgeProfileId: string | null;
  bridgeConnected: boolean;
  bridgeProfiles: { id: string; name: string }[];
  profileId: string;
  router: ReturnType<typeof useRouter>;
}

function ConnectionSection({
  activeBridgeProfile,
  activeBridgeProfileId,
  bridgeConnected,
  bridgeProfiles,
  profileId,
  router,
}: ConnectionSectionProps) {
  return (
    <Section title="Connection">
      <Row
        label={activeBridgeProfile?.name ?? 'Current bridge'}
        value={bridgeConnected ? 'Connected' : 'Disconnected'}
        onPress={() => router.push(routes.settingsConnection(profileId, 'edit'))}
      />
      <Row
        label="Add bridge"
        onPress={() => router.push(routes.settingsConnection(profileId, 'add'))}
      />
      {bridgeProfiles.map((profile) => (
        <Row
          key={profile.id}
          label={profile.name}
          value={profile.id === activeBridgeProfileId ? 'Active' : undefined}
          onPress={() => replaceRoot(routes.newChat(profile.id))}
        />
      ))}
    </Section>
  );
}

interface InstalledAgentsSectionProps {
  loading: boolean;
  capabilities: BridgeCapabilities | null | undefined;
  theme: AppTheme;
}

function InstalledAgentsSection({ loading, capabilities, theme }: InstalledAgentsSectionProps) {
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Section title="Installed ACP agents">
      {loading ? <ActivityIndicator color={theme.colors.accent} /> : null}
      {!loading && (capabilities?.agents.length ?? 0) === 0 ? (
        <Text style={styles.muted}>No agents reported by this bridge.</Text>
      ) : null}
      {capabilities?.agents.map((agent) => (
        <AgentRow key={agent.agentId} agent={agent} capabilities={capabilities} />
      ))}
    </Section>
  );
}

interface ChatSettingsSectionProps {
  approvalMode: string;
  setApprovalMode: (mode: 'normal' | 'yolo') => void;
  showToolCalls: boolean;
  setShowToolCalls: (value: boolean) => void;
  workspaceChatLimit: WorkspaceChatLimit;
  setWorkspaceChatLimit: (value: WorkspaceChatLimit) => void;
}

function ChatSettingsSection({
  approvalMode,
  setApprovalMode,
  showToolCalls,
  setShowToolCalls,
  workspaceChatLimit,
  setWorkspaceChatLimit,
}: ChatSettingsSectionProps) {
  return (
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
        onPress={() => setWorkspaceChatLimit(cycleWorkspaceChatLimit(workspaceChatLimit))}
      />
    </Section>
  );
}

interface NotificationsSectionProps {
  pushSettings: {
    optedOut: boolean;
    events: { turnCompleted: boolean; approvalRequested: boolean };
  };
  pushBusy: boolean;
  updatePush: (value: boolean) => void | Promise<void>;
  updatePushEvent: (
    key: 'turnCompleted' | 'approvalRequested',
    value: boolean,
  ) => void | Promise<void>;
}

function NotificationsSection({
  pushSettings,
  pushBusy,
  updatePush,
  updatePushEvent,
}: NotificationsSectionProps) {
  return (
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
  );
}

function LegalSection({
  profileId,
  router,
}: {
  profileId: string;
  router: ReturnType<typeof useRouter>;
}) {
  return (
    <Section title="Legal">
      <Row label="Privacy policy" onPress={() => router.push(routes.privacy(profileId))} />
      <Row label="Terms of service" onPress={() => router.push(routes.terms(profileId))} />
    </Section>
  );
}

export function SettingsScreen() {
  const theme = useAppTheme();
  const router = useRouter();
  const { profileId: routeProfileId } = useLocalSearchParams<{ profileId?: string }>();
  const store = useStore();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const api = useAtomValue(apiClientAtom);
  const bridgeConnected = useAtomValue(bridgeConnectedAtom);
  const activeBridgeProfile = useAtomValue(activeBridgeProfileAtom);
  const activeBridgeProfileId = activeBridgeProfile?.id ?? null;
  const profileId = routeProfileId ?? activeBridgeProfileId ?? '';
  const bridgeProfiles = useAtomValue(bridgeProfilesAtom);
  const pushSettings = useAtomValue(pushSettingsAtom);
  const persistenceError = useAtomValue(appStatePersistenceErrorAtom);
  const drawerCommands = useAtomValue(drawerCommandsAtom);
  const [approvalMode, setApprovalMode] = useAtom(approvalModeAtom);
  const [showToolCalls, setShowToolCalls] = useAtom(showToolCallsAtom);
  const [workspaceChatLimit, setWorkspaceChatLimit] = useAtom(workspaceChatLimitAtom);
  const retryPersistence = useSetAtom(retryPersistenceAtom);

  const {
    value: capabilities,
    refreshing: capabilitiesRefreshing,
    error: capabilitiesError,
  } = useBridgeCapabilitiesResource();
  const loading = capabilitiesRefreshing && !capabilities;
  const [error, setError] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

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
        {drawerCommands?.toggleNavigation ? (
          <Pressable
            onPress={drawerCommands.toggleNavigation}
            accessibilityRole="button"
            accessibilityLabel="Open navigation drawer"
          >
            <Ionicons name="menu" size={22} color={theme.colors.textPrimary} />
          </Pressable>
        ) : null}
        <Text style={styles.title}>Settings</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {persistenceError ? (
          <Notice text={persistenceError.message} action="Retry" onPress={retryPersistence} />
        ) : null}
        {capabilitiesError ? <Notice text={capabilitiesError} /> : null}
        {error ? <Notice text={error} /> : null}

        <ConnectionSection
          activeBridgeProfile={activeBridgeProfile}
          activeBridgeProfileId={activeBridgeProfileId}
          bridgeConnected={bridgeConnected}
          bridgeProfiles={bridgeProfiles}
          profileId={profileId}
          router={router}
        />

        <InstalledAgentsSection loading={loading} capabilities={capabilities} theme={theme} />

        <ChatSettingsSection
          approvalMode={approvalMode}
          setApprovalMode={setApprovalMode}
          showToolCalls={showToolCalls}
          setShowToolCalls={setShowToolCalls}
          workspaceChatLimit={workspaceChatLimit}
          setWorkspaceChatLimit={setWorkspaceChatLimit}
        />

        <NotificationsSection
          pushSettings={pushSettings}
          pushBusy={pushBusy}
          updatePush={updatePush}
          updatePushEvent={updatePushEvent}
        />

        <LegalSection profileId={profileId} router={router} />
      </ScrollView>
    </SafeAreaView>
  );
}

function AgentRow({
  agent,
  capabilities,
}: {
  agent: AgentDescriptor;
  capabilities: BridgeCapabilities;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const statuses = [
    agent.agentId === capabilities.preferredAgentId ? 'Preferred' : null,
    agent.agentId === capabilities.activeAgentId ? 'Active' : null,
    agent.lifecycle,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View style={styles.agentRow}>
      <AgentIcon agent={agent} size={28} />
      <View style={styles.agentText}>
        <Text style={styles.rowLabel}>{agent.displayName}</Text>
        <Text style={styles.muted}>
          {statuses} · {agent.version} · {agent.provenance}
        </Text>
        {agent.lastError ? (
          <Text style={styles.error}>Agent unavailable (details redacted)</Text>
        ) : null}
      </View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      {children}
    </View>
  );
}

function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <Pressable
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={() => {
        if (!onPress) return;
        void feedback.selection();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && onPress && styles.rowPressed]}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      {value ? <Text style={styles.muted}>{value}</Text> : null}
    </Pressable>
  );
}

function Toggle({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Switch
        accessibilityLabel={label}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          void feedback.selection();
          onChange(next);
        }}
      />
    </View>
  );
}

function Notice({
  text,
  action,
  onPress,
}: {
  text: string;
  action?: string;
  onPress?: () => void | Promise<void>;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  return (
    <View style={styles.notice}>
      <Text style={styles.error}>{text}</Text>
      {action ? (
        <Pressable
          accessibilityLabel={action}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => {
            void feedback.selection();
            void onPress?.();
          }}
          style={styles.noticeAction}
        >
          <Text style={styles.action}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  const { colors } = theme;
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.bgMain },
    header: {
      minHeight: 52,
      paddingHorizontal: 18,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    title: {
      ...theme.typography.title,
      color: colors.textPrimary,
    },
    content: { padding: 18, gap: 24, paddingBottom: 48 },
    section: { gap: 4 },
    sectionTitle: {
      ...theme.typography.label,
      color: colors.textMuted,
      fontWeight: '700',
      textTransform: 'uppercase',
      marginBottom: 6,
    },
    row: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    rowPressed: { backgroundColor: colors.bgCanvasAccent },
    rowLabel: { ...theme.typography.subheadline, color: colors.textPrimary, flexShrink: 1 },
    muted: { ...theme.typography.caption, color: colors.textMuted },
    error: { ...theme.typography.caption, color: colors.error },
    action: { ...theme.typography.label, color: colors.accent, fontWeight: '700' },
    noticeAction: { minHeight: theme.touchTarget.minimum, justifyContent: 'center' },
    notice: {
      padding: 12,
      borderWidth: 1,
      borderRadius: theme.radius.md,
      borderColor: colors.error,
      gap: 8,
    },
    agentRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    agentText: { flex: 1, gap: 3 },
  });
}
