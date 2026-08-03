import { useMemo, type ReactElement, type ReactNode } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { useAppTheme } from '@shared/theme';
import { toMarkdownImageSource } from './imageSource';
import { MarkdownImage, SelectableMessageText } from './Primitives';
import { createToolCardStyles } from './toolCardStyles';
import type { ToolInvocation, ToolInvocationDiff } from './toolInvocationModel';
import { compactToolDiff } from './toolInvocationPresentation';

const SCROLL_LINE_THRESHOLD = 24;
const MAX_LOCATION_CHIPS = 8;

export function ToolInvocationOutput({
  invocation,
  bridgeUrl,
  bridgeToken,
}: {
  invocation: ToolInvocation;
  bridgeUrl: string | null;
  bridgeToken: string | null;
}): ReactElement | null {
  const theme = useAppTheme();
  const styles = useMemo(() => createToolCardStyles(theme), [theme]);
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

  if (invocation.locations.length > 0) {
    const shown = invocation.locations.slice(0, MAX_LOCATION_CHIPS);
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
          {invocation.locations.length > shown.length ? (
            <Text style={styles.note}>
              +{String(invocation.locations.length - shown.length)} more
            </Text>
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

  if (invocation.truncated) {
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
  return (
    <View>
      {separated ? <View style={styles.panelDivider} /> : null}
      {showHeader ? (
        <View style={styles.diffFileHeader}>
          <Text style={styles.diffFilePath} numberOfLines={1} accessibilityLabel={diff.path}>
            {diff.path}
          </Text>
          <View style={styles.diffStats}>
            {stats.additions > 0 ? (
              <Text style={styles.diffAddedStat}>+{String(stats.additions)}</Text>
            ) : null}
            {stats.deletions > 0 ? (
              <Text style={styles.diffRemovedStat}>-{String(stats.deletions)}</Text>
            ) : null}
          </View>
        </View>
      ) : null}
      {stats.unavailable ? (
        <Text style={styles.errorNote}>Diff too large to display.</Text>
      ) : (
        <ScrollView
          horizontal
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator
          contentContainerStyle={styles.diffScrollContent}
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
              >
                <SelectableMessageText
                  style={[
                    styles.diffLineText,
                    line.kind === 'add' && styles.diffLineTextAdded,
                    line.kind === 'remove' && styles.diffLineTextRemoved,
                  ]}
                >
                  {`${line.prefix} ${line.content}`}
                </SelectableMessageText>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      {stats.omittedChangedLines > 0 ? (
        <Text style={styles.note}>
          {String(stats.omittedChangedLines)} additional changed lines omitted.
        </Text>
      ) : null}
    </View>
  );
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
