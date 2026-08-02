import { MainScreenHeaderAndWorkflow } from './HeaderAndWorkflow';
import { MainScreenTranscriptAndSheets } from '../transcript/TranscriptAndSheets';
import { MainScreenRenameSheet } from './RenameSheet';
import { MainScreenAttachmentModals } from '../composer/AttachmentModals';
import { MainScreenApprovalAndBridgePrompts } from '../approvals/BridgePrompts';
import { MainScreenModelAndEffortSheets } from '../models/ModelAndEffortSheets';
import { View } from 'react-native';
import { useMainScreenStyles } from '../styles/useStyles';
import type {
  MainScreenPanelCollapseCoordinatorContext,
  MainScreenPanelCollapseCoordinatorResult,
} from './panelCollapseCoordinator';

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
