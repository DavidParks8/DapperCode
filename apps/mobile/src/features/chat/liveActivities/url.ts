export function createAgentTurnActivityUrl(profileId: string, threadId: string): string {
  return `dappercode:///profiles/${encodeURIComponent(profileId)}/chats/${encodeURIComponent(
    threadId,
  )}`;
}
