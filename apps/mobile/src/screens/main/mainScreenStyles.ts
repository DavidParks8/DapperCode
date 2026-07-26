import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';
import { createMainScreenAgentStyles } from './mainScreenAgentStyles';
import { createMainScreenConversationStyles } from './mainScreenConversationStyles';
import { createMainScreenModalStyles } from './mainScreenModalStyles';
import { createMainScreenShellStyles } from './mainScreenShellStyles';
import { createMainScreenWorkflowStyles } from './mainScreenWorkflowStyles';

export { createWorkflowMarkdownStyles } from './mainScreenWorkflowMarkdownStyles';

export const createStyles = (theme: AppTheme) => StyleSheet.create({
  ...createMainScreenShellStyles(theme),
  ...createMainScreenAgentStyles(theme),
  ...createMainScreenWorkflowStyles(theme),
  ...createMainScreenModalStyles(theme),
  ...createMainScreenConversationStyles(theme),
});
