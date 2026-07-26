import type { AppTheme } from '../../theme';
import type { GitScreenController } from './gitScreenController';
import type { createGitScreenStyles } from './gitScreenStyles';

export interface GitSectionCommonProps {
  controller: GitScreenController;
  styles: ReturnType<typeof createGitScreenStyles>;
  theme: AppTheme;
}
