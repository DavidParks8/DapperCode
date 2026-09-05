import { requireNativeView } from 'expo';
import type { ComposerPasteViewProps } from './ComposerPasteView';

export const ComposerPasteView = requireNativeView<ComposerPasteViewProps>('ComposerPaste');
