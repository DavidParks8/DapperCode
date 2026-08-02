import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { ScrollView, TextInput, View, type ViewProps } from 'react-native';

/**
 * Test double for `@gorhom/bottom-sheet`.
 *
 * The real sheet is driven by reanimated worklets, which the suite already replaces with hand
 * written mocks. This double keeps the imperative `present()` / `dismiss()` contract so sheet
 * content is mounted exactly when it is on screen, letting tests assert on the content itself.
 *
 * Register it from a test with:
 * `jest.mock('@gorhom/bottom-sheet', () => require('@shared/testing/bottomSheetMock'));`
 */

export interface MockBottomSheetModalProps extends ViewProps {
  children?: ReactNode;
  onDismiss?: () => void;
}

export interface MockBottomSheetModalHandle {
  present: () => void;
  dismiss: () => void;
  close: () => void;
  forceClose: () => void;
  expand: () => void;
  collapse: () => void;
  snapToIndex: (index: number) => void;
  snapToPosition: (position: number | string) => void;
}

export const BottomSheetModal = forwardRef<MockBottomSheetModalHandle, MockBottomSheetModalProps>(
  function BottomSheetModal({ children, onDismiss, ...viewProps }, ref) {
    const [presented, setPresented] = useState(false);
    const statusRef = useRef<'initial' | 'presented' | 'wedged'>('initial');

    useImperativeHandle(ref, () => {
      const close = () => {
        if (statusRef.current !== 'presented') {
          // This mirrors @gorhom/bottom-sheet 5.2.11+: dismissing an unpresented modal leaves
          // later present() calls as silent no-ops.
          statusRef.current = 'wedged';
          return;
        }
        statusRef.current = 'initial';
        setPresented(false);
        onDismiss?.();
      };
      return {
        present: () => {
          if (statusRef.current === 'wedged') {
            return;
          }
          statusRef.current = 'presented';
          setPresented(true);
        },
        dismiss: close,
        close,
        forceClose: close,
        expand: () => {
          if (statusRef.current !== 'wedged') {
            statusRef.current = 'presented';
            setPresented(true);
          }
        },
        collapse: () => undefined,
        snapToIndex: () => undefined,
        snapToPosition: () => undefined,
      };
    }, [onDismiss]);

    if (!presented) {
      return null;
    }
    return <View {...viewProps}>{children}</View>;
  },
);

export const BottomSheet = BottomSheetModal;

export function BottomSheetModalProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function BottomSheetView({ children, ...viewProps }: ViewProps & { children?: ReactNode }) {
  return <View {...viewProps}>{children}</View>;
}

export const BottomSheetScrollView = ScrollView;

export const BottomSheetTextInput = TextInput;

export function BottomSheetBackdrop(props: ViewProps) {
  return <View {...props} />;
}

export function BottomSheetFooter({ children }: { children?: ReactNode }) {
  return <View>{children}</View>;
}

export default BottomSheetModal;
