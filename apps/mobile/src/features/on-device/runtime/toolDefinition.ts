export function toolDefinition<const Name extends string>(
  name: Name,
  description: string,
  properties: Record<string, object>,
  required: string[],
) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}
