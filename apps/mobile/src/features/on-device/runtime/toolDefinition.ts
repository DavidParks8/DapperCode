import type { ChatToolKind } from '@bridge/types/types';

export interface LocalToolPermission {
  kind: ChatToolKind;
  summary: string;
}

interface LocalToolMetadata {
  kind: ChatToolKind;
  approval: ((input: unknown) => string) | null;
}

export function toolDefinition<const Name extends string>(
  name: Name,
  description: string,
  properties: Record<string, object>,
  required: string[],
  metadata: LocalToolMetadata,
) {
  return {
    ...metadata,
    definition: {
      type: 'function' as const,
      function: {
        name,
        description,
        parameters: { type: 'object', properties, required, additionalProperties: false },
      },
    },
  };
}

export function toolDefinitionName(definition: object): string {
  return (definition as { function: { name: string } }).function.name;
}

/**
 * The smallest loaded context at which a tool is advertised; unlisted tools always are. 4K contexts
 * keep a measured core (file list/read/write/edit/search, Git status/diff, skill, saved-output
 * retrieval, todo_read) so a default file read still fits beside the fixed prompt. Advertisement only
 * narrows the registered, dispatchable set (docs/on-device.md).
 */
const TOOL_MIN_CONTEXT_TOKENS: Readonly<Record<string, number>> = {
  ask_user: 8192,
  todo_write: 8192,
  glob_files: 8192,
  apply_patch: 8192,
  rename_path: 8192,
  delete_path: 8192,
  git_history: 8192,
  git_stage: 8192,
  git_commit: 8192,
  git_push: 8192,
  web_fetch: 8192,
  web_search: 8192,
  code_diagnostics: 16_384,
  code_definitions: 16_384,
  code_references: 16_384,
  code_symbols: 16_384,
  format_file: 16_384,
  task: 16_384,
  read_child: 16_384,
};

export function localToolAdvertised(name: string, contextTokens: number): boolean {
  return contextTokens >= (TOOL_MIN_CONTEXT_TOKENS[name] ?? 0);
}

export function advertisedLocalTools(
  definitions: readonly object[],
  contextTokens: number,
): object[] {
  return definitions.filter((definition) =>
    localToolAdvertised(toolDefinitionName(definition), contextTokens),
  );
}
