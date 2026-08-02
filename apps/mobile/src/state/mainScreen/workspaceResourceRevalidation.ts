export const WORKSPACE_RESOURCES_TTL_MS = 30_000;

export interface WorkspaceResourceRevalidationOptions {
  force?: boolean;
  now?: number;
  ttlMs?: number;
}

export function shouldUseFreshResource(
  fetchedAt: number | null,
  {
    force = false,
    now = Date.now(),
    ttlMs = WORKSPACE_RESOURCES_TTL_MS,
  }: WorkspaceResourceRevalidationOptions,
): boolean {
  return !force && fetchedAt !== null && now - fetchedAt < ttlMs;
}
