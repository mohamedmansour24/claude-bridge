/**
 * The in-process MCP server that carries Hermes' tools to Claude.
 *
 * Design notes:
 * - One server per Claude process, named `hermes`, so Claude sees
 *   `mcp__hermes__<name>` (docs/REFERENCE-NOTES.md §2).
 * - Built low-level with raw JSON Schemas: Hermes' schemas are JSON Schema, and
 *   passing them through zod would be lossy.
 * - `invoke()` is the same handler the MCP request path runs. Tests and the
 *   `--fake` mode drive tool calls through `invoke()`, so nothing but the MCP
 *   transport itself is bypassed.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface CallToolResultLike {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export type McpCallHandler = (
  name: string,
  args: Record<string, unknown>,
  toolUseId: string | undefined,
) => Promise<CallToolResultLike>;

export interface McpServerHandle {
  /** The `{ type: 'sdk', name, instance }` config the SDK expects. */
  readonly config: { type: 'sdk'; name: string; instance: McpServer };
  readonly visibleNames: readonly string[];
  invoke(name: string, args: Record<string, unknown>, toolUseId?: string): Promise<CallToolResultLike>;
}

export interface McpServerFactoryInput {
  readonly serverName: string;
  readonly tools: readonly McpToolSpec[];
  readonly onCall: McpCallHandler;
}

export type McpServerFactory = (input: McpServerFactoryInput) => McpServerHandle;

/** Anthropic tool-use ids are `toolu_…`; anything else is not a usable key. */
const TOOL_USE_ID = /^toolu_[A-Za-z0-9_]+$/;

function metaToolUseId(container: unknown): string | undefined {
  if (container === null || typeof container !== 'object') return undefined;
  const record = container as Record<string, unknown>;
  const meta = (record._meta ?? record) as Record<string, unknown> | undefined;
  if (meta === null || typeof meta !== 'object') return undefined;
  for (const key of ['claudecode/toolUseId', 'toolUseId', 'claudecode/tool_use_id']) {
    const value = meta[key];
    if (typeof value === 'string' && TOOL_USE_ID.test(value)) return value;
  }
  return undefined;
}

/**
 * The CLI puts the tool-use id on the MCP request `_meta` and/or on the
 * handler's `extra` (docs/REFERENCE-NOTES.md §2, `toolUseIdFromMcpMeta`).
 */
export function toolUseIdFromMcpMeta(paramsMeta: unknown, extra: unknown): string | undefined {
  return metaToolUseId(extra) ?? metaToolUseId(paramsMeta);
}

export const defaultMcpServerFactory: McpServerFactory = input => {
  const server = new McpServer({ name: input.serverName, version: '1.0.0' }, { capabilities: { tools: {} } });
  const byName = new Map(input.tools.map(tool => [tool.name, tool] as const));
  const visibleNames = input.tools.map(tool => `mcp__${input.serverName}__${tool.name}`);

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: input.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const params = request.params as { name: string; arguments?: Record<string, unknown>; _meta?: unknown };
    const tool = byName.get(params.name);
    if (tool === undefined) {
      return {
        content: [{ type: 'text' as const, text: `unknown bridged tool "${params.name}"` }],
        isError: true,
      };
    }
    const toolUseId = toolUseIdFromMcpMeta(params._meta, extra);
    const result = await input.onCall(params.name, params.arguments ?? {}, toolUseId);
    // The MCP SDK's own result type also allows structured/progress shapes we
    // never produce; a text-only result is what the CLI feeds the model.
    return result as unknown as CallToolResult;
  });

  return {
    config: { type: 'sdk', name: input.serverName, instance: server },
    visibleNames,
    invoke: (name, args, toolUseId) => input.onCall(name, args, toolUseId),
  };
};
