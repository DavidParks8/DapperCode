import { View, type ViewProps } from 'react-native';
import type { PastedImage } from './controllers/attachmentUploadController';

export interface ComposerPasteViewProps extends ViewProps {
  enabled: boolean;
  scopeKey: string;
  onPasteImage?: (event: { nativeEvent: PastedImage }) => void;
  onPasteBusy?: (event: { nativeEvent: { busy: boolean; scopeKey: string } }) => void;
  onPasteError?: (event: { nativeEvent: { message: string; scopeKey: string } }) => void;
}

// The web composer retains ordinary browser text paste.
export function ComposerPasteView({ style, children }: ComposerPasteViewProps) {
  return <View style={style}>{children}</View>;
}
