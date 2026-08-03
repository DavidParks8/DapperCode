import { Provider, createStore } from 'jotai';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { MainScreenView } from './View';

jest.mock('./HeaderAndWorkflow', () => {
  const mockReact = jest.requireActual('react');
  const { View: NativeView } = jest.requireActual('react-native');

  return {
    MainScreenHeaderAndWorkflow: () =>
      mockReact.createElement(NativeView, { testID: 'top-chrome-content' }),
  };
});
jest.mock('../transcript/TranscriptAndSheets', () => {
  const { useAtomValue: readAtom } = jest.requireActual('jotai');
  const { Text: NativeText } = jest.requireActual('react-native');
  const { topChromeHeightAtom: measuredTopChromeHeightAtom } =
    jest.requireActual('../state/composer');

  return {
    MainScreenTranscriptAndSheets: () => {
      const topInset = readAtom(measuredTopChromeHeightAtom);
      return <NativeText testID="transcript-top-inset">{String(topInset)}</NativeText>;
    },
  };
});
jest.mock('./RenameSheet', () => ({ MainScreenRenameSheet: () => null }));
jest.mock('../composer/AttachmentModals', () => ({ MainScreenAttachmentModals: () => null }));
jest.mock('../approvals/BridgePrompts', () => ({
  MainScreenApprovalAndBridgePrompts: () => null,
}));
jest.mock('../models/ModelAndEffortSheets', () => ({ MainScreenModelAndEffortSheets: () => null }));
jest.mock('../styles/useStyles', () => ({
  useMainScreenStyles: () => ({
    styles: {
      container: {},
      topChromeOverlay: {},
    },
  }),
}));

function renderScreen(): ReactTestRenderer {
  let tree: ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(
      <Provider store={createStore()}>
        <MainScreenView context={{} as never} />
      </Provider>,
    );
  });
  if (!tree) {
    throw new Error('Main screen did not render');
  }
  return tree;
}

function transcriptTopInset(tree: ReactTestRenderer): string {
  return String(tree.root.findByProps({ testID: 'transcript-top-inset' }).props['children']);
}

function reportTopChromeHeight(topChrome: ReactTestRenderer['root'], height: number): void {
  const onLayout = topChrome.props['onLayout'];
  if (typeof onLayout !== 'function') {
    throw new Error('Top chrome does not report layout');
  }
  onLayout({ nativeEvent: { layout: { height } } });
}

describe('MainScreenView', () => {
  it('publishes top-chrome layout changes to the transcript sibling', () => {
    const tree = renderScreen();
    const topChrome = tree.root.findByProps({ testID: 'main-screen-top-chrome' });

    expect(transcriptTopInset(tree)).toBe('0');

    act(() => {
      reportTopChromeHeight(topChrome, 72);
    });
    expect(transcriptTopInset(tree)).toBe('72');

    act(() => {
      reportTopChromeHeight(topChrome, 124);
    });
    expect(transcriptTopInset(tree)).toBe('124');

    act(() => tree.unmount());
  });
});
