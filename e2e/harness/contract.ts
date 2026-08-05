import { readFileSync } from 'node:fs';
import path from 'node:path';

import { repoRoot } from './paths.ts';

export interface ContractManifest {
  readonly fixtureFormatVersion: number;
  readonly protocolVersion: number;
  readonly bridgeMethods: readonly string[];
  readonly mobileForwardedMethods: readonly string[];
  readonly notifications: readonly string[];
  readonly errors: readonly { readonly code: number; readonly name: string }[];
  readonly fixtures: Record<string, unknown> & {
    readonly capabilities: { readonly protocolVersion: number; readonly streamId: string };
  };
}

/**
 * The canonical bridge contract, shared with the Rust bridge and the mobile client.
 *
 * The harness reads it rather than restating it. `scripts/validate-rpc-contract-fixtures.mjs`
 * already asserts that this manifest matches the real bridge implementation, so anything derived
 * from it inherits that guarantee instead of becoming a fourth, unchecked copy of the protocol.
 */
export const manifest: ContractManifest = JSON.parse(
  readFileSync(path.join(repoRoot, 'contracts/bridge-rpc/v2/manifest.json'), 'utf8'),
) as ContractManifest;

/** Methods the real bridge answers itself, plus those it forwards to an agent. */
export const declaredMethods: ReadonlySet<string> = new Set([
  ...manifest.bridgeMethods,
  ...manifest.mobileForwardedMethods,
]);

export const declaredNotifications: ReadonlySet<string> = new Set(manifest.notifications);

export function errorCode(name: string): number {
  const entry = manifest.errors.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(
      `The bridge contract declares no error named "${name}". ` +
        `Known errors: ${manifest.errors.map((candidate) => candidate.name).join(', ')}.`,
    );
  }
  return entry.code;
}
