import { MainScreenHeaderAndWorkflow } from './MainScreenHeaderAndWorkflow';
import { MainScreenTranscriptAndSheets } from './MainScreenTranscriptAndSheets';
import { MainScreenRenameSheet } from './MainScreenRenameSheet';
import { MainScreenAttachmentModals } from './MainScreenAttachmentModals';
import { MainScreenApprovalAndBridgePrompts } from './MainScreenApprovalAndBridgePrompts';
import { MainScreenModelAndEffortSheets } from './MainScreenModelAndEffortSheets';
import { View } from 'react-native';
import { useMainScreenStyles } from './useMainScreenStyles';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './mainScreenPanelCollapseCoordinator';

type MainScreenViewContext = MainScreenPanelCollapseCoordinatorContext &
  MainScreenPanelCollapseCoordinatorResult;

export function MainScreenView({ context }: { context: MainScreenViewContext }) {
  const { styles } = useMainScreenStyles();
  return (
    <View style={styles.container}>
      <MainScreenHeaderAndWorkflow context={context} />
      <MainScreenTranscriptAndSheets context={context} />
      <MainScreenModelAndEffortSheets context={context} />
      <MainScreenRenameSheet context={context} />
      <MainScreenAttachmentModals context={context} />
      <MainScreenApprovalAndBridgePrompts context={context} />
    </View>
  );
}
