// The bottom sheet is driven by reanimated worklets, which have no native side under Jest.
// Every suite that renders a sheet gets the same lightweight double so tests can assert on the
// sheet's content instead of its animation machinery.
jest.mock('@gorhom/bottom-sheet', () => require('./src/testing/bottomSheetMock'));

beforeEach(() => {
  require('./src/testing/expoRouterMock').resetRouterMock();
});
