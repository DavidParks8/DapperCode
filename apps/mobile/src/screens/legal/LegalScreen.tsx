import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAppTheme, type AppTheme } from '../../theme';

export interface LegalSection {
  title: string;
  body: string;
}

interface LegalScreenProps {
  title: string;
  iconName: ComponentProps<typeof Ionicons>['name'];
  sections: readonly LegalSection[];
  documentUrl: string | null;
  documentSectionLabel: string;
  documentLabel: string;
  missingDocumentMessage: string;
  openButtonLabel: string;
  unsupportedDocumentMessage: string;
  openFailureMessage: string;
  onOpenDrawer: () => void;
}

export function LegalScreen({
  title,
  iconName,
  sections,
  documentUrl,
  documentSectionLabel,
  documentLabel,
  missingDocumentMessage,
  openButtonLabel,
  unsupportedDocumentMessage,
  openFailureMessage,
  onOpenDrawer,
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
    <View style={styles.container}>
      <LinearGradient
        colors={[colors.bgMain, colors.bgMain, colors.bgMain]}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safeArea}>
        <BlurView intensity={80} tint={theme.blurTint} style={styles.header}>
          <Pressable onPress={onOpenDrawer} hitSlop={8} style={styles.menuBtn}>
            <Ionicons name="menu" size={22} color={colors.textPrimary} />
          </Pressable>
          <Ionicons name={iconName} size={16} color={colors.textPrimary} />
          <Text style={styles.headerTitle}>{title}</Text>
        </BlurView>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {sections.map((section) => (
            <Section
              key={section.title}
              title={section.title}
              body={section.body}
              styles={styles}
              blurTint={theme.blurTint}
            />
          ))}

          <Text style={styles.sectionLabel}>{documentSectionLabel}</Text>
          <BlurView intensity={50} tint={theme.blurTint} style={styles.card}>
            <Text style={styles.cardTitle}>{documentLabel}</Text>
            <Text selectable style={styles.documentUrl}>
              {documentUrl ?? missingDocumentMessage}
            </Text>
            <Pressable
              disabled={openDocumentDisabled}
              onPress={() => void openDocument()}
              style={({ pressed }) => [
                styles.openBtn,
                openDocumentDisabled && styles.openBtnDisabled,
                pressed && documentUrl && !openingDocument && styles.openBtnPressed
              ]}
            >
              <Ionicons
                name="open-outline"
                size={16}
                color={openDocumentDisabled ? colors.textMuted : colors.accentText}
              />
              <Text style={[styles.openBtnText, openDocumentDisabled && styles.openBtnTextDisabled]}>
                {openingDocument ? 'Opening...' : openButtonLabel}
              </Text>
            </Pressable>
          </BlurView>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

interface SectionProps {
  title: string;
  body: string;
  styles: ReturnType<typeof createStyles>;
  blurTint: AppTheme['blurTint'];
}

function Section({ title, body, styles, blurTint }: SectionProps) {
  return (
    <>
      <Text style={styles.sectionLabel}>{title}</Text>
      <BlurView intensity={50} tint={blurTint} style={styles.card}>
        <Text style={styles.bodyText}>{body}</Text>
      </BlurView>
    </>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.bgMain },
    safeArea: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.md,
    },
    menuBtn: { padding: theme.spacing.xs },
    headerTitle: { ...theme.typography.headline, color: theme.colors.textPrimary },
    body: { flex: 1 },
    bodyContent: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxl },
    sectionLabel: {
      ...theme.typography.caption,
      textTransform: 'uppercase',
      letterSpacing: 0,
      marginTop: theme.spacing.sm,
      marginBottom: theme.spacing.sm,
      color: theme.colors.textMuted,
      marginLeft: theme.spacing.xs,
    },
    card: {
      borderRadius: theme.radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      padding: theme.spacing.lg,
      marginBottom: theme.spacing.sm,
      overflow: 'hidden',
      backgroundColor: theme.colors.bgCanvasAccent,
    },
    bodyText: {
      ...theme.typography.body,
      color: theme.colors.textSecondary,
    },
    cardTitle: {
      ...theme.typography.headline,
      color: theme.colors.textPrimary,
    },
    documentUrl: {
      ...theme.typography.mono,
      marginTop: theme.spacing.sm,
      color: theme.colors.textMuted,
    },
    openBtn: {
      marginTop: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.sm,
      borderRadius: theme.radius.md,
      paddingVertical: theme.spacing.md,
      paddingHorizontal: theme.spacing.md,
      backgroundColor: theme.colors.accent,
    },
    openBtnPressed: {
      backgroundColor: theme.colors.accentPressed,
    },
    openBtnDisabled: {
      backgroundColor: theme.colors.bgItem,
    },
    openBtnText: {
      ...theme.typography.headline,
      color: theme.colors.accentText,
    },
    openBtnTextDisabled: {
      color: theme.colors.textMuted,
    },
  });