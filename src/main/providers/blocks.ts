/**
 * Content blocks, in the shape Anthropic's Messages API gives them (`text`, `thinking`, `tool_use`, `tool_result`,
 * `image`). Every provider's adapter writes what its agent did in this shape: the hub's transcript, topic filing and
 * chat items read nothing else. A tool of the hub is named `mcp__hub__<tool>` in a `tool_use` block, whoever ran it.
 */
export type Block = Record<string, unknown>;

export const blocksOf = (message: unknown): Block[] => {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
};
