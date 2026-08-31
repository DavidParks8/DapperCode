// The bottom sheet is driven by reanimated worklets, which have no native side under Jest.
// Every suite that renders a sheet gets the same lightweight double so tests can assert on the
// sheet's content instead of its animation machinery.
jest.mock('@gorhom/bottom-sheet', () => require('@shared/testing/bottomSheetMock'));
jest.mock('react-native-reanimated', () => require('@shared/testing/reanimatedMock'));
jest.mock('react-native-worklets', () => require('@shared/testing/workletsMock'));
jest.mock('react-native-gesture-handler', () => require('@shared/testing/gestureHandlerMock'));
jest.mock('expo-glass-effect', () => require('@shared/testing/glassEffectMock'));
jest.mock('react-native-webview', () => require('@shared/testing/webViewMock'));
jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  require('@shared/testing/expoRouterMock').resetRouterMock();
  require('@shared/testing/glassEffectMock').resetMockGlassEffect();
});
