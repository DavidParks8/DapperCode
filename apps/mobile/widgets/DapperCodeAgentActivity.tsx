import { HStack, Image, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  clipShape,
  containerBackground,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createLiveActivity } from 'expo-widgets';

export type DapperCodeAgentActivityPhase =
  'working' | 'planning' | 'waiting' | 'completed' | 'failed' | 'stopped';

export interface DapperCodeAgentActivityProps {
  phase: DapperCodeAgentActivityPhase;
  startedAtEpochMs: number;
  updatedAtEpochMs: number;
}

const DapperCodeAgentActivity = (props: DapperCodeAgentActivityProps) => {
  'widget';

  const isTerminal =
    props.phase === 'completed' || props.phase === 'failed' || props.phase === 'stopped';
  const label =
    props.phase === 'planning'
      ? 'Planning'
      : props.phase === 'waiting'
        ? 'Waiting'
        : props.phase === 'completed'
          ? 'Completed'
          : props.phase === 'failed'
            ? 'Failed'
            : props.phase === 'stopped'
              ? 'Stopped'
              : 'Working';
  const detail =
    props.phase === 'waiting'
      ? 'The agent needs your attention'
      : isTerminal
        ? `Agent turn ${label.toLowerCase()}`
        : `Agent is ${label.toLowerCase()}`;
  const accent =
    props.phase === 'completed'
      ? '#44D17A'
      : props.phase === 'failed'
        ? '#FF6961'
        : props.phase === 'stopped'
          ? '#FFB347'
          : '#58BEF6';

  const StatusIcon = ({ size }: { size: number }) =>
    props.phase === 'planning' ? (
      <Image systemName="list.bullet.clipboard.fill" size={size} color={accent} />
    ) : props.phase === 'waiting' ? (
      <Image systemName="questionmark.bubble.fill" size={size} color={accent} />
    ) : props.phase === 'completed' ? (
      <Image systemName="checkmark.circle.fill" size={size} color={accent} />
    ) : props.phase === 'failed' ? (
      <Image systemName="xmark.octagon.fill" size={size} color={accent} />
    ) : props.phase === 'stopped' ? (
      <Image systemName="stop.circle.fill" size={size} color={accent} />
    ) : (
      <Image systemName="terminal.fill" size={size} color={accent} />
    );

  return {
    banner: (
      <ZStack
        modifiers={[containerBackground('#0C0F12', 'widget'), clipShape('containerRelativeShape')]}
      >
        <HStack
          spacing={12}
          modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ all: 16 })]}
        >
          <StatusIcon size={24} />
          <VStack alignment="leading" spacing={3}>
            <Text
              modifiers={[font({ weight: 'semibold', size: 13 }), foregroundStyle('#FFFFFFB3')]}
            >
              DapperCode
            </Text>
            <Text modifiers={[font({ weight: 'bold', size: 18 }), foregroundStyle('#FFFFFF')]}>
              {label}
            </Text>
            <Text modifiers={[font({ size: 13 }), foregroundStyle('#FFFFFFB3'), lineLimit(1)]}>
              {detail}
            </Text>
          </VStack>
          <Spacer />
        </HStack>
      </ZStack>
    ),
    compactLeading: <StatusIcon size={15} />,
    compactTrailing: (
      <Text modifiers={[font({ weight: 'semibold', size: 13 }), foregroundStyle(accent)]}>
        {label}
      </Text>
    ),
    minimal: <StatusIcon size={16} />,
    expandedLeading: (
      <HStack spacing={6} modifiers={[padding({ leading: 6 })]}>
        <Image systemName="terminal.fill" size={15} color="#FFFFFF" />
        <Text
          modifiers={[
            font({ weight: 'semibold', size: 14 }),
            foregroundStyle('#FFFFFF'),
            lineLimit(1),
          ]}
        >
          DapperCode
        </Text>
      </HStack>
    ),
    expandedTrailing: (
      <HStack modifiers={[padding({ trailing: 6 })]}>
        <StatusIcon size={18} />
      </HStack>
    ),
    expandedBottom: (
      <VStack
        alignment="leading"
        spacing={4}
        modifiers={[frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ all: 8 })]}
      >
        <Text modifiers={[font({ weight: 'bold', size: 16 }), foregroundStyle('#FFFFFF')]}>
          {label}
        </Text>
        <Text modifiers={[font({ size: 13 }), foregroundStyle('#FFFFFFB3'), lineLimit(1)]}>
          {detail}
        </Text>
      </VStack>
    ),
  };
};

export default createLiveActivity<DapperCodeAgentActivityProps>(
  'DapperCodeAgentActivity',
  DapperCodeAgentActivity,
);
