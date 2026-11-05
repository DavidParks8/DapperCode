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
