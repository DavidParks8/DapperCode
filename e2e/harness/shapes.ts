/**
 * Shape conformance for harness responses.
 *
 * The contract manifest declares which methods exist, but not what their payloads look like. That
 * gap is not theoretical: the harness previously answered `bridge/workspaces/list` with
 * `{path, name, isGitRepository}` while the bridge sends `{path, chatCount, updatedAt}`, and every
 * name-level check passed.
 *
 * These helpers close it by borrowing the mobile client's own response types. Those types are the
 * contract the app is written against, and `npm run contract:check` already holds them against the
 * Rust bridge, so a harness payload that satisfies them is a payload the real bridge could send.
 *
 * Passing an object literal is what makes this work: TypeScript then reports both missing fields
 * and excess ones, so a renamed or invented key fails the build instead of silently teaching tests
 * a shape production never produces.
 */
import type {
  BridgeThreadCreateResponse,
  BridgeThreadQueueSendResponse,
  WorkspaceListResponse,
} from '../../apps/mobile/src/bridge/types/chat.ts';

/**
 * Checks `value` against the client-facing type `T` and widens it to a transportable record.
 *
 * Always call this with an inline object literal. Passing a pre-built variable defeats excess
 * property checking, which is the half of this that catches invented fields.
 */
export function conforms<T>(value: T): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

export type { BridgeThreadCreateResponse, BridgeThreadQueueSendResponse, WorkspaceListResponse };
