import renderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import type { BridgeScheduledPrompt } from '@bridge/types/types';
import { AppThemeProvider, createAppTheme } from '@shared/theme';
import {
  formatScheduledPromptTime,
  ScheduledPromptDock,
  scheduledPromptStatusPresentation,
  selectEarliestScheduledPrompt,
} from './ScheduledPromptDock';

jest.mock('@expo/vector-icons', () => ({ Ionicons: ({ name }: { name: string }) => name }));

const theme = createAppTheme('dark');
const now = new Date(2026, 7, 29, 14, 0);

type Queryable = ReactTestInstance & {
  props: Record<string, unknown>;
  findAll(predicate: (node: Queryable) => boolean): Queryable[];
};

function toJson(tree: ReactTestRenderer): unknown {
  return (tree as unknown as { toJSON: () => unknown }).toJSON();
}

function schedule(overrides: Partial<BridgeScheduledPrompt> = {}): BridgeScheduledPrompt {
  return {
    scheduleId: 'schedule-1',
    threadId: 'thread-1',
    promptPreview: 'Review the release checklist.',
    promptBytes: 29,
    scheduledFor: new Date(2026, 7, 30, 9, 0).toISOString(),
    createdAt: now.toISOString(),
    status: 'scheduled',
    retryAttempt: 0,
    ...overrides,
  };
}

function renderDock(scheduledPrompts: BridgeScheduledPrompt[]): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <AppThemeProvider theme={theme}>
        <ScheduledPromptDock scheduledPrompts={scheduledPrompts} now={now} locale="en-US" />
      </AppThemeProvider>,
    );
  });
  if (!tree) {
    throw new Error('Expected scheduled prompt dock to render');
  }
  return tree;
}

describe('ScheduledPromptDock', () => {
  it('hides when there are no pending schedules', () => {
    const tree = renderDock([]);
    expect(toJson(tree)).toBeNull();
    act(() => tree.unmount());
  });

  it('selects the earliest schedule and presents one-line preview, count, time, and accessibility', () => {
    const later = schedule({
      scheduleId: 'later',
      promptPreview: 'This later prompt stays hidden.',
      scheduledFor: new Date(2026, 7, 31, 9, 0).toISOString(),
    });
    const earlier = schedule({
      scheduleId: 'earlier',
      promptPreview: 'Run checks\nand report back.',
    });
    expect(selectEarliestScheduledPrompt([later, earlier])?.scheduleId).toBe('earlier');

    const tree = renderDock([later, earlier]);
    const root = tree.root as Queryable;
    const serialized = JSON.stringify(toJson(tree));
    expect(serialized).toContain('Scheduled for Tomorrow, 9:00 AM');
    expect(serialized).toContain('Run checks and report back.');
    expect(serialized).toContain('+1 more');
    expect(serialized).not.toContain('This later prompt stays hidden.');
    const preview = root.findAll(
      (node) => node.props['ellipsizeMode'] === 'tail' && node.props['numberOfLines'] === 1,
    )[0];
    expect(preview?.props['children']).toBe('Run checks and report back.');
    const accessible = root.findAll(
      (node) =>
        node.props['accessible'] === true && typeof node.props['accessibilityLabel'] === 'string',
    )[0];
    expect(accessible?.props['accessibilityLabel']).toContain(
      'Scheduled prompt. Scheduled for Tomorrow, 9:00 AM',
    );
    expect(accessible?.props['accessibilityLabel']).toContain('+1 more');
    act(() => tree.unmount());
  });

  it('uses the schedule id as a stable tie breaker', () => {
    const scheduledFor = schedule().scheduledFor;
    expect(
      selectEarliestScheduledPrompt([
        schedule({ scheduleId: 'later-id', scheduledFor }),
        schedule({ scheduleId: 'earlier-id', scheduledFor }),
      ])?.scheduleId,
    ).toBe('earlier-id');
  });

  it.each([
    ['scheduled', 'calendar-outline', 'Scheduled for Tomorrow, 9:00 AM'],
    ['queued', 'time-outline', 'Queued for delivery · Tomorrow, 9:00 AM'],
    ['retrying', 'refresh-outline', 'Retrying delivery · Tomorrow, 9:00 AM'],
  ] as const)('shows compact %s status copy and icon', (status, icon, label) => {
    expect(scheduledPromptStatusPresentation(schedule({ status }), now, 'en-US')).toEqual({
      icon,
      label,
    });
  });

  it('formats relative days when Hermes lacks Intl.RelativeTimeFormat', () => {
    const relativeTimeFormat = Intl.RelativeTimeFormat;
    Object.defineProperty(Intl, 'RelativeTimeFormat', { configurable: true, value: undefined });
    try {
      expect(formatScheduledPromptTime(schedule().scheduledFor, now, 'en-US')).toBe(
        'Tomorrow, 9:00 AM',
      );
    } finally {
      Object.defineProperty(Intl, 'RelativeTimeFormat', {
        configurable: true,
        value: relativeTimeFormat,
      });
    }
  });

  it('formats today and calendar dates with compatible default arguments', () => {
    jest.useFakeTimers().setSystemTime(now);
    try {
      expect(
        formatScheduledPromptTime(new Date(2026, 7, 29, 9, 0).toISOString(), now, 'en-US'),
      ).toBe('Today, 9:00 AM');
      expect(
        formatScheduledPromptTime(new Date(2026, 8, 2, 9, 0).toISOString(), now, 'en-US'),
      ).toBe('Sep 2, 9:00 AM');
      expect(
        formatScheduledPromptTime(new Date(2027, 8, 2, 9, 0).toISOString(), now, 'en-US'),
      ).toBe('Sep 2, 2027, 9:00 AM');
      expect(formatScheduledPromptTime(schedule().scheduledFor)).toContain('Tomorrow');
      expect(scheduledPromptStatusPresentation(schedule()).label).toContain('Tomorrow');
    } finally {
      jest.useRealTimers();
    }
  });
});
