import {
  shouldReleaseOpeningChat,
  shouldScrollAfterLoad,
} from './mainScreenOpeningChatState';

/**
 * Reproduces "some sessions wouldn't load (were stuck infinitely loading)".
 *
 * Opening a chat and revalidating it can overlap. The load that actually rendered the
 * transcript used to abandon its cleanup as soon as a newer request existed, which left the
 * spinner owned by a request that might not answer for the full request timeout.
 */
describe('Opening chat spinner ownership', () => {
  it('releases the spinner when the load rendered a transcript, even once superseded', () => {
    expect(
      shouldReleaseOpeningChat({ loadedSuccessfully: true, superseded: true })
    ).toBe(true);
  });

  it('releases the spinner when the newest load finished without a transcript', () => {
    expect(
      shouldReleaseOpeningChat({ loadedSuccessfully: false, superseded: false })
    ).toBe(true);
  });

  it('leaves the spinner to the newer request when a superseded load rendered nothing', () => {
    expect(
      shouldReleaseOpeningChat({ loadedSuccessfully: false, superseded: true })
    ).toBe(false);
  });

  it('never scrolls the transcript on behalf of a superseded load', () => {
    expect(shouldScrollAfterLoad({ loadedSuccessfully: true, superseded: true })).toBe(
      false
    );
    expect(shouldScrollAfterLoad({ loadedSuccessfully: true, superseded: false })).toBe(
      true
    );
    expect(shouldScrollAfterLoad({ loadedSuccessfully: false, superseded: false })).toBe(
      false
    );
  });
});
