import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextProps,
  useWindowDimensions,
  View,
  type ImageSourcePropType,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppTheme } from '../theme';
import { createStyles } from './chatMessageStyles';
import type { ScrollableRowTextProps } from './chatMessageTypes';

export function SelectableMessageText({ children, ...props }: TextProps): ReactElement {
  return (
    <Text selectable={props.selectable ?? !props.onPress} {...props}>
      {children}
    </Text>
  );
}

export function renderUserTextWithMentions(
  value: string,
  mentionStyle: TextProps['style'],
): Array<string | ReactElement> {
  const pattern = /(^|[^A-Za-z0-9_])(@[A-Za-z0-9._-]+)/g;
  const parts: Array<string | ReactElement> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(value)) !== null) {
    const prefix = match[1] ?? '';
    const token = match[2] ?? '';
    const startIndex = match.index + prefix.length;
    const prefixStartIndex = match.index;
    if (prefixStartIndex > lastIndex) parts.push(value.slice(lastIndex, prefixStartIndex));
    if (prefix) parts.push(prefix);
    parts.push(
      <Text key={`mention-${String(key)}`} style={mentionStyle}>
        {token}
      </Text>,
    );
    key += 1;
    lastIndex = startIndex + token.length;
  }
  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return parts.length > 0 ? parts : [value];
}

export function MarkdownImage({
  source,
  accessibilityLabel,
}: {
  source: ImageSourcePropType;
  accessibilityLabel?: string;
}): ReactElement {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [viewerVisible, setViewerVisible] = useState(false);
  const safeAreaInsets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const modalImageWidth = Math.max(windowWidth, 160);
  const modalImageHeight = Math.max(windowHeight, 220);
  const closeButtonTop = Math.max(safeAreaInsets.top + theme.spacing.sm, 64);
  const closeButtonRight = Math.max(safeAreaInsets.right + theme.spacing.md, theme.spacing.md);
  const viewerImageFrame = useMemo(
    () => resolveContainedImageFrame(modalImageWidth, modalImageHeight, aspectRatio),
    [aspectRatio, modalImageHeight, modalImageWidth],
  );

  return (
    <>
      <Pressable
        testID="chat-image-fullscreen-trigger"
        onPress={() => setViewerVisible(true)}
        style={({ pressed }) => [
          styles.markdownImagePressable,
          pressed && styles.markdownImagePressablePressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? 'Chat image'}
        accessibilityHint="Opens the image full screen"
      >
        <Image
          source={source}
          style={[
            styles.markdownImage,
            aspectRatio ? { aspectRatio } : styles.markdownImageFallback,
          ]}
          resizeMode="contain"
          accessible={false}
          onLoad={(event) => {
            const width = event.nativeEvent.source?.width;
            const height = event.nativeEvent.source?.height;
            if (
              typeof width !== 'number' ||
              typeof height !== 'number' ||
              !Number.isFinite(width) ||
              !Number.isFinite(height) ||
              width <= 0 ||
              height <= 0
            )
              return;
            const nextAspectRatio = width / height;
            setAspectRatio((previous) =>
              previous === nextAspectRatio ? previous : nextAspectRatio,
            );
          }}
        />
      </Pressable>
      <Modal
        testID="chat-image-fullscreen-modal"
        visible={viewerVisible}
        transparent
        animationType="fade"
        presentationStyle="overFullScreen"
        statusBarTranslucent
        hardwareAccelerated
        supportedOrientations={['portrait', 'landscape']}
        onRequestClose={() => setViewerVisible(false)}
      >
        <View style={styles.imageViewerModalRoot} accessibilityViewIsModal>
          <Pressable
            testID="chat-image-fullscreen-backdrop"
            style={StyleSheet.absoluteFill}
            onPress={() => setViewerVisible(false)}
          />
          <ScrollView
            style={styles.imageViewerScroll}
            contentContainerStyle={[
              styles.imageViewerScrollContent,
              { width: windowWidth, minHeight: windowHeight },
            ]}
            centerContent
            bouncesZoom
            maximumZoomScale={4}
            minimumZoomScale={1}
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            scrollEventThrottle={16}
          >
            <View
              style={[styles.imageViewerStage, { width: windowWidth, minHeight: windowHeight }]}
            >
              <Image
                source={source}
                style={[styles.imageViewerImage, viewerImageFrame]}
                resizeMode="contain"
                accessible={Boolean(accessibilityLabel)}
                accessibilityLabel={accessibilityLabel}
              />
            </View>
          </ScrollView>
          <Pressable
            testID="chat-image-fullscreen-close"
            onPress={() => setViewerVisible(false)}
            hitSlop={12}
            style={({ pressed }) => [
              styles.imageViewerCloseButtonFloating,
              { top: closeButtonTop, right: closeButtonRight },
              styles.imageViewerCloseButton,
              pressed && styles.imageViewerCloseButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Close full-screen image"
          >
            <Ionicons name="close" size={28} color="#FFFFFF" />
          </Pressable>
        </View>
      </Modal>
    </>
  );
}

function resolveContainedImageFrame(
  maxWidth: number,
  maxHeight: number,
  aspectRatio: number | null,
): { width: number; height: number } {
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { width: maxWidth, height: maxHeight };
  }
  const widthFromHeight = maxHeight * aspectRatio;
  return widthFromHeight <= maxWidth
    ? { width: widthFromHeight, height: maxHeight }
    : { width: maxWidth, height: maxWidth / aspectRatio };
}

export function ScrollableRowText({
  children,
  style,
  backgroundColor,
  numberOfLines,
  testID,
}: ScrollableRowTextProps) {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const [showLeftFade, setShowLeftFade] = useState(false);
  const [showRightFade, setShowRightFade] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const updateFades = useCallback(
    (offsetX: number, nextViewportWidth = viewportWidth, nextContentWidth = contentWidth) => {
      const maxOffset = Math.max(0, nextContentWidth - nextViewportWidth);
      setShowLeftFade(offsetX > 1);
      setShowRightFade(maxOffset > 1 && offsetX < maxOffset - 1);
    },
    [contentWidth, viewportWidth],
  );

  return (
    <View style={styles.scrollableRowTextViewport} testID={testID}>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled
        directionalLockEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onLayout={(event) => {
          const width = event.nativeEvent.layout.width;
          setViewportWidth(width);
          updateFades(0, width, contentWidth);
        }}
        onContentSizeChange={(width) => {
          setContentWidth(width);
          updateFades(0, viewportWidth, width);
        }}
        onScroll={(event) => updateFades(event.nativeEvent.contentOffset.x)}
      >
        <Text style={[style, styles.scrollableRowText]} numberOfLines={numberOfLines}>
          {children}
        </Text>
      </ScrollView>
      {showLeftFade ? (
        <LinearGradient
          pointerEvents="none"
          colors={[backgroundColor, theme.colors.transparent]}
          style={[styles.scrollableRowTextFade, styles.scrollableRowTextFadeLeft]}
        />
      ) : null}
      {showRightFade ? (
        <LinearGradient
          pointerEvents="none"
          colors={[theme.colors.transparent, backgroundColor]}
          style={[styles.scrollableRowTextFade, styles.scrollableRowTextFadeRight]}
        />
      ) : null}
    </View>
  );
}
