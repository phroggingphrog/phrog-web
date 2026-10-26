import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolResult = CallToolResult;
export type ToolContent = CallToolResult['content'][number];

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

export function errorResult(text: string): ToolResult {
  return { ...textResult(text), isError: true };
}
