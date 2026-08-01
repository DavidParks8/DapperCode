import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { feedback } from '../../feedback';
import { useAppTheme, type AppTheme } from '../../theme';

export interface LegalSection {
  title: string;
  body: string;
}

interface LegalScreenProps {
  title: string;
  sections: readonly LegalSection[];
  documentUrl: string | null;
  documentSectionLabel: string;
  documentLabel: string;
  missingDocumentMessage: string;
  openButtonLabel: string;
  unsupportedDocumentMessage: string;
  openFailureMessage: string;
  onBack: () => void;
}

type Styles = ReturnType<typeof createStyles>;

export function LegalScreen({
  title,
  sections,
  documentUrl,
  documentSectionLabel,
  documentLabel,
  missingDocumentMessage,
  openButtonLabel,
  unsupportedDocumentMessage,
  openFailureMessage,
  onBack,
}: LegalScreenProps) {
  const theme = useAppTheme();
  const { colors } = theme;
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [openingDocument, setOpeningDocument] = useState(false);
  const openDocumentDisabled = !documentUrl || openingDocument;

  const openDocument = useCallback(async () => {
    if (!documentUrl || openingDocument) {
      return;
    }
    void feedback.selection();
    try {
      setOpeningDocument(true);
      const supported = await Linking.canOpenURL(documentUrl);
      if (!supported) {
        Alert.alert('Cannot open link', unsupportedDocumentMessage);
        return;
      }
      await Linking.openURL(documentUrl);
    } catch {
      Alert.alert('Could not open link', openFailureMessage);
    } finally {
      setOpeningDocument(false);
    }
  }, [documentUrl, openFailureMessage, openingDocument, unsupportedDocumentMessage]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          hitSlop={11}
          accessibilityRole="button"
          accessibilityLabel={`Back from ${title}`}
        >
          <Ionicons name="chevron-back" size={22} color={colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>{title}</Text>
      </View>

      <ScrollView style={styles.body} contentContainerStyle={styles.content}>
        {sections.map((section) => (
          <Section key={section.title} title={section.title} body={section.body} styles={styles} />
        ))}

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{documentSectionLabel}</Text>
          <Pressable
            disabled={openDocumentDisabled}
            onPress={() => void openDocument()}
            accessibilityRole="link"
            style={({ pressed }) => [styles.linkRow, pressed && styles.linkRowPressed]}
          >
            <Text style={[styles.linkLabel, openDocumentDisabled && styles.linkLabelDisabled]}>
              {openingDocument ? 'Opening...' : openButtonLabel}
            </Text>
            <Ionicons
              name="open-outline"
              size={16}
              color={openDocumentDisabled ? colors.textMuted : colors.textPrimary}
            />
          </Pressable>
          <Text style={styles.documentLabel}>{documentLabel}</Text>
          <Text selectable style={styles.documentUrl}>
            {documentUrl ?? missingDocumentMessage}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

interface SectionProps {
  title: string;
  body: string;
  styles: Styles;
}

function Section({ title, body, styles }: SectionProps) {
  const blocks = useMemo(() => toBlocks(body), [body]);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{title}</Text>
      {blocks.map((block, index) =>
        block.kind === 'bullet' ? (
          <View key={`${block.kind}-${index}`} style={styles.bulletRow}>
            <Text style={styles.bulletGlyph}>{'\u2022'}</Text>
            <Text style={styles.bulletText}>{block.text}</Text>
          </View>
        ) : (
          <Text key={`${block.kind}-${index}`} style={styles.paragraph}>
            {block.text}
          </Text>
        ),
      )}
    </View>
  );
}

interface LegalBlock {
  kind: 'paragraph' | 'bullet';
  text: string;
}

/** Splits section copy into paragraphs and `- ` prefixed bullets for native list rendering. */
function toBlocks(body: string): LegalBlock[] {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) =>
      line.startsWith('- ')
        ? { kind: 'bullet' as const, text: line.slice(2).trim() }
        : { kind: 'paragraph' as const, text: line },
    );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: theme.colors.bgMain },
    header: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.lg,
      paddingHorizontal: 18,
    },
    headerTitle: { ...theme.typography.largeTitle, fontSize: 20 },
    body: { flex: 1 },
    content: { padding: 18, gap: theme.spacing.xxl, paddingBottom: 48 },
    section: { gap: theme.spacing.sm },
    sectionLabel: {
      ...theme.typography.caption,
      fontWeight: '700',
      textTransform: 'uppercase',
      color: theme.colors.textMuted,
    },
    paragraph: {
      ...theme.typography.body,
      fontSize: 15,
      lineHeight: 22,
      color: theme.colors.textSecondary,
    },
    bulletRow: { flexDirection: 'row', gap: theme.spacing.sm },
    bulletGlyph: {
      ...theme.typography.body,
      fontSize: 15,
      lineHeight: 22,
      color: theme.colors.textMuted,
    },
    bulletText: {
      ...theme.typography.body,
      fontSize: 15,
      lineHeight: 22,
      flex: 1,
      color: theme.colors.textSecondary,
    },
    linkRow: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
    },
    linkRowPressed: { opacity: 0.6 },
    linkLabel: { ...theme.typography.body, fontSize: 15, color: theme.colors.textPrimary },
    linkLabelDisabled: { color: theme.colors.textMuted },
    documentLabel: { ...theme.typography.caption, color: theme.colors.textMuted },
    documentUrl: { ...theme.typography.mono, color: theme.colors.textSecondary },
  });
