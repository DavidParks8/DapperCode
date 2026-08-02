import type { AppTheme } from '@shared/theme';
import type { GitScreenController } from '../controller/screenController';
import type { createGitScreenStyles } from '../styles/screenStyles';

export interface GitSectionCommonProps {
  controller: GitScreenController;
  styles: ReturnType<typeof createGitScreenStyles>;
  theme: AppTheme;
}
