import { StyleSheet } from 'react-native';

import type { AppTheme } from '@shared/theme';
import { createGitScreenCoreStyles } from './core';
import { createGitScreenDiffReviewStyles } from './diffReview';
import { createGitScreenHostStyles } from './hostActions';
import { createGitScreenReviewFilesStyles } from './reviewFiles';

export function createGitScreenStyles(theme: AppTheme) {
  return StyleSheet.create({
    ...createGitScreenCoreStyles(theme),
    ...createGitScreenReviewFilesStyles(theme),
    ...createGitScreenDiffReviewStyles(theme),
    ...createGitScreenHostStyles(theme),
  });
}
