import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ActivityIndicator, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';

import {
  controlAccessibilityState,
  decorativeAccessibilityProps,
  useModalAccessibilityFocus,
} from '@shared/accessibility';
import { feedback } from '@shared/feedback';
import { useAppTheme } from '@shared/theme';
import { createMermaidAccessibilityLabel } from './mermaidAccessibility';
import { MermaidCanvas, type MermaidCanvasHandle } from './MermaidCanvas';
import { createMermaidDiagramStyles, type MermaidDiagramStyles } from './mermaidDiagramStyles';
import { resolveMermaidCopyPresentation } from './mermaidCopyPresentation';
import type { MermaidRenderResult } from './MermaidRenderProvider';
import type { CopyStatus } from '../useCopyText';

const ZOOM_MIN = 1;
const ZOOM_MAX = 5;

interface MermaidViewerProps {
  visible: boolean;
  source: string;
  result: MermaidRenderResult;
  copyStatus: CopyStatus;
  onCopy: () => void;
  onClose: () => void;
}

export function MermaidViewer({
  visible,
  source,
  result,
  copyStatus,
  onCopy,
  onClose,
}: MermaidViewerProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createMermaidDiagramStyles(theme), [theme]);
  const safeAreaInsets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const closeButtonRef = useModalAccessibilityFocus(visible, 200);
  const canvasRef = useRef<MermaidCanvasHandle>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const diagramAccessibilityLabel = useMemo(
    () => createMermaidAccessibilityLabel(source),
    [source],
  );
  const copy = resolveMermaidCopyPresentation(copyStatus);
  const copyColor = copyStatus === 'error' ? theme.colors.error : theme.colors.textSecondary;

  useEffect(() => {
    setReady(false);
    setError(null);
    setZoom(1);
  }, [result.svg, visible]);

  const close = useCallback(() => {
    setReady(false);
    setError(null);
    setZoom(1);
    onClose();
  }, [onClose]);

  return (
    <Modal
      testID="mermaid-viewer-modal"
      visible={visible}
      transparent={false}
      animationType={reduceMotion ? 'none' : 'fade'}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      hardwareAccelerated
      supportedOrientations={['portrait', 'landscape']}
      onRequestClose={close}
    >
      <View
        style={[
          styles.viewerRoot,
          {
            paddingTop: safeAreaInsets.top,
            paddingBottom: safeAreaInsets.bottom,
            paddingLeft: safeAreaInsets.left,
            paddingRight: safeAreaInsets.right,
          },
        ]}
        accessibilityViewIsModal
      >
        <View style={styles.viewerHeader}>
          <Pressable
            ref={closeButtonRef}
            testID="mermaid-viewer-close"
            onPress={close}
            style={({ pressed }) => [
              styles.viewerHeaderButton,
              pressed && styles.viewerButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Close Mermaid diagram"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name="close"
              size={24}
              color={theme.colors.textPrimary}
            />
          </Pressable>
          <Text style={styles.viewerTitle} numberOfLines={1}>
            Mermaid diagram
          </Text>
          <Pressable
            testID="mermaid-viewer-copy"
            onPress={onCopy}
            style={({ pressed }) => [
              styles.viewerHeaderButton,
              pressed && styles.viewerButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={copy.accessibilityLabel}
            accessibilityHint="Copies the raw Mermaid chart source to the clipboard"
          >
            <Ionicons
              {...decorativeAccessibilityProps}
              name={copy.icon}
              size={20}
              color={copyColor}
            />
          </Pressable>
        </View>

        <ViewerCanvas
          visible={visible}
          result={result}
          ready={ready}
          error={error}
          accessibilityLabel={diagramAccessibilityLabel}
          styles={styles}
          canvasRef={canvasRef}
          onRendered={() => {
            setReady(true);
            setError(null);
          }}
          onLoading={() => {
            setReady(false);
            setError(null);
            setZoom(1);
          }}
          onError={(message) => {
            setReady(false);
            setError(message);
          }}
          onZoomChange={setZoom}
          mutedColor={theme.colors.textMuted}
          errorColor={theme.colors.error}
        />
        <ZoomDock
          ready={ready}
          zoom={zoom}
          styles={styles}
          canvasRef={canvasRef}
          textColor={theme.colors.textPrimary}
          bottomOffset={safeAreaInsets.bottom + theme.spacing.lg}
        />
      </View>
    </Modal>
  );
}

function ViewerCanvas({
  visible,
  result,
  ready,
  error,
  accessibilityLabel,
  styles,
  canvasRef,
  onRendered,
  onLoading,
  onError,
  onZoomChange,
  mutedColor,
  errorColor,
}: {
  visible: boolean;
  result: MermaidRenderResult;
  ready: boolean;
  error: string | null;
  accessibilityLabel: string;
  styles: MermaidDiagramStyles;
  canvasRef: RefObject<MermaidCanvasHandle | null>;
  onRendered: () => void;
  onLoading: () => void;
  onError: (message: string) => void;
  onZoomChange: (zoom: number) => void;
  mutedColor: string;
  errorColor: string;
}) {
  return (
    <View
      style={styles.viewerCanvas}
      accessible={ready}
      accessibilityRole={ready ? 'image' : undefined}
      accessibilityLabel={ready ? accessibilityLabel : undefined}
      accessibilityHint={
        ready ? 'Use Copy source to access the complete Mermaid chart text.' : undefined
      }
    >
      {visible && !error ? (
        <MermaidCanvas
          ref={canvasRef}
          svg={result.svg}
          width={result.width}
          height={result.height}
          onLoading={onLoading}
          onRendered={onRendered}
          onError={onError}
          onZoomChange={onZoomChange}
        />
      ) : null}
      {!ready && !error ? (
        <View
          style={styles.viewerStatus}
          accessibilityRole="progressbar"
          accessibilityLabel="Preparing full-screen Mermaid diagram"
        >
          <ActivityIndicator color={mutedColor} />
          <Text style={styles.loadingText}>Preparing viewer</Text>
        </View>
      ) : null}
      {error ? (
        <View style={styles.viewerStatus} accessibilityRole="alert">
          <Ionicons
            {...decorativeAccessibilityProps}
            name="alert-circle-outline"
            size={24}
            color={errorColor}
          />
          <Text style={styles.errorTitle}>Couldn’t open the diagram</Text>
          <Text style={styles.errorDetail}>{error}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ZoomDock({
  ready,
  zoom,
  styles,
  canvasRef,
  textColor,
  bottomOffset,
}: {
  ready: boolean;
  zoom: number;
  styles: MermaidDiagramStyles;
  canvasRef: RefObject<MermaidCanvasHandle | null>;
  textColor: string;
  bottomOffset: number;
}) {
  const zoomOutDisabled = !ready || zoom <= ZOOM_MIN;
  const zoomInDisabled = !ready || zoom >= ZOOM_MAX;
  return (
    <View testID="mermaid-zoom-dock" style={[styles.zoomDock, { bottom: bottomOffset }]}>
      <Pressable
        testID="mermaid-zoom-out"
        disabled={zoomOutDisabled}
        onPress={() => {
          void feedback.selection();
          canvasRef.current?.zoomOut();
        }}
        style={({ pressed }) => [
          styles.zoomButton,
          pressed && styles.viewerButtonPressed,
          zoomOutDisabled && styles.buttonDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Zoom out"
        accessibilityState={controlAccessibilityState({ disabled: zoomOutDisabled })}
      >
        <Ionicons {...decorativeAccessibilityProps} name="remove" size={22} color={textColor} />
      </Pressable>
      <Pressable
        testID="mermaid-zoom-reset"
        disabled={!ready}
        onPress={() => {
          void feedback.selection();
          canvasRef.current?.reset();
        }}
        style={({ pressed }) => [
          styles.zoomResetButton,
          pressed && styles.viewerButtonPressed,
          !ready && styles.buttonDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Diagram zoom ${String(Math.round(zoom * 100))} percent. Reset to fit`}
        accessibilityState={controlAccessibilityState({ disabled: !ready })}
      >
        <Text style={styles.zoomLabel}>{`${String(Math.round(zoom * 100))}%`}</Text>
      </Pressable>
      <Pressable
        testID="mermaid-zoom-in"
        disabled={zoomInDisabled}
        onPress={() => {
          void feedback.selection();
          canvasRef.current?.zoomIn();
        }}
        style={({ pressed }) => [
          styles.zoomButton,
          pressed && styles.viewerButtonPressed,
          zoomInDisabled && styles.buttonDisabled,
        ]}
        accessibilityRole="button"
        accessibilityLabel="Zoom in"
        accessibilityState={controlAccessibilityState({ disabled: zoomInDisabled })}
      >
        <Ionicons {...decorativeAccessibilityProps} name="add" size={22} color={textColor} />
      </Pressable>
    </View>
  );
}
