import { useAtomValue, useSetAtom } from 'jotai';
import { useMemo } from 'react';
import { ActivityIndicator, ScrollView, Text } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSceneHorizontalInsets } from '@shell/layout/useShellLayout';
import {
  SceneToolbarHost,
  useInlineToolbar,
  type SceneToolbarItem,
} from '@shell/layout/SceneToolbar';

import type { Chat } from '@bridge/types/types';
import { useAccessibilityAnnouncement } from '@shared/accessibility';
import { approvalModeAtom } from '@shell/state/appState/settings';
import { useBridgeApi } from '@shell/state/bridge/hooks';
import { closeGitAtom, gitChatUpdatedAtom } from '@shell/navigation/actions';
import { activeProfileFeaturesAtom } from '@shell/state/bridge/atoms';
import { workspaceHostClientAtom } from '../workspace/api/atoms';
import { openWorkspaceFilesAtom } from '../workspace/files/navigation';
import { useAppTheme } from '@shared/theme';
import { GitScreenBranchSummarySection } from './screen/sections/BranchSummarySection';
import { GitScreenCommitHistorySection } from './screen/sections/CommitHistorySection';
import { GitScreenDiffSection } from './screen/sections/DiffSection';
import { GitScreenHeaderSection } from './screen/sections/HeaderSection';
import { GitScreenReviewSection } from './screen/sections/ReviewSection';
import { GitScreenWorkspaceSection } from './screen/sections/WorkspaceSection';
import { GitNotice, GitRepositorySetupSection } from './screen/sections/HostSections';
import { useGitScreenController } from './controller/screenController';
import { createGitScreenStyles } from './styles/screenStyles';

interface GitScreenProps {
  chat: Chat;
}

export function GitScreen({ chat }: GitScreenProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createGitScreenStyles(theme), [theme]);
  const sceneInsets = useSceneHorizontalInsets();
  const api = useBridgeApi();
  const approvalMode = useAtomValue(approvalModeAtom);
  const onBack = useSetAtom(closeGitAtom);
  const onChatUpdated = useSetAtom(gitChatUpdatedAtom);
  const features = useAtomValue(activeProfileFeaturesAtom);
  const host = useAtomValue(workspaceHostClientAtom);
  const openFilesRoute = useSetAtom(openWorkspaceFilesAtom);

  const controller = useGitScreenController({
    api,
    chat,
    approvalMode,
    onBack,
    onChatUpdated,
    features,
    host,
  });
  const openFiles =
    features.workspaceFiles && controller.requestedCwd
      ? () => openFilesRoute({ cwd: controller.requestedCwd ?? '', chatId: chat.id })
      : undefined;

  useAccessibilityAnnouncement(controller.error);
  useAccessibilityAnnouncement(
    controller.loading
      ? 'Loading Git status'
      : controller.refreshing
        ? 'Refreshing Git status'
        : controller.committing
          ? 'Committing changes'
          : controller.pushing
            ? 'Pushing changes'
            : controller.switchingBranch
              ? 'Switching branch'
              : controller.syncing === 'fetch'
                ? 'Fetching from origin'
                : controller.syncing === 'pull'
                  ? 'Pulling from origin'
                  : null,
  );

  const inlineToolbar = useInlineToolbar();
  const refreshing = controller.loading || controller.refreshing;
  const toolbarItems: SceneToolbarItem[] = [
    {
      key: 'back',
      icon: 'chevron-back',
      label: 'Back to chat',
      onPress: onBack,
      group: 'navigation',
    },
    {
      key: 'refresh',
      icon: 'refresh',
      label: 'Refresh Git status',
      onPress: () => void controller.refresh(),
      group: 'action',
      disabled: refreshing,
    },
    ...(openFiles
      ? [
          {
            key: 'files',
            icon: 'document-text-outline',
            label: 'Browse files',
            onPress: openFiles,
            group: 'action',
          } satisfies SceneToolbarItem,
        ]
      : []),
  ];

  return (
    <SceneToolbarHost items={toolbarItems}>
      <SafeAreaView style={[styles.container, sceneInsets]} edges={['top', 'bottom']}>
        <GitScreenHeaderSection
          controller={controller}
          styles={styles}
          theme={theme}
          onBack={onBack}
          showButtons={inlineToolbar}
        />

        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          scrollEnabled={controller.bodyScrollEnabled}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          <GitScreenWorkspaceSection
            controller={controller}
            styles={styles}
            theme={theme}
            onOpenFiles={openFiles}
          />

          {controller.loading ? (
            <ActivityIndicator
              accessibilityRole="progressbar"
              accessibilityLabel="Loading Git status"
              color={theme.colors.textPrimary}
              style={styles.loader}
            />
          ) : controller.notRepository ? (
            <GitRepositorySetupSection controller={controller} styles={styles} theme={theme} />
          ) : (
            <Animated.View entering={FadeIn.duration(200)}>
              <GitScreenBranchSummarySection
                controller={controller}
                styles={styles}
                theme={theme}
              />
              <GitScreenCommitHistorySection
                controller={controller}
                styles={styles}
                theme={theme}
              />
              <GitScreenDiffSection controller={controller} styles={styles} theme={theme} />
            </Animated.View>
          )}

          <GitNotice controller={controller} styles={styles} />

          {controller.error ? (
            <Text
              accessibilityRole="alert"
              accessibilityLiveRegion="assertive"
              style={styles.errorText}
            >
              {controller.error}
            </Text>
          ) : null}
        </ScrollView>

        <GitScreenReviewSection controller={controller} styles={styles} theme={theme} />
      </SafeAreaView>
    </SceneToolbarHost>
  );
}
