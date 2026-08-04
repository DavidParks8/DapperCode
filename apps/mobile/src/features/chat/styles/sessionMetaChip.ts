/**
 * Visual height of a session meta chip in the chat top chrome.
 *
 * It is deliberately shorter than a touch target so the selector row stays compact under the
 * header row; `computeHitSlop` restores the effective target.
 *
 * This lives in its own dependency-free module because both the shell and agent style factories
 * need it, and importing one style module from the other creates a require cycle that leaves the
 * binding undefined at module-evaluation time.
 */
export const SESSION_META_CHIP_HEIGHT = 36;
