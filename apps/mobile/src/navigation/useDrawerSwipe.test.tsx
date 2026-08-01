const mockSetOptions = jest.fn();

jest.mock('expo-router', () => {
  const React = jest.requireActual('react');
  return {
    useNavigation: () => ({ setOptions: mockSetOptions }),
    useFocusEffect: (effect: () => void | (() => void)) => React.useEffect(effect, [effect]),
  };
});

import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { useDisableDrawerSwipe } from './useDrawerSwipe';

function Probe() {
  useDisableDrawerSwipe();
  return null;
}

describe('useDisableDrawerSwipe', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps swipe disabled until the last focused detail route unmounts', () => {
    let tree: ReactTestRenderer | undefined;
    act(() => {
      tree = renderer.create(
        <>
          <Probe />
          <Probe />
        </>,
      );
    });
    expect(mockSetOptions).toHaveBeenLastCalledWith({ swipeEnabled: false });

    act(() => {
      tree?.update(<Probe />);
    });
    expect(mockSetOptions).toHaveBeenLastCalledWith({ swipeEnabled: false });

    act(() => tree?.unmount());
    expect(mockSetOptions).toHaveBeenLastCalledWith({ swipeEnabled: true });
  });
});
