import { StyleSheet } from 'react-native';

import { createAppTheme } from '@shared/theme';
import { createGitScreenDiffReviewStyles } from './diffReview';
import { createGitScreenReviewFilesStyles } from './reviewFiles';

/**
 * Regression coverage for the typography sweep: diff gutters and file/commit
 * badges must derive their (dense, metadata-scale) font size/line height from
 * `theme.typography.metadata` rather than a raw numeric literal, while still
 * rendering in the monospace family so digits stay column-aligned with the
 * adjacent diff/mono text.
 */
describe('git screen mono/metadata typography mapping', () => {
  const theme = createAppTheme('dark');
  const { metadata, mono } = theme.typography;

  it('diffLineNumber and diffLinePrefix use metadata size/lineHeight with the mono font family', () => {
    const styles = createGitScreenDiffReviewStyles(theme);
    const lineNumber = StyleSheet.flatten(styles.diffLineNumber);
    const linePrefix = StyleSheet.flatten(styles.diffLinePrefix);

    for (const style of [lineNumber, linePrefix]) {
      expect(style.fontSize).toBe(metadata.fontSize);
      expect(style.lineHeight).toBe(metadata.lineHeight);
      expect(style.fontFamily).toBe(mono.fontFamily);
      // The floor for readable UI is 11pt; metadata sits exactly at that floor.
      expect(style.fontSize).toBeGreaterThanOrEqual(11);
    }
  });

  it('reviewFileCode, reviewFileStats, and historyHashBadgeText use metadata size/lineHeight with the mono font family', () => {
    const styles = createGitScreenReviewFilesStyles(theme);
    const fileCode = StyleSheet.flatten(styles.reviewFileCode);
    const fileStats = StyleSheet.flatten(styles.reviewFileStats);
    const hashBadge = StyleSheet.flatten(styles.historyHashBadgeText);

    for (const style of [fileCode, fileStats, hashBadge]) {
      expect(style.fontSize).toBe(metadata.fontSize);
      expect(style.lineHeight).toBe(metadata.lineHeight);
      expect(style.fontFamily).toBe(mono.fontFamily);
    }
  });
});
