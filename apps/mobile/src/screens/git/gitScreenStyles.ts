import { StyleSheet } from 'react-native';

import type { AppTheme } from '../../theme';
import { createGitScreenCoreStyles } from './gitScreenStylesCore';
import { createGitScreenDiffReviewStyles } from './gitScreenStylesDiffReview';
import { createGitScreenReviewFilesStyles } from './gitScreenStylesReviewFiles';

export function createGitScreenStyles(theme: AppTheme) {
  return StyleSheet.create({
    ...createGitScreenCoreStyles(theme),
    ...createGitScreenReviewFilesStyles(theme),
    ...createGitScreenDiffReviewStyles(theme),
  });
}