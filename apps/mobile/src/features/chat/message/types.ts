import type { ImageSourcePropType, TextProps } from 'react-native';

import type { ChatMessage as ApiChatMessage } from '@bridge/types/types';

export interface ChatMessageProps {
  message: ApiChatMessage;
  bridgeUrl?: string | null;
  bridgeToken?: string | null;
  onOpenLocalPreview?: (targetUrl: string) => void;
  onOpenSubAgentThread?: (threadId: string) => void;
  onForkConversation?: () => void;
  forkBusy?: boolean;
}

export interface TimelineEntry {
  title: string;
  details: string[];
}

export interface ToolGroupEntry extends TimelineEntry {
  id: string;
}

export interface TimelineDetailMediaPreview {
  source: ImageSourcePropType;
  accessibilityLabel?: string;
}

export interface TimelineDetailPreview {
  textDetails: string[];
  images: TimelineDetailMediaPreview[];
}

export interface ScrollableRowTextProps {
  children: string;
  style: TextProps['style'];
  backgroundColor: string;
  numberOfLines?: number;
  testID?: string;
}

export type MessageBlock =
  | { kind: 'text'; value: string }
  | { kind: 'file'; value: string }
  | { kind: 'image'; source: ImageSourcePropType; accessibilityLabel?: string };
