import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';
import { createMainScreenAgentStyles } from './agentStyles';
import { createMainScreenConversationStyles } from './conversationStyles';
import { createMainScreenModalStyles } from './modalStyles';
import { createMainScreenShellStyles } from './shellStyles';
import { createMainScreenWorkflowStyles } from '../workflow/styles';

export { createWorkflowMarkdownStyles } from '../workflow/markdownStyles';

export const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    ...createMainScreenShellStyles(theme),
    ...createMainScreenAgentStyles(theme),
    ...createMainScreenWorkflowStyles(theme),
    ...createMainScreenModalStyles(theme),
    ...createMainScreenConversationStyles(theme),
  });
