import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import { useAtom, useAtomValue } from 'jotai';
import { apiClientAtom, bridgeConnectedAtom } from '@shell/state/bridge/atoms';
import { defaultStartCwdAtom } from '@shell/state/appState/settings';
import { newChatWorkspaceAtom } from '../state/newChatWorkspace';
import { SelectionSheet } from '@shared/ui/SelectionSheet';
import { useAppTheme } from '@shared/theme';
import type { GitBranchSummary } from '@bridge/types/types';

/** Only execution mode and source branch are exposed; checkout allocation happens on send. */
export function NewChatWorkspace() {
  const theme = useAppTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        group: { alignSelf: 'stretch', gap: theme.spacing.sm },
        modes: { flexDirection: 'row', gap: theme.spacing.sm },
        button: {
          minHeight: theme.touchTarget.minimum,
          flex: 1,
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.bgInput,
          padding: theme.spacing.sm,
          justifyContent: 'center',
          alignItems: 'center',
        },
        selected: { borderWidth: 1, borderColor: theme.colors.accent },
        label: { ...theme.typography.body, color: theme.colors.textPrimary },
        branch: {
          minHeight: theme.touchTarget.minimum,
          justifyContent: 'center',
          padding: theme.spacing.sm,
        },
      }),
    [theme],
  );
  const [choice, setChoice] = useAtom(newChatWorkspaceAtom);
  const api = useAtomValue(apiClientAtom);
  const cwd = useAtomValue(defaultStartCwdAtom);
  const connected = useAtomValue(bridgeConnectedAtom);
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !api || !connected) {
      return;
    }
    let current = true;
    setLoading(true);
    setBranches([]);
    setError(null);
    void api
      .gitBranches(cwd ?? undefined)
      .then((result) => {
        if (current) {
          setBranches(result.branches);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (current) {
          setLoading(false);
        }
      });
    return () => {
      current = false;
    };
  }, [open, api, cwd, connected]);
  return (
    <View style={styles.group} testID="new-chat-workspace">
      <View style={styles.modes}>
        {(['local', 'worktree'] as const).map((mode) => (
          <Pressable
            key={mode}
            accessibilityRole="radio"
            accessibilityLabel={mode === 'local' ? 'Local' : 'New worktree'}
            accessibilityState={{ checked: choice.mode === mode }}
            aria-checked={choice.mode === mode}
            onPress={() => setChoice({ ...choice, mode })}
            style={[styles.button, choice.mode === mode && styles.selected]}
          >
            <Text style={styles.label}>{mode === 'local' ? 'Local' : 'New worktree'}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Branch, ${choice.branch === 'HEAD' ? 'Current branch' : choice.branch}`}
        onPress={() => setOpen(true)}
        style={styles.branch}
        testID="new-chat-branch"
      >
        <Text style={styles.label} numberOfLines={1}>
          Branch: {choice.branch === 'HEAD' ? 'Current branch' : choice.branch}
        </Text>
      </Pressable>
      {open ? (
        <SelectionSheet
          visible={open}
          title="Choose branch"
          subtitle={
            error ??
            (choice.mode === 'worktree'
              ? 'Start a new worktree from this branch.'
              : 'Use this branch in the local checkout.')
          }
          loading={loading}
          loadingLabel="Loading branches"
          onClose={() => setOpen(false)}
          options={[
            {
              key: 'HEAD',
              title: 'Current branch',
              selected: choice.branch === 'HEAD',
              onPress: () => {
                setChoice({ ...choice, branch: 'HEAD' });
                setOpen(false);
              },
            },
            ...branches.map((branch) => ({
              key: branch.name,
              title: branch.name,
              selected: choice.branch === branch.name,
              onPress: () => {
                setChoice({ ...choice, branch: branch.name });
                setOpen(false);
              },
            })),
          ]}
        />
      ) : null}
    </View>
  );
}
