import { MainScreenHeaderAndWorkflow } from './HeaderAndWorkflow';
import { MainScreenTranscriptAndSheets } from '../transcript/TranscriptAndSheets';
import { MainScreenRenameSheet } from './RenameSheet';
import { MainScreenAttachmentModals } from '../composer/AttachmentModals';
import { MainScreenApprovalAndBridgePrompts } from '../approvals/BridgePrompts';
import { MainScreenModelAndEffortSheets } from '../models/ModelAndEffortSheets';
import { useCallback } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useSetAtom } from 'jotai';
import { useMainScreenStyles } from '../styles/useStyles';
import { topChromeHeightAtom } from '../state/composer';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

type MainScreenViewContext = MainScreenPanelCollapseCoordinatorContext &
  MainScreenPanelCollapseCoordinatorResult;

export function MainScreenView({ context }: { context: MainScreenViewContext }) {
  const { styles } = useMainScreenStyles();
  const setTopChromeHeight = useSetAtom(topChromeHeightAtom);
  const handleTopChromeLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = Math.ceil(event.nativeEvent.layout.height);
      setTopChromeHeight((current) => (current === nextHeight ? current : nextHeight));
    },
    [setTopChromeHeight],
  );

  return (
    <View style={styles.container}>
      <View
        onLayout={handleTopChromeLayout}
        style={styles.topChromeOverlay}
        testID="main-screen-top-chrome"
      >
        <MainScreenHeaderAndWorkflow context={context} />
      </View>
      <MainScreenTranscriptAndSheets context={context} />
      <MainScreenModelAndEffortSheets context={context} />
      <MainScreenRenameSheet context={context} />
      <MainScreenAttachmentModals context={context} />
      <MainScreenApprovalAndBridgePrompts context={context} />
    </View>
  );
}
