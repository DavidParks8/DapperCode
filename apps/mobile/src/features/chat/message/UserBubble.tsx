import { Ionicons } from '@expo/vector-icons';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { Text, useWindowDimensions, View, type TextLayoutEvent } from 'react-native';

import { decorativeAccessibilityProps } from '@shared/accessibility';
import { useAppTheme } from '@shared/theme';
import { MarkdownImage, renderUserText, SelectableMessageText } from './Primitives';
import { createStyles } from './styles';
import type { MessageBlock } from './types';

/** Keeps remounted rows (virtualized scrolling) from flashing at full width again. */
const measuredWidths = new Map<string, number>();
const MEASUREMENT_CACHE_LIMIT = 400;

export function resetHuggedTextWidthCache(): void {
  measuredWidths.clear();
}

/**
 * Text nodes report the width they were laid out in rather than the width their
 * longest line actually needs, so a wrapped bubble would otherwise sit at the
 * full allowed width. Measuring the rendered lines lets the bubble hug its text.
 * The available width is part of the cache key so rotation re-measures instead
 * of reusing a stale cap.
 */
export function useHuggedTextWidth(messageId: string) {
  const { width: windowWidth } = useWindowDimensions();
  const cacheKey = `${messageId}:${String(Math.round(windowWidth))}`;
  const [measurement, setMeasurement] = useState<{ key: string; width: number } | null>(null);
  const cached = measuredWidths.get(cacheKey) ?? null;
  const width = measurement?.key === cacheKey ? measurement.width : cached;

  const onTextLayout = useCallback(
    (event: TextLayoutEvent) => {
      const lines = event.nativeEvent.lines;
      if (!lines.length) {
        return;
      }
      const widest = Math.ceil(Math.max(...lines.map((line) => line.width)));
      if (!Number.isFinite(widest) || widest <= 0) {
        return;
      }
      setMeasurement((previous) => {
        const current = previous?.key === cacheKey ? previous.width : measuredWidths.get(cacheKey);
        // Only grow: once the bubble is capped, re-measuring reports the capped
        // lines, and accepting those would shrink the bubble on every pass.
        if (current !== undefined && current >= widest) {
          return previous;
        }
        if (measuredWidths.size >= MEASUREMENT_CACHE_LIMIT) {
          measuredWidths.clear();
        }
        measuredWidths.set(cacheKey, widest);
        return { key: cacheKey, width: widest };
      });
    },
    [cacheKey],
  );

  return { width, onTextLayout };
}

export function ChatMessageUserBubble({
  messageId,
  blocks,
}: {
  messageId: string;
  blocks: MessageBlock[];
}): ReactElement {
  const theme = useAppTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);
  const { width, onTextLayout } = useHuggedTextWidth(messageId);
  const textOnly = blocks.every((block) => block.kind === 'text');
  const hugStyle = textOnly && width !== null ? { maxWidth: width } : null;

  return (
    <View style={[styles.messageWrapper, styles.messageWrapperUser]}>
      <View
        testID="user-message-bubble"
        style={[styles.userBubble, blocks.length > 1 && styles.userBubbleWithAttachments]}
      >
        <View testID="user-bubble-content" style={[styles.userBubbleContent, hugStyle]}>
          {blocks.map((block, index) => {
            if (block.kind === 'image') {
              return (
                <MarkdownImage
                  key={`${messageId}-image-${String(index)}`}
                  source={block.source}
                  accessibilityLabel={block.accessibilityLabel}
                />
              );
            }
            if (block.kind === 'file') {
              return (
                <View key={`${messageId}-file-${String(index)}`} style={styles.userFileChip}>
                  <Ionicons
                    {...decorativeAccessibilityProps}
                    name="document-text-outline"
                    size={12}
                    color={theme.colors.userBubbleSecondaryText}
                  />
                  <Text style={styles.userFileChipText} numberOfLines={1}>
                    {block.value}
                  </Text>
                </View>
              );
            }
            return (
              <SelectableMessageText
                key={`${messageId}-text-${String(index)}`}
                style={styles.userMessageText}
                onTextLayout={textOnly ? onTextLayout : undefined}
              >
                {renderUserText(
                  block.value,
                  styles.userInlineMentionText,
                  styles.userInlineSlashCommandText,
                  index === 0,
                )}
              </SelectableMessageText>
            );
          })}
        </View>
      </View>
    </View>
  );
}
