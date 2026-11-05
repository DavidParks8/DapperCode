import { LOCAL_TOOL_DEFINITIONS, localToolApproval, localToolKind } from './localTools';
import { toolDefinition } from './toolDefinition';
import { isRecord } from '@shared/records';

test('tool definitions declare metadata separately from model schemas', () => {
  const tool = toolDefinition('custom_tool', 'A custom tool.', {}, [], {
    kind: 'think',
    approval: () => 'Use the custom tool',
  });
  expect(tool).toMatchObject({ kind: 'think', approval: expect.any(Function) });
  expect(tool.definition).toEqual({
    type: 'function',
    function: {
      name: 'custom_tool',
      description: 'A custom tool.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  });
  for (const definition of LOCAL_TOOL_DEFINITIONS) {
    expect(Object.keys(definition)).toEqual(['type', 'function']);
    expect(definition).not.toHaveProperty('approval');
    expect(definition).not.toHaveProperty('kind');
  }
});

test('every advertised tool uses the registered category and permission declaration', () => {
  const names: string[] = [];
  const inputs: Readonly<Record<string, unknown>> = {
    web_fetch: { url: 'https://example.com/' },
    web_search: { query: 'Public docs' },
  };
  for (const definition of LOCAL_TOOL_DEFINITIONS) {
    const schema = isRecord(definition) ? definition['function'] : null;
    if (!isRecord(schema) || typeof schema['name'] !== 'string') {
      throw new Error('The model tool schema has no name.');
    }
    const name = schema['name'];
    names.push(name);
    const permission = localToolApproval(name, inputs[name]);
    if (permission) {
      expect(permission.kind).toBe(localToolKind(name));
      expect(permission.summary).not.toBe('');
    }
  }
  expect(new Set(names).size).toBe(names.length);
  expect(localToolApproval('read_file', { path: 'file.txt' })).toBeNull();
  expect(localToolKind('historical_unknown_tool')).toBe('other');
  expect(() => localToolApproval('unregistered_tool', {})).toThrow('not available');
});
