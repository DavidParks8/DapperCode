/**
 * Like opencode's doom-loop check: the same call this many times in a row is not run, and one more
 * repeat ends the turn.
 */
export const REPEATED_TOOL_CALL_LIMIT = 3;

export function repeatedToolCallError(name: string): string {
  return `Not run: this is the same ${name} call with the same arguments ${String(REPEATED_TOOL_CALL_LIMIT)} times in a row, so its result would not change. Use the earlier result, try a different tool or arguments, or answer.`;
}

const TITLE_LIMIT = 60;

/** The first message's first line, cut at a word boundary when longer than the drawer can show. */
export function localConversationTitle(input: string): string {
  const line = input.trim().split(/\r?\n/u)[0]?.replace(/\s+/gu, ' ').trim() ?? '';
  if (line.length <= TITLE_LIMIT) {
    return line || 'New local conversation';
  }
  const cut = line.slice(0, TITLE_LIMIT - 1);
  const boundary = cut.lastIndexOf(' ');
  const words = boundary >= TITLE_LIMIT / 2 ? cut.slice(0, boundary) : cut;
  return `${words.replace(/[\s.,;:!?-]+$/u, '')}…`;
}
