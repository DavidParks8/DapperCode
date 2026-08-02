import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import Prism from 'prismjs';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-dart';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-kotlin';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-objectivec';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markup-templating';
import 'prismjs/components/prism-php';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, type TextStyle, View } from 'react-native';

import { decorativeAccessibilityProps } from '../accessibility';
import { feedback } from '../feedback';
import { type AppTheme, useAppTheme } from '../theme';

const COPY_STATUS_RESET_MS = 1600;
const MAX_HIGHLIGHT_LENGTH = 20_000;

type CopyStatus = 'idle' | 'copied' | 'error';

const LANGUAGE_ALIASES: Record<string, string> = {
  csharp: 'csharp',
  'c#': 'csharp',
  cs: 'csharp',
  'c++': 'cpp',
  html: 'markup',
  js: 'javascript',
  md: 'markdown',
  objc: 'objectivec',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  shell: 'bash',
  sh: 'bash',
  ts: 'typescript',
  yml: 'yaml',
};

const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Shell',
  csharp: 'C#',
  cpp: 'C++',
  dart: 'Dart',
  javascript: 'JavaScript',
  jsx: 'JSX',
  markdown: 'Markdown',
  markup: 'HTML',
  objectivec: 'Objective-C',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  php: 'PHP',
  powershell: 'PowerShell',
  sql: 'SQL',
  swift: 'Swift',
  text: 'Text',
  toml: 'TOML',
  tsx: 'TSX',
  typescript: 'TypeScript',
  yaml: 'YAML',
};

function normalizeLanguage(sourceInfo?: string | null): {
  grammar: Prism.Grammar | null;
  label: string;
} {
  const rawLanguage =
    sourceInfo
      ?.trim()
      .split(/\s+/, 1)[0]
      ?.replace(/^language-/i, '')
      .toLowerCase() ?? '';
  const safeLanguage = rawLanguage.replace(/[^a-z0-9_+.#-]/g, '').slice(0, 24);
  const language = LANGUAGE_ALIASES[safeLanguage] ?? safeLanguage;
  const grammar = language ? (Prism.languages[language] ?? null) : null;
  const label =
    LANGUAGE_LABELS[language] ?? (safeLanguage ? safeLanguage.toUpperCase() : LANGUAGE_LABELS.text);
  return { grammar, label };
}

function tokenStyle(type: string, styles: ReturnType<typeof createStyles>): TextStyle | undefined {
  if (['comment', 'prolog', 'doctype', 'cdata'].includes(type)) {
    return styles.syntaxComment;
  }
  if (['keyword', 'atrule', 'important'].includes(type)) {
    return styles.syntaxKeyword;
  }
  if (['string', 'char', 'attr-value', 'inserted', 'builtin'].includes(type)) {
    return styles.syntaxString;
  }
  if (['number', 'boolean', 'constant', 'symbol'].includes(type)) {
    return styles.syntaxNumber;
  }
  if (['function', 'class-name'].includes(type)) {
    return styles.syntaxFunction;
  }
  if (['property', 'tag', 'selector', 'attr-name', 'deleted'].includes(type)) {
    return styles.syntaxProperty;
  }
  if (['operator', 'entity', 'url', 'regex', 'variable'].includes(type)) {
    return styles.syntaxOperator;
  }
  return undefined;
}

function renderTokens(
  tokens: Prism.TokenStream,
  styles: ReturnType<typeof createStyles>,
  path = 'token',
): ReactNode {
  if (typeof tokens === 'string') {
    return tokens;
  }
  if (Array.isArray(tokens)) {
    return tokens.map((token, index) => (
      <Text key={`${path}-${String(index)}`}>
        {renderTokens(token, styles, `${path}-${String(index)}`)}
      </Text>
    ));
  }
  return (
    <Text key={path} style={tokenStyle(tokens.type, styles)}>
      {renderTokens(tokens.content, styles, `${path}-content`)}
    </Text>
  );
}

export function ChatCodeBlock({
  code,
  language,
  selectable = true,
}: {
  code: string;
  language?: string | null;
  selectable?: boolean;
}) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syntax = useMemo(() => normalizeLanguage(language), [language]);
  const highlightedCode = useMemo(
    () =>
      syntax.grammar && code.length <= MAX_HIGHLIGHT_LENGTH
        ? Prism.tokenize(code, syntax.grammar)
        : code,
    [code, syntax.grammar],
  );

  useEffect(
    () => () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void Clipboard.setStringAsync(code)
      .then(() => {
        void feedback.success();
        setCopyStatus('copied');
        if (resetTimerRef.current) {
          clearTimeout(resetTimerRef.current);
        }
        resetTimerRef.current = setTimeout(() => setCopyStatus('idle'), COPY_STATUS_RESET_MS);
      })
      .catch(() => {
        setCopyStatus('error');
      });
  }, [code]);

  const copyLabel = copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Retry' : 'Copy';
  const copyColor = copyStatus === 'error' ? theme.colors.error : theme.colors.textSecondary;

  return (
    <View style={styles.surface} testID="chat-code-block">
      <View style={styles.header}>
        <Text style={styles.languageLabel} numberOfLines={1}>
          {syntax.label}
        </Text>
        <Pressable
          testID="chat-code-block-copy"
          onPress={handleCopy}
          style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel={
            copyStatus === 'copied'
              ? 'Code copied'
              : copyStatus === 'error'
                ? 'Copy failed. Try again'
                : 'Copy code'
          }
          accessibilityHint="Copies this code block to the clipboard"
        >
          <Ionicons
            {...decorativeAccessibilityProps}
            name={
              copyStatus === 'copied'
                ? 'checkmark-outline'
                : copyStatus === 'error'
                  ? 'alert-circle-outline'
                  : 'copy-outline'
            }
            size={15}
            color={copyColor}
          />
          <Text style={[styles.copyLabel, copyStatus === 'error' && styles.copyLabelError]}>
            {copyLabel}
          </Text>
        </Pressable>
      </View>
      <ScrollView
        horizontal
        nestedScrollEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        <Text selectable={selectable} style={styles.code}>
          {renderTokens(highlightedCode, styles)}
        </Text>
      </ScrollView>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    surface: {
      maxWidth: '100%',
      marginVertical: theme.spacing.sm,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.borderHighlight,
      borderRadius: theme.radius.sm,
      backgroundColor: theme.colors.bgElevated,
    },
    header: {
      minHeight: theme.touchTarget.minimum,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: theme.spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.borderLight,
      backgroundColor: theme.colors.bgItem,
    },
    languageLabel: {
      ...theme.typography.metadata,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.35,
      flexShrink: 1,
    },
    copyButton: {
      minWidth: theme.touchTarget.minimum,
      minHeight: theme.touchTarget.minimum,
      paddingHorizontal: theme.spacing.md,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: theme.spacing.xs,
    },
    copyButtonPressed: { backgroundColor: theme.colors.bgCanvasAccent },
    copyLabel: {
      ...theme.typography.label,
      color: theme.colors.textSecondary,
    },
    copyLabelError: { color: theme.colors.error },
    scroll: { maxWidth: '100%' },
    scrollContent: {
      paddingHorizontal: theme.spacing.md,
      paddingVertical: theme.spacing.md,
    },
    code: {
      ...theme.typography.mono,
      color: theme.colors.inlineCodeText,
      flexShrink: 0,
    },
    syntaxComment: { color: theme.colors.codeSyntaxComment },
    syntaxKeyword: { color: theme.colors.codeSyntaxKeyword },
    syntaxString: { color: theme.colors.codeSyntaxString },
    syntaxNumber: { color: theme.colors.codeSyntaxNumber },
    syntaxFunction: { color: theme.colors.codeSyntaxFunction },
    syntaxProperty: { color: theme.colors.codeSyntaxProperty },
    syntaxOperator: { color: theme.colors.codeSyntaxOperator },
  });
