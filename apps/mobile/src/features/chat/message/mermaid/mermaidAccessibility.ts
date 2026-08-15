const MAX_ACCESSIBLE_SOURCE_CHARACTERS = 160;

export function createMermaidAccessibilityLabel(source: string): string {
  const normalizedSource = source.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalizedSource);
  const excerpt = characters.slice(0, MAX_ACCESSIBLE_SOURCE_CHARACTERS).join('');
  const truncation =
    characters.length > MAX_ACCESSIBLE_SOURCE_CHARACTERS ? ' Source preview truncated.' : '';
  return excerpt
    ? `Mermaid diagram. Source preview: ${excerpt}.${truncation}`
    : 'Empty Mermaid diagram.';
}
