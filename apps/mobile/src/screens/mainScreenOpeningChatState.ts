/**
 * Decides what a finished `loadChat` should do with the "Opening chat" spinner.
 *
 * The spinner is global state keyed by thread id, but loads overlap: opening a chat starts
 * one, and a websocket-driven revalidation of the same chat can start another before the
 * first has finished its minimum-visible delay. The original rule bailed out of the whole
 * cleanup whenever a newer request existed, so a load that had already put a transcript on
 * screen left the spinner running and handed responsibility to a request that might not
 * answer for the full request timeout. That is the "session stuck loading forever" report.
 *
 * The rule that holds instead: a load that produced a transcript always releases the
 * spinner for its own chat, superseded or not, because the chat is open either way. A load
 * that produced nothing only releases the spinner when it is still the newest request, so a
 * failed load for an abandoned chat cannot cancel the spinner of the chat the user moved on
 * to.
 */
export function shouldReleaseOpeningChat(input: {
  loadedSuccessfully: boolean;
  superseded: boolean;
}): boolean {
  return input.loadedSuccessfully || !input.superseded;
}

/**
 * Whether a finished load may scroll the transcript.
 *
 * A superseded load must not move the viewport: the newer request owns what the user is
 * looking at.
 */
export function shouldScrollAfterLoad(input: {
  loadedSuccessfully: boolean;
  superseded: boolean;
}): boolean {
  return input.loadedSuccessfully && !input.superseded;
}
