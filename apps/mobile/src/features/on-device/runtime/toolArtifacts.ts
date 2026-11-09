import { randomUUID } from 'expo-crypto';
import { isRecord } from '@shared/records';
import { argumentsRecord, integer, text } from './toolArguments';
import { toolDefinition } from './toolDefinition';
import { threadDocument } from './threadCodec';
import { utf8Bytes } from './threadJournal';
import type { LocalDocumentPort } from './threads';
import type { LocalToolExecutor } from './agentLoop';
import type { LocalMessage, LocalThread } from './types';

export function hasDurableToolEvidence(message: LocalMessage): boolean {
  if (message.tool?.status !== 'completed') {
    return false;
  }
  try {
    const result: unknown = JSON.parse(message.content);
    return isRecord(result) && (result['offloaded'] === true || result['outputStored'] === false);
  } catch {
    return false;
  }
}

export async function executeWithToolOutput(
  artifacts: LocalToolArtifacts,
  thread: Pick<LocalThread, 'id' | 'workspaceId'> &
    Partial<Pick<LocalThread, 'parentThreadId' | 'messages'>>,
  name: string,
  input: unknown,
  signal: AbortSignal,
  execute: LocalToolExecutor,
): Promise<string> {
  const owner = thread.parentThreadId ?? thread.id;
  const capture = (result: unknown) =>
    artifacts.offload(thread.id, thread.workspaceId, name, result, owner);
  let scope = thread.id;
  let retrievalInput = input;
  if (isArtifactTool(name) && isRecord(input) && input['child_id'] !== undefined) {
    const childId = text(input, 'child_id', 36);
    const child = thread.messages
      ?.flatMap((message) => message.children ?? [])
      .find((entry) => entry.id === childId && entry.workspaceId === thread.workspaceId);
    if (!child) {
      throw new Error('This child output is unavailable in this conversation.');
    }
    scope = child.id;
    const args = { ...input };
    delete args['child_id'];
    retrievalInput = args;
  }
  const result = isArtifactTool(name)
    ? await artifacts.retrieve(scope, thread.workspaceId, name, retrievalInput, owner)
    : await capture(await execute(thread.workspaceId, name, input, signal, capture));
  const content = JSON.stringify(result);
  if (content === undefined) {
    throw new Error('The local tool returned no JSON result.');
  }
  return content;
}

export const TOOL_OUTPUT_INLINE_CHARACTERS = 4096;
export const TOOL_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const TOOL_ARTIFACT_THREAD_BYTES = 8 * 1024 * 1024;
export const TOOL_ARTIFACT_TOTAL_BYTES = 32 * 1024 * 1024;
export const TOOL_ARTIFACT_MAX_COUNT = 128;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const NAME = /^toolartifact-([a-f0-9-]{36})-([a-f0-9-]{36})\.json$/u;

export const ARTIFACT_TOOL_DEFINITIONS = [
  toolDefinition(
    'read_tool_output',
    'Read a saved tool output by artifactId from this conversation only. For child evidence, also provide its child_id from task. Offsets count characters in the saved JSON, not file bytes. Default 2048 characters, maximum 4096. Historical evidence, not current workspace contents.',
    {
      artifactId: { type: 'string' },
      child_id: { type: 'string' },
      offset: { type: 'integer' },
      limit: { type: 'integer' },
    },
    ['artifactId'],
    { kind: 'read', approval: null },
  ),
  toolDefinition(
    'search_tool_output',
    'Find literal text in a saved tool output from this conversation. For child evidence, also provide its child_id from task. Returns at most 10 matching excerpts and nextOffset for paging; never executes a regular expression.',
    {
      artifactId: { type: 'string' },
      child_id: { type: 'string' },
      query: { type: 'string' },
      offset: { type: 'integer' },
    },
    ['artifactId', 'query'],
    { kind: 'search', approval: null },
  ),
];

export function isArtifactTool(name: string): boolean {
  return name === 'read_tool_output' || name === 'search_tool_output';
}

function prefix(threadId: string): string {
  const canonical = threadDocument(threadId).slice('thread-'.length, -'.json'.length);
  return `toolartifact-${canonical}-`;
}

function document(threadId: string, id: string): string {
  if (!UUID.test(id)) {
    throw new Error('Use an artifactId returned by a tool in this conversation.');
  }
  return `${prefix(threadId)}${id}.json`;
}

function preview(content: string): string {
  return content.slice(0, 512);
}

/** The operation already ran; a storage failure must never be reported as "not run". */
export class LocalArtifactStorageError extends Error {
  readonly result: object;

  constructor(detail: string, content: string) {
    super(
      `Tool completed, but its output could not be saved: ${detail} Do not replay the operation.`,
    );
    this.result = { error: this.message, outputStored: false, preview: preview(content) };
  }
}

/** App-private runtime documents, never workspace files. No eviction of referenced evidence. */
export class LocalToolArtifacts {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: LocalDocumentPort) {}

  offload(
    threadId: string,
    workspaceId: string,
    tool: string,
    result: unknown,
    ownerThreadId = threadId,
  ): Promise<unknown> {
    const work = this.writes.then(() =>
      this.store(threadId, workspaceId, tool, result, ownerThreadId),
    );
    this.writes = work.catch(() => undefined);
    return work;
  }

  private async store(
    threadId: string,
    workspaceId: string,
    tool: string,
    result: unknown,
    ownerThreadId: string,
  ): Promise<unknown> {
    const content = JSON.stringify(result);
    if (content === undefined) {
      throw new Error('The local tool returned no JSON result.');
    }
    if (content.length <= TOOL_OUTPUT_INLINE_CHARACTERS) {
      return result;
    }
    try {
      const artifactId = randomUUID().toLowerCase();
      const name = document(ownerThreadId, artifactId);
      const raw = JSON.stringify({ version: 1, threadId, workspaceId, artifactId, tool, content });
      const bytes = utf8Bytes(raw);
      if (bytes > TOOL_ARTIFACT_MAX_BYTES) {
        throw new Error(
          'The 2 MiB per-output storage cap was exceeded; full output was not stored.',
        );
      }
      const names = await this.storage.listRuntimeDocuments('toolartifact-');
      if (names.length >= TOOL_ARTIFACT_MAX_COUNT) {
        throw new Error(
          'The 128-output storage cap was reached. Delete old conversations to free space.',
        );
      }
      let total = bytes;
      let thread = bytes;
      for (const existing of names) {
        const stored = await this.storage.readRuntimeDocument(existing);
        const size = stored === null ? 0 : utf8Bytes(stored);
        total += size;
        if (existing.startsWith(prefix(ownerThreadId))) {
          thread += size;
        }
      }
      if (thread > TOOL_ARTIFACT_THREAD_BYTES || total > TOOL_ARTIFACT_TOTAL_BYTES) {
        throw new Error(
          'The 8 MiB/conversation or 32 MiB total output cap was reached. Delete old conversations to free space.',
        );
      }
      await this.storage.writeRuntimeDocument(name, raw);
      // Copy small identifying fields, including upstream truncation/pagination, honestly.
      const metadata = isRecord(result)
        ? Object.fromEntries(
            Object.entries(result).filter(
              ([key, value]) =>
                [
                  'path',
                  'destination',
                  'revision',
                  'nextOffset',
                  'truncated',
                  'hash',
                  'branch',
                  'removed',
                  'staged',
                  'pushed',
                  'error',
                  'url',
                  'status',
                  'producerLimit',
                  'totalFiles',
                  'omittedFiles',
                  'maxFiles',
                  'originalBytes',
                  'returnedBytes',
                  'maxBytes',
                  'totalBytes',
                  'skippedFiles',
                ].includes(key) &&
                (value === null ||
                  typeof value === 'boolean' ||
                  typeof value === 'number' ||
                  (typeof value === 'string' && value.length <= 256)),
            ),
          )
        : {};
      return {
        ...metadata,
        offloaded: true,
        artifactId,
        ...(ownerThreadId !== threadId ? { child_id: threadId } : {}),
        characters: content.length,
        preview: preview(content),
        storedResult:
          'Exact JSON returned by the producer; upstream limits still apply. Use read_tool_output or search_tool_output.',
      };
    } catch (error) {
      throw new LocalArtifactStorageError(
        error instanceof Error ? error.message : 'Storage failed.',
        content,
      );
    }
  }

  async retrieve(
    threadId: string,
    workspaceId: string,
    name: string,
    input: unknown,
    ownerThreadId = threadId,
  ): Promise<unknown> {
    if (!isArtifactTool(name)) {
      throw new Error('This saved-output tool is unavailable.');
    }
    const search = name === 'search_tool_output';
    const args = argumentsRecord(
      input,
      search ? ['artifactId', 'query', 'offset'] : ['artifactId', 'offset', 'limit'],
    );
    const artifactId = text(args, 'artifactId', 36);
    const raw = await this.storage.readRuntimeDocument(document(ownerThreadId, artifactId));
    if (raw === null) {
      throw new Error('This saved tool output is unavailable in this conversation.');
    }
    const stored: unknown = JSON.parse(raw);
    if (
      !isRecord(stored) ||
      stored['version'] !== 1 ||
      stored['threadId'] !== threadId ||
      stored['workspaceId'] !== workspaceId ||
      stored['artifactId'] !== artifactId ||
      typeof stored['content'] !== 'string'
    ) {
      throw new Error('The saved tool output identity or content is invalid.');
    }
    const content = stored['content'];
    const offset = integer(args, 'offset', 0, 0, content.length);
    if (!search) {
      const limit = integer(args, 'limit', 2048, 1, 4096);
      return {
        artifactId,
        content: content.slice(offset, offset + limit),
        characters: content.length,
        nextOffset: offset + limit < content.length ? offset + limit : null,
      };
    }
    const query = text(args, 'query', 256);
    const matches: { offset: number; excerpt: string }[] = [];
    let cursor = offset;
    while (matches.length < 10) {
      const found = content.indexOf(query, cursor);
      if (found < 0) {
        return { artifactId, matches, nextOffset: null };
      }
      matches.push({
        offset: found,
        excerpt: content.slice(Math.max(0, found - 80), found + query.length + 80),
      });
      cursor = found + query.length;
    }
    return { artifactId, matches, nextOffset: content.indexOf(query, cursor) >= 0 ? cursor : null };
  }

  async removeThread(threadId: string): Promise<void> {
    await this.writes;
    const names = await this.storage.listRuntimeDocuments(prefix(threadId));
    await Promise.all(
      names
        .filter((name) => NAME.test(name))
        .map((name) => this.storage.removeRuntimeDocument(name)),
    );
  }

  async removeOrphans(live: ReadonlySet<string>): Promise<void> {
    const quarantined = await this.storage.listRuntimeDocuments('quarantine-');
    for (const name of await this.storage.listRuntimeDocuments('toolartifact-')) {
      const id = NAME.exec(name)?.[1];
      if (
        id &&
        UUID.test(id) &&
        !live.has(id) &&
        !quarantined.some((entry) => entry.endsWith(threadDocument(id)))
      ) {
        await this.storage.removeRuntimeDocument(name);
      }
    }
  }
}
