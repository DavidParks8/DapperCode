import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SvgCss } from 'react-native-svg/css';

import { controlAccessibilityState, decorativeAccessibilityProps } from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme } from '@shared/theme';
import { createMermaidAccessibilityLabel } from './mermaidAccessibility';
import { resolveMermaidCopyPresentation } from './mermaidCopyPresentation';
import { createMermaidDiagramStyles, type MermaidDiagramStyles } from './mermaidDiagramStyles';
import { createMermaidTheme } from './mermaidProtocol';
import { useMermaidRender } from './MermaidRenderProvider';
import { MermaidLoadingCanvas } from './MermaidStreamingPlaceholder';
import { MermaidViewer } from './MermaidViewer';
import { useCopyText } from '../useCopyText';

const PREVIEW_HEIGHT_DEFAULT = 196;
const PREVIEW_HEIGHT_MIN = 148;
const PREVIEW_HEIGHT_MAX = 320;
type RenderSize = { width: number; height: number };

export function MermaidDiagram({ source }: { source: string }) {
  const theme = useAppTheme();
  const styles = useMemo(() => createMermaidDiagramStyles(theme), [theme]);
  const mermaidTheme = useMemo(() => createMermaidTheme(theme), [theme]);
  const renderState = useMermaidRender(source, mermaidTheme);
  const [previewWidth, setPreviewWidth] = useState(0);
  const [viewerVisible, setViewerVisible] = useState(false);
  const { copy, copyStatus } = useCopyText(source);
  const previewHeight = resolveMermaidPreviewHeight(previewWidth, renderState.result);
  const previewReady = renderState.status === 'ready';
  const copyPresentation = resolveMermaidCopyPresentation(copyStatus);
  const accessibilityLabel = useMemo(() => createMermaidAccessibilityLabel(source), [source]);

  useEffect(() => {
    setViewerVisible(false);
  }, [source, theme.mode]);

  const handlePreviewLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (Number.isFinite(width) && width > 0) {
      setPreviewWidth((current) => (Math.abs(current - width) < 0.5 ? current : width));
    }
  }, []);
  const openViewer = useCallback(() => {
    if (!previewReady) {
      return;
    }
    void feedback.selection();
    setViewerVisible(true);
  }, [previewReady]);
  const closeViewer = useCallback(() => {
    setViewerVisible(false);
  }, []);

  const copyColor = copyStatus === 'error' ? theme.colors.error : theme.colors.textSecondary;

  return (
    <>
      <View
        style={styles.surface}
        testID="mermaid-diagram"
        accessibilityElementsHidden={viewerVisible}
        importantForAccessibility={viewerVisible ? 'no-hide-descendants' : 'auto'}
      >
        <View style={styles.header}>
          <View style={styles.headerTitleGroup}>
            <Ionicons
              {...decorativeAccessibilityProps}
              name="git-network-outline"
              size={15}
              color={theme.colors.textMuted}
            />
            <Text style={styles.languageLabel} numberOfLines={1}>
              Mermaid
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              testID="mermaid-copy-source"
              onPress={copy}
              style={({ pressed }) => [styles.headerButton, pressed && styles.buttonPressed]}
              accessibilityRole="button"
              accessibilityLabel={copyPresentation.accessibilityLabel}
              accessibilityHint="Copies the raw Mermaid chart source to the clipboard"
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name={copyPresentation.icon}
                size={15}
                color={copyColor}
              />
              <Text style={[styles.copyLabel, copyStatus === 'error' && styles.copyLabelError]}>
                {copyPresentation.label}
              </Text>
            </Pressable>
            <Pressable
              testID="mermaid-expand"
              disabled={!previewReady}
              onPress={openViewer}
              style={({ pressed }) => [
                styles.iconButton,
                pressed && styles.buttonPressed,
                !previewReady && styles.buttonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Open Mermaid diagram full screen"
              accessibilityHint="Opens zoom and pan controls"
              accessibilityState={controlAccessibilityState({ disabled: !previewReady })}
            >
              <Ionicons
                {...decorativeAccessibilityProps}
                name="expand-outline"
                size={18}
                color={theme.colors.textSecondary}
              />
            </Pressable>
          </View>
        </View>

        {renderState.status === 'error' ? (
          <MermaidFallback source={source} error={renderState.error} styles={styles} />
        ) : (
          <View
            testID="mermaid-preview"
            style={[styles.preview, { height: previewHeight }]}
            onLayout={handlePreviewLayout}
          >
            {renderState.status === 'ready' ? (
              <SvgCss
                testID="mermaid-preview-svg"
                xml={renderState.result.svg}
                width="100%"
                height="100%"
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            ) : null}
            {renderState.status === 'loading' ? (
              <MermaidLoadingCanvas
                testID="mermaid-render-loading"
                accessibilityLabel="Rendering Mermaid diagram"
              />
            ) : null}
            {previewReady ? (
              <Pressable
                testID="mermaid-preview-open"
                onPress={openViewer}
                style={({ pressed }) => [StyleSheet.absoluteFill, pressed && styles.previewPressed]}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityHint="Opens zoom and pan controls. Use Copy source for the complete chart text."
              />
            ) : null}
          </View>
        )}
      </View>

      {renderState.status === 'ready' ? (
        <MermaidViewer
          visible={viewerVisible}
          source={source}
          result={renderState.result}
          copyStatus={copyStatus}
          onCopy={copy}
          onClose={closeViewer}
        />
      ) : null}
    </>
  );
}

function MermaidFallback({
  source,
  error,
  styles,
}: {
  source: string;
  error: string;
  styles: MermaidDiagramStyles;
}) {
  return (
    <View style={styles.fallback}>
      <View style={styles.errorSummary} accessibilityRole="alert">
        <Ionicons
          {...decorativeAccessibilityProps}
          name="alert-circle-outline"
          size={18}
          style={styles.errorIcon}
        />
        <View style={styles.errorCopy}>
          <Text style={styles.errorTitle}>Couldn’t render this diagram</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      </View>
      <ScrollView
        horizontal
        nestedScrollEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        style={styles.sourceScroll}
        contentContainerStyle={styles.sourceScrollContent}
      >
        <Text selectable style={styles.sourceCode}>
          {source}
        </Text>
      </ScrollView>
    </View>
  );
}

export function resolveMermaidPreviewHeight(width: number, size: RenderSize | null): number {
  if (!size || width <= 0 || size.width <= 0 || size.height <= 0) {
    return PREVIEW_HEIGHT_DEFAULT;
  }
  const fittedHeight = (width * size.height) / size.width;
  return Math.min(PREVIEW_HEIGHT_MAX, Math.max(PREVIEW_HEIGHT_MIN, fittedHeight));
}
