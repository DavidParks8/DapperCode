import { LinearGradient } from 'expo-linear-gradient';
import { useMemo, type ReactElement, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { useAppTheme } from '@shared/theme';
import { toMarkdownImageSource } from './imageSource';
import { MarkdownImage, SelectableMessageText } from './Primitives';
import {
  highlightDiffCodeLines,
  renderSyntaxTokens,
  resolveSyntaxLanguage,
  syntaxLanguageFromPath,
} from './syntaxHighlight';
import { createToolCardStyles } from './toolCardStyles';
import type { ToolInvocation, ToolInvocationDiff } from './toolInvocationModel';
import { compactToolDiff } from './toolInvocationPresentation';
import {
  compositeOverlayColor,
  horizontalFadeColors,
  useHorizontalOverflow,
} from './useHorizontalOverflow';

const SCROLL_LINE_THRESHOLD = 24;
const MAX_LOCATION_CHIPS = 8;

export function ToolInvocationOutput({
  invocation,
  headerLabel,
  bridgeUrl,
  bridgeToken,
}: {
  invocation: ToolInvocation;
  headerLabel: string;
  bridgeUrl: string | null;
  bridgeToken: string | null;
}): ReactElement | null {
  const theme = useAppTheme();
  const styles = useMemo(() => createToolCardStyles(theme), [theme]);
  const visibleLocations = locationsNotRepeatedInHeader(invocation, headerLabel);
  const hasUnavailableDiff = invocation.diffs.some((diff) => compactToolDiff(diff).unavailable);
  const sections: ReactElement[] = [];
  const addSection = (key: string, content: ReactNode) => {
    if (sections.length > 0) {
      sections.push(<View key={`${key}-divider`} style={styles.panelDivider} />);
    }
    sections.push(
      <View key={key} style={styles.panelSection}>
        {content}
      </View>,
    );
  };

  if (visibleLocations.length > 0) {
    const shown = visibleLocations.slice(0, MAX_LOCATION_CHIPS);
    addSection(
      'locations',
      <>
        <Text style={styles.sectionLabel}>Locations</Text>
        <View style={styles.locationChips}>
          {shown.map((location) => (
            <View
              key={`${location.path}:${location.line === undefined ? '' : String(location.line)}`}
              style={styles.locationChip}
            >
              <Text style={styles.locationChipText}>
                {location.line === undefined
                  ? location.path
                  : `${location.path}:${String(location.line)}`}
              </Text>
            </View>
          ))}
          {visibleLocations.length > shown.length ? (
            <Text style={styles.note}>+{String(visibleLocations.length - shown.length)} more</Text>
          ) : null}
        </View>
      </>,
    );
  }

  if (invocation.diffs.length > 0) {
    addSection(
      'diffs',
      <View testID="tool-diff-results">
        {invocation.diffs.map((diff, index) => (
          <ToolDiffBlock
            key={`${diff.path}-${String(index)}`}
            diff={diff}
            showHeader={invocation.diffs.length > 1}
            separated={index > 0}
          />
        ))}
      </View>,
    );
  }

  if (invocation.terminals.length > 0) {
    addSection(
      'terminal-response',
      <>
        <Text style={styles.sectionLabel}>Response</Text>
        {invocation.terminals.map((terminal, index) => (
          <View
            key={`${terminal.terminalId ?? 'terminal'}-${String(index)}`}
            style={[styles.outputSurface, styles.consoleSurface]}
          >
            {splitLines(terminal.output).map((line, lineIndex) => (
              <SelectableMessageText key={`line-${String(lineIndex)}`} style={styles.outputLine}>
                {line}
              </SelectableMessageText>
            ))}
          </View>
        ))}
      </>,
    );
  }

  const imageElements = invocation.images.flatMap((image, index) => {
    const source = toMarkdownImageSource(image, bridgeUrl, bridgeToken);
    return source ? [<MarkdownImage key={`image-${String(index)}`} source={source} />] : [];
  });
  if (imageElements.length > 0) {
    addSection('images', imageElements);
  }

  if (invocation.textLines.length > 0) {
    addSection(
      'text-response',
      <>
        <Text style={styles.sectionLabel}>Response</Text>
        <View style={styles.outputSurface}>
          {invocation.textLines.map((line, index) => (
            <SelectableMessageText key={`text-${String(index)}`} style={styles.outputLine}>
              {line}
            </SelectableMessageText>
          ))}
        </View>
      </>,
    );
  }

  if (invocation.truncated && !hasUnavailableDiff) {
    addSection(
      'truncated',
      <Text style={invocation.diffs.length > 0 ? styles.errorNote : styles.note}>
        {invocation.kind === 'edit' || invocation.diffs.length > 0
          ? 'Diff too large to display completely.'
          : 'Output truncated by the bridge.'}
      </Text>,
    );
  }

  if (sections.length === 0) {
    return null;
  }
  const panel = (
    <View testID="tool-output-panel" style={styles.panel}>
      {sections}
    </View>
  );
  if (renderedLineCount(invocation) <= SCROLL_LINE_THRESHOLD) {
    return panel;
  }
  return (
    <ScrollView
      style={styles.panelScroll}
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator
    >
      {panel}
    </ScrollView>
  );
}

function ToolDiffBlock({
  diff,
  showHeader,
  separated,
}: {
  diff: ToolInvocationDiff;
  showHeader: boolean;
  separated: boolean;
}): ReactElement {
  const theme = useAppTheme();
  const styles = useMemo(() => createToolCardStyles(theme), [theme]);
  const stats = compactToolDiff(diff);
  const syntax = useMemo(
    () => resolveSyntaxLanguage(syntaxLanguageFromPath(diff.path)),
    [diff.path],
  );
  const highlightedLines = useMemo(
    () => highlightDiffCodeLines(stats.lines, syntax.grammar),
    [stats.lines, syntax.grammar],
  );
  const overflow = useHorizontalOverflow();
  const fadeSurface = compositeOverlayColor(theme.colors.bgMain, theme.colors.bgCanvasAccent);
  return (
    <View
      style={[styles.diffBlock, separated && styles.diffBlockSeparated]}
      testID="tool-diff-block"
    >
      {showHeader ? (
        <View style={styles.diffFileHeader}>
          <Text style={styles.diffFilePath} numberOfLines={1} accessibilityLabel={diff.path}>
            {diff.path}
          </Text>
          <View style={styles.diffStats}>
            {stats.additions > 0 ? (
              <Text
                style={[styles.diffStat, styles.diffAddedStat]}
                accessibilityLabel={formatChangedLineCount(stats.additions, 'added')}
              >
                +{String(stats.additions)}
              </Text>
            ) : null}
            {stats.deletions > 0 ? (
              <Text
                style={[styles.diffStat, styles.diffRemovedStat]}
                accessibilityLabel={formatChangedLineCount(stats.deletions, 'removed')}
              >
                -{String(stats.deletions)}
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {stats.unavailable ? (
        <Text style={[styles.errorNote, styles.diffBlockNote]}>Diff too large to display.</Text>
      ) : (
        <View style={styles.diffScrollFrame}>
          <ScrollView
            horizontal
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.diffScrollContent}
            onLayout={overflow.onLayout}
            onContentSizeChange={overflow.onContentSizeChange}
            onScroll={overflow.onScroll}
            scrollEventThrottle={16}
            testID="tool-diff-scroll"
          >
            <View style={styles.diffLines}>
              {stats.lines.map((line, index) => (
                <View
                  key={`${line.kind}-${String(index)}`}
                  style={[
                    styles.diffLine,
                    line.kind === 'add' && styles.diffLineAdded,
                    line.kind === 'remove' && styles.diffLineRemoved,
                  ]}
                  accessible={line.kind !== 'context'}
                  accessibilityLabel={
                    line.kind === 'add'
                      ? `Added line: ${line.content}`
                      : line.kind === 'remove'
                        ? `Removed line: ${line.content}`
                        : undefined
                  }
                >
                  <Text
                    style={[
                      styles.diffLineMarker,
                      line.kind === 'add' && styles.diffLineMarkerAdded,
                      line.kind === 'remove' && styles.diffLineMarkerRemoved,
                    ]}
                    accessible={false}
                    testID={`tool-diff-marker-${line.kind}`}
                  >
                    {line.prefix}
                  </Text>
                  <SelectableMessageText style={styles.diffLineText}>
                    {renderSyntaxTokens(
                      highlightedLines[index] ?? (line.content || ' '),
                      styles,
                      `diff-line-${String(index)}`,
                    )}
                  </SelectableMessageText>
                </View>
              ))}
            </View>
          </ScrollView>
          {overflow.showEndFade ? (
            <LinearGradient
              colors={horizontalFadeColors(fadeSurface)}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              pointerEvents="none"
              style={styles.horizontalOverflowFade}
              testID="tool-diff-overflow-fade"
            />
          ) : null}
        </View>
      )}
      {stats.omittedChangedLines > 0 ? (
        <Text style={[styles.note, styles.diffBlockNote]}>
          {String(stats.omittedChangedLines)} additional changed lines omitted.
        </Text>
      ) : null}
    </View>
  );
}

function formatChangedLineCount(count: number, kind: 'added' | 'removed'): string {
  return `${String(count)} ${count === 1 ? 'line' : 'lines'} ${kind}`;
}

function locationsNotRepeatedInHeader(
  invocation: ToolInvocation,
  headerLabel: string,
): ToolInvocation['locations'] {
  if (invocation.locations.length !== 1) {
    return invocation.locations;
  }
  const location = invocation.locations[0];
  if (!location) {
    return invocation.locations;
  }
  const label =
    location.line === undefined ? location.path : `${location.path}:${String(location.line)}`;
  const normalizedHeader = headerLabel.toLowerCase();
  const normalizedLabel = label.toLowerCase();
  const labelIsFullyVisible = normalizedLabel.length <= 24;
  const labelEndsHeader =
    normalizedHeader === normalizedLabel || normalizedHeader.endsWith(` ${normalizedLabel}`);
  return labelIsFullyVisible && labelEndsHeader ? [] : invocation.locations;
}

function renderedLineCount(invocation: ToolInvocation): number {
  return (
    invocation.textLines.length +
    invocation.terminals.reduce(
      (total, terminal) => total + splitLines(terminal.output).length,
      0,
    ) +
    invocation.diffs.reduce((total, diff) => total + compactToolDiff(diff).lines.length, 0)
  );
}

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
