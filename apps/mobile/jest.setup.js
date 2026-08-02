// The bottom sheet is driven by reanimated worklets, which have no native side under Jest.
// Every suite that renders a sheet gets the same lightweight double so tests can assert on the
// sheet's content instead of its animation machinery.
jest.mock('@gorhom/bottom-sheet', () => require('./src/testing/bottomSheetMock'));
jest.mock('react-native-reanimated', () => require('./src/testing/reanimatedMock'));
jest.mock('react-native-worklets', () => require('./src/testing/workletsMock'));
jest.mock('react-native-gesture-handler', () => require('./src/testing/gestureHandlerMock'));
jest.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
  impactAsync: jest.fn(() => Promise.resolve()),
  notificationAsync: jest.fn(() => Promise.resolve()),
  selectionAsync: jest.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  require('./src/testing/expoRouterMock').resetRouterMock();
});
