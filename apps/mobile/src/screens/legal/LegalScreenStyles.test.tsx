import { StyleSheet } from 'react-native';

import { createAppTheme } from '../../theme';
import { createStyles } from './LegalScreen';

/**
 * Regression coverage for the typography sweep: the legal screen's nav-bar
 * title and body copy must derive fully from a semantic `theme.typography`
 * role instead of a raw numeric `fontSize` override layered on top of one.
 */
describe('LegalScreen typography mapping', () => {
  const theme = createAppTheme('dark');
  const styles = createStyles(theme);

  it('headerTitle uses the full "title" role (nav-bar heading, one step below largeTitle)', () => {
    const headerTitle = StyleSheet.flatten(styles.headerTitle);
    expect(headerTitle.fontSize).toBe(theme.typography.title.fontSize);
    expect(headerTitle.lineHeight).toBe(theme.typography.title.lineHeight);
    expect(headerTitle.fontWeight).toBe(theme.typography.title.fontWeight);
  });

  it('paragraph, bulletGlyph, and bulletText use the full "body" role for ordinary copy', () => {
    for (const style of [styles.paragraph, styles.bulletGlyph, styles.bulletText]) {
      const flattened = StyleSheet.flatten(style);
      expect(flattened.fontSize).toBe(theme.typography.body.fontSize);
      expect(flattened.lineHeight).toBe(theme.typography.body.lineHeight);
    }
  });

  it('linkLabel uses the full "body" role', () => {
    const linkLabel = StyleSheet.flatten(styles.linkLabel);
    expect(linkLabel.fontSize).toBe(theme.typography.body.fontSize);
    expect(linkLabel.lineHeight).toBe(theme.typography.body.lineHeight);
  });
});
