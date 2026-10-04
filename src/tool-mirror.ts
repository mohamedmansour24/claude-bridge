/**
 * Tool name/schema mapping, both ways.
 *
 * Hermes sends OpenAI function schemas. Each becomes one MCP tool on the
 * in-process server named `hermes`, so Claude sees `mcp__hermes__<name>`.
 * Names that are illegal for MCP (or that already look like the CLI's own
 * `mcp__<server>__<tool>` client names) are aliased; Hermes must always get
 * back exactly its own name.
 *
 * MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$ (MCP spec), and the CLI's
 * visible `mcp__<server>__<tool>` form has a capture-proven 114-character
 * budget (docs/REFERENCE-NOTES.md §2, PROVIDER_VISIBLE_NAME_LIMIT).
 */

import { createHash } from 'node:crypto';

import type { OpenAiTool } from './openai-types.js';

export const MCP_SERVER_NAME = 'hermes';
export const VISIBLE_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
const PROVIDER_VISIBLE_NAME_LIMIT = 114;
const MCP_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export interface MirroredTool {
  /** The name Hermes used. */
  readonly openaiName: string;
  /** The name on the in-process MCP server. */
  readonly mcpName: string;
  /** The name Claude sees. */
  readonly visibleName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolMirrorJson {
  readonly tools: readonly MirroredTool[];
}

function discriminator(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return cleaned.length > 0 ? cleaned : 'tool';
}

/** Names that would collide with, or be misread as, an MCP client name. */
function looksLikeMcpClientName(name: string): boolean {
  return /^mcp__/i.test(name);
}

/** Deterministic, collision-free MCP name for one Hermes tool name. */
export function mcpNameFor(openaiName: string): string {
  if (MCP_NAME_PATTERN.test(openaiName) && !looksLikeMcpClientName(openaiName)) return openaiName;
  return `${sanitizeName(openaiName)}_${discriminator(openaiName)}`.slice(0, 64);
}

/** Visible name, shortened with a discriminator if it would exceed the budget. */
export function visibleNameFor(mcpName: string): string {
  const visible = `${VISIBLE_PREFIX}${mcpName}`;
  if (visible.length <= PROVIDER_VISIBLE_NAME_LIMIT) return visible;
  const room = PROVIDER_VISIBLE_NAME_LIMIT - VISIBLE_PREFIX.length - 1 - 8;
  return `${VISIBLE_PREFIX}${mcpName.slice(0, room)}_${discriminator(mcpName)}`;
}

function asSchema(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  // A tool with no usable JSON Schema still has to be callable.
  return { type: 'object', properties: {} };
}

function asDescription(value: unknown, name: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : `Hermes tool ${name}`;
}

export class ToolMirror {
  readonly tools: readonly MirroredTool[];
  readonly fingerprint: string;
  private readonly byOpenAi = new Map<string, MirroredTool>();
  private readonly byMcp = new Map<string, MirroredTool>();
  private readonly byVisible = new Map<string, MirroredTool>();

  constructor(rawTools: readonly OpenAiTool[] | undefined) {
    const mirrorTools: MirroredTool[] = [];
    const used = new Set<string>();
    for (const raw of rawTools ?? []) {
      if (raw === null || typeof raw !== 'object') continue;
      if (raw.type !== undefined && raw.type !== 'function') continue;
      const fn = raw.function;
      const openaiName = typeof fn?.name === 'string' ? fn.name : undefined;
      if (openaiName === undefined || openaiName.length === 0) continue;
      if (this.byOpenAi.has(openaiName)) continue;
      let mcpName = mcpNameFor(openaiName);
      if (used.has(mcpName)) mcpName = `${mcpName}_${discriminator(openaiName)}`.slice(0, 64);
      used.add(mcpName);
      const tool: MirroredTool = {
        openaiName,
        mcpName,
        visibleName: visibleNameFor(mcpName),
        description: asDescription(fn?.description, openaiName),
        inputSchema: asSchema(fn?.parameters),
      };
      mirrorTools.push(tool);
      this.byOpenAi.set(openaiName, tool);
      this.byMcp.set(mcpName, tool);
      this.byVisible.set(tool.visibleName, tool);
    }
    this.tools = mirrorTools;
    // Stable across reorderings of the same tool set, so cold-start correlation
    // keys stay stable when Hermes shuffles its tool list.
    const canonical = mirrorTools
      .map(tool => JSON.stringify([tool.openaiName, tool.description, tool.inputSchema]))
      .sort()
      .join('\u0000');
    this.fingerprint = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  }

  get size(): number {
    return this.tools.length;
  }

  byOpenAiName(name: string): MirroredTool | undefined {
    return this.byOpenAi.get(name);
  }

  /** Name Claude used (`mcp__hermes__x`, bare `x`, or a rewritten alias) -> Hermes' name. */
  openaiNameForEmitted(emittedName: string): string | undefined {
    return (
      this.byVisible.get(emittedName)?.openaiName ??
      this.byMcp.get(emittedName)?.openaiName ??
      this.byOpenAi.get(emittedName)?.openaiName
    );
  }

  /** Hermes' name -> the name Claude sees, or the input unchanged if unknown. */
  visibleNameForOpenAi(openaiName: string): string {
    return this.byOpenAi.get(openaiName)?.visibleName ?? openaiName;
  }

  /** The name a fresh text transcript should use for a previously-called tool. */
  transcriptNameFor(openaiName: string): string {
    return this.visibleNameForOpenAi(openaiName);
  }
}
