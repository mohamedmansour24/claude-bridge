# SDK-FACTS.md — Installed `@anthropic-ai/claude-agent-sdk` (verified from disk)

Research date: 2026-09-20. Read-only inspection; nothing installed, nothing modified.

## 0. Where the SDK actually is on this machine

**Primary copy used for every citation below (call this `SDK_ROOT`):**

```
SDK_ROOT = <engine-adapter>/node_modules/@anthropic-ai/claude-agent-sdk
```

Directory listing (verbatim, from `ls -la`):

```
sdk.d.ts            391465 bytes
sdk.mjs            1386212 bytes
sdk-tools.d.ts      159496 bytes
bridge.d.ts          16542 bytes
bridge.mjs         1345343 bytes
browser-sdk.d.ts      4246 bytes
browser-sdk.js     1341294 bytes
extractFromBunfs.js   6606 bytes
manifest.json         1923 bytes
manifest.zst.json     2227 bytes
agentSdkTypes.d.ts      25 bytes
```

**Version: `0.3.241`.** `SDK_ROOT/package.json:3`:

```json
  "version": "0.3.241",
```

`SDK_ROOT/package.json:55` (the bundled Claude Code CLI it ships against):

```json
  "claudeCodeVersion": "2.1.241"
```

Other copies found on disk (all cited paths were confirmed by reading each `package.json`):

- `<engine-adapter>/node_modules/@anthropic-ai/claude-agent-sdk` → `0.3.241` (primary)
- `<local copy>` → `0.3.241`
- `<local copy>` → `0.3.241`
- `<local copy>` → `0.3.241`
- `<local copy>` → `0.3.241`
- `<local copy>` → `0.3.241`
- `<local copy>` → `0.3.241`
- `<local copy>` → `0.3.241`
- `<local copy>` (two hashes) → **`0.3.220`** (older; not cited below)
- ~20 further copies under `<local copy>` (per-run vendor copies)

There is **no** copy in the npm global root (`npm ls -g` shows only `@anthropic-ai/claude-code@2.1.263`, no agent SDK) and **no** copy in `~/.npm`.

Module shape (ESM-only, Node >= 18) — `SDK_ROOT/package.json:8-23`:

```json
  "main": "sdk.mjs",
  "types": "sdk.d.ts",
  "exports": {
    ".": {
      "types": "./sdk.d.ts",
      "default": "./sdk.mjs"
    },
    "./extract": { ... },
    "./browser": { ... },
    "./bridge": { ... },
    "./sdk-tools": {
      "types": "./sdk-tools.d.ts"
    },
    "./sdk-tools.js": {
      "types": "./sdk-tools.d.ts"
    }
  },
  "engines": {
    "node": ">=18.0.0"
  },
  "type": "module",
```

`SDK_ROOT/package.json:48-53` (peer deps — the app must supply these):

```json
  "peerDependencies": {
    "@anthropic-ai/sdk": ">=0.93.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0"
  },
```

Runtime export surface is confirmed by the real ESM export statement — `SDK_ROOT/sdk.mjs` (final line):

```js
export{... sGe as createSdkMcpServer, ... cGe as query, ... oGe as tool};
```

The other public names exported at runtime from `sdk.mjs` (same line) include `AbortError`, `CommandMatcher`, `DirectConnectError`, `DirectConnectTransport`, `EXIT_REASONS`, `FileIndex`, `HOOK_EVENTS`, `InMemorySessionStore`, `ORG_POLICY_LIMIT_PREFIXES`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, `USAGE_LIMIT_ERROR_PREFIXES`, `USAGE_TRANSITION_PREFIXES`, `USAGE_WARNING_PREFIXES`, `deleteSession`, `filterEscalatingDefaultMode`, `foldSessionSummary`, `forkSession`, `getSessionInfo`, `getSessionMessages`, `getSubagentMessages`, `importSessionToStore`, `listSessions`, `listSubagents`, `parseDirectConnectUrl`, `renameSession`, `resolveSettings`, `startup`, `tagSession`.

---

## 1. `query()` signature

`SDK_ROOT/sdk.d.ts:2704-2707`:

```ts
export declare function query(_params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}): Query;
```

`prompt` is either a plain string (single-shot, process exits after the turn) or an async iterable of `SDKUserMessage` (streaming input mode). Streaming input mode is a precondition for the control methods — `SDK_ROOT/sdk.d.ts:2388-2392`:

```
    /**
     * Control Requests
     * The following methods are control requests, and are only supported when
     * streaming input/output is used.
     */
```

`Query` is an async generator with methods — `SDK_ROOT/sdk.d.ts:2383-2387`:

```ts
/**
 * Query interface with methods for controlling query execution.
 * Extends AsyncGenerator and has methods, so not serializable.
 */
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
```

Query members (verbatim declarations):

- `SDK_ROOT/sdk.d.ts:2401` — `interrupt(): Promise<SDKControlInterruptResponse | undefined>;`
- `SDK_ROOT/sdk.d.ts:2408` — `setPermissionMode(mode: PermissionMode): Promise<void>;`
- `SDK_ROOT/sdk.d.ts:2425-2427` — `setMcpPermissionModeOverride(serverName: string, mode: 'default' | 'auto' | null): Promise<{ warning?: string; }>;`
- `SDK_ROOT/sdk.d.ts:2435` — `setModel(model?: string): Promise<void>;`
- `SDK_ROOT/sdk.d.ts:2692` — `backgroundTasks(toolUseId?: string): Promise<boolean>;`
- `SDK_ROOT/sdk.d.ts:2701` — `close(): void;`

Per the `close()` docblock, `SDK_ROOT/sdk.d.ts:2693-2699`: *"Close the query and terminate the underlying process. This forcefully ends the query, cleaning up all resources including pending requests, MCP transports, and the CLI subprocess. … After calling close(), no further messages will be received."*

---

## 2. The `Options` type — exact field names

Declared at `SDK_ROOT/sdk.d.ts:1369`:

```ts
export declare type Options = {
```

### 2.1 Tools

`SDK_ROOT/sdk.d.ts:1469-1481`:

```ts
    /**
     * Specify the base set of available built-in tools.
     * - `string[]` - Array of specific tool names (e.g., `['Bash', 'Read', 'Edit']`)
     * - `[]` (empty array) - Disable all built-in tools
     * - `{ type: 'preset'; preset: 'claude_code' }` - Use all default Claude Code tools
     *
     * Note: native builds may provide search via Bash `find`/`grep` instead of the
     * dedicated Grep/Glob tools. List Grep/Glob here or in `allowedTools` to get them.
     */
    tools?: string[] | {
        type: 'preset';
        preset: 'claude_code';
    };
```

Related (distinct) fields:

- `SDK_ROOT/sdk.d.ts:1422` — `allowedTools?: string[];` — *"List of tool names that are auto-allowed without prompting for permission. These tools will execute automatically without asking the user for approval. To restrict which tools are available, use the `tools` option instead. Note: passing `'Skill'` here is deprecated — use the `skills` option instead."* (`:1416-1421`)
- `SDK_ROOT/sdk.d.ts:1442` — `disallowedTools?: string[];` — *"…removed from the model's context and cannot be used, even if they would otherwise be allowed."* (`:1438-1441`)
- `SDK_ROOT/sdk.d.ts:1468` — `toolAliases?: Record<string, string>;` — maps a model-emitted `tool_use` name to another tool (`:1444-1467`).

### 2.2 `mcpServers` and the in-process `"sdk"` server shape

`SDK_ROOT/sdk.d.ts:1755`:

```ts
    mcpServers?: Record<string, McpServerConfig>;
```

Union — `SDK_ROOT/sdk.d.ts:1091`:

```ts
export declare type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance;
```

The in-process SDK server shape — `SDK_ROOT/sdk.d.ts:1075-1086`:

```ts
export declare type McpSdkServerConfig = {
    type: 'sdk';
    name: string;
};

/**
 * MCP SDK server config with an actual McpServer instance.
 * Not serializable - contains a live McpServer object.
 */
export declare type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
    instance: McpServer;
};
```

So the exact in-process form is `{ type: 'sdk', name: <string>, instance: <McpServer> }` — there is **no** `version` field on the config (version is a `createSdkMcpServer` argument, see §2.2.1).

`McpServer` is imported from `@modelcontextprotocol/sdk/server/mcp.js` — `SDK_ROOT/sdk.d.ts:7`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
```

Stdio / SSE / HTTP configs (note all three carry `timeout` and `alwaysLoad`):

`SDK_ROOT/sdk.d.ts:1190-1204`:

```ts
export declare type McpStdioServerConfig = {
    type?: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
    /**
     * Per-server tool-call timeout in milliseconds. Overrides the MCP_TOOL_TIMEOUT environment variable for this server. Hard wall-clock limit per call; progress notifications do not extend it. Values below 1000ms are ignored (falls through to MCP_TOOL_TIMEOUT or the default).
     */
    timeout?: number;
    /**
     * When true, all tools from this server are always included in the prompt and never deferred behind tool search. ...
     */
    alwaysLoad?: boolean;

};
```

`SDK_ROOT/sdk.d.ts:1173-1188`:

```ts
export declare type McpSSEServerConfig = {
    type: 'sse';
    url: string;
    headers?: Record<string, string>;
    tools?: McpServerToolPolicy[];
    ... timeout?: number; ... alwaysLoad?: boolean;
};
```

`SDK_ROOT/sdk.d.ts:1058-1073`:

```ts
export declare type McpHttpServerConfig = {
    type: 'http';
    url: string;
    headers?: Record<string, string>;
    tools?: McpServerToolPolicy[];
    ... timeout?: number; ... alwaysLoad?: boolean;
};
```

### 2.2.1 `createSdkMcpServer()` — creating the in-process server

`SDK_ROOT/sdk.d.ts:498-505`:

```ts
/**
 * Creates an MCP server instance that can be used with the SDK transport.
 * This allows SDK users to define custom tools that run in the same process.
 *
 * Tool calls are bounded by the MCP tool-call timeout — the MCP_TOOL_TIMEOUT
 * env var (ms), effectively unbounded by default.
 */
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;
```

`CreateSdkMcpServerOptions` — `SDK_ROOT/sdk.d.ts:507-526`:

```ts
declare type CreateSdkMcpServerOptions = {
    name: string;
    version?: string;
    /**
     * Server instructions returned from `initialize` and surfaced to the model
     * as an MCP instructions block. ...
     */
    instructions?: string;
    tools?: Array<SdkMcpToolDefinition<any>>;
    /**
     * When true, all tools from this server are always included in the prompt
     * and never deferred behind tool search. ...
     */
    alwaysLoad?: boolean;
};
```

Individual tool definitions come from `tool()` — `SDK_ROOT/sdk.d.ts:8066-8070`:

```ts
export declare function tool<Schema extends AnyZodRawShape>(_name: string, _description: string, _inputSchema: Schema, _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>, _extras?: {
    annotations?: ToolAnnotations;
    searchHint?: string;
    alwaysLoad?: boolean;
}): SdkMcpToolDefinition<Schema>;
```

`SdkMcpToolDefinition` — `SDK_ROOT/sdk.d.ts:4292-4304`:

```ts
/**
 * MCP tool definition for SDK servers.
 * Contains a handler function, so not serializable.
 * Supports both Zod 3 and Zod 4 schemas.
 */
export declare type SdkMcpToolDefinition<Schema extends AnyZodRawShape = AnyZodRawShape> = {
    name: string;
    description: string;
    inputSchema: Schema;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
    handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>;
};
```

`CallToolResult` / `ToolAnnotations` come from `@modelcontextprotocol/sdk/types.js` — `SDK_ROOT/sdk.d.ts:4` and `:10`:

```ts
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
```

### 2.3 `canUseTool`, `permissionMode`, `permissionPromptToolName`

`SDK_ROOT/sdk.d.ts:1427`:

```ts
    canUseTool?: CanUseTool;
```

> *"Custom permission handler for controlling tool usage. Called before each tool execution to determine if it should be allowed, denied, or prompt the user."* (`SDK_ROOT/sdk.d.ts:1423-1426`)

`SDK_ROOT/sdk.d.ts:1786`:

```ts
    permissionMode?: PermissionMode;
```

Documented members (`SDK_ROOT/sdk.d.ts:1778-1785`):

```
     * - `'default'` - Standard permission behavior, prompts for dangerous operations
     * - `'acceptEdits'` - Auto-accept file edit operations
     * - `'bypassPermissions'` - Bypass all permission checks (requires `allowDangerouslySkipPermissions`)
     * - `'plan'` - Planning mode, no execution of tools
     * - `'dontAsk'` - Don't prompt for permissions, deny if not pre-approved
```

The actual union is wider than the option docblock — `SDK_ROOT/sdk.d.ts:2196`:

```ts
export declare type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
```

`auto` means *"Use a model classifier to approve/deny permission prompts."* (`SDK_ROOT/sdk.d.ts:2194`)

`SDK_ROOT/sdk.d.ts:1798` + `:1803`:

```ts
    allowDangerouslySkipPermissions?: boolean;
...
    permissionPromptToolName?: string;
```

> *"Must be set to `true` when using `permissionMode: 'bypassPermissions'`. This is a safety measure to ensure intentional bypassing of permissions."* (`SDK_ROOT/sdk.d.ts:1794-1797`)

> *"MCP tool name to use for permission prompts. When set, permission requests will be routed through this MCP tool instead of the default handler."* (`SDK_ROOT/sdk.d.ts:1799-1802`)

### 2.4 `settingSources`

`SDK_ROOT/sdk.d.ts:2004-2014`:

```ts
    /**
     * Control which filesystem settings to load.
     * - `'user'` - Global user settings (`~/.claude/settings.json`)
     * - `'project'` - Project settings (`.claude/settings.json`)
     * - `'local'` - Local settings (`.claude/settings.local.json`)
     *
     * When omitted, all sources are loaded (matches CLI defaults).
     * Pass `[]` to disable filesystem settings (SDK isolation mode).
     * Must include `'project'` to load CLAUDE.md files.
     */
    settingSources?: SettingSource[];
```

`SDK_ROOT/sdk.d.ts:7749`:

```ts
export declare type SettingSource = 'user' | 'project' | 'local';
```

### 2.5 `systemPrompt`

`SDK_ROOT/sdk.d.ts:2121-2126`:

```ts
    systemPrompt?: string | string[] | {
        type: 'preset';
        preset: 'claude_code';
        append?: string;
        excludeDynamicSections?: boolean;
    };
```

Docblock forms (`SDK_ROOT/sdk.d.ts:2064-2073`):

```
     * - `string` - Use a custom system prompt
     * - `string[]` - Use a custom system prompt as an array of blocks; include
     *   `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` as a standalone element to mark the
     *   split between the static (globally-cacheable) prefix and the dynamic
     *   (session-specific) suffix. ...
     * - `{ type: 'preset', preset: 'claude_code' }` - Use Claude Code's default system prompt
     * - `{ type: 'preset', preset: 'claude_code', append: '...' }` - Use default prompt with appended instructions
```

### 2.6 `pathToClaudeCodeExecutable`

`SDK_ROOT/sdk.d.ts:1774-1777`:

```ts
    /**
     * Path to the Claude Code executable. Uses the built-in executable if not specified.
     */
    pathToClaudeCodeExecutable?: string;
```

Also usable end-to-end per `SDK_ROOT/README.md:30-35`:

```js
const cliPath = extractFromBunfs(binPath)

for await (const message of query({
  prompt: '…',
  options: { pathToClaudeCodeExecutable: cliPath },
})) { /* … */ }
```

### 2.7 `maxTurns`

`SDK_ROOT/sdk.d.ts:1721-1725`:

```ts
    /**
     * Maximum number of conversation turns before the query stops.
     * A turn consists of a user message and assistant response.
     */
    maxTurns?: number;
```

Adjacent budgets: `SDK_ROOT/sdk.d.ts:1730` — `maxBudgetUsd?: number;` (*"…returning an `error_max_budget_usd` result."* `:1726-1729`) and `SDK_ROOT/sdk.d.ts:1738-1740` — `taskBudget?: { total: number; };` (`@alpha`).

### 2.8 `abortController`

`SDK_ROOT/sdk.d.ts:1370-1374`:

```ts
    /**
     * Controller for cancelling the query. When aborted, the query will stop
     * and clean up resources.
     */
    abortController?: AbortController;
```

`AbortError` is exported by the SDK — `SDK_ROOT/sdk.d.ts:17-18`:

```ts
export declare class AbortError extends Error {
}
```

### 2.9 `model`

`SDK_ROOT/sdk.d.ts:1756-1760`:

```ts
    /**
     * Claude model to use. Defaults to the CLI default model.
     * Examples: 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'
     */
    model?: string;
```

Other model strings appearing in `sdk.d.ts`: `claude-opus-4-7` (`:1298`), `claude-opus-4-6` (`:5484`), `claude-sonnet-5` (`:1253`), `claude-code` preset (`:2095`). Model **aliases** are documented for agent definitions — `SDK_ROOT/sdk.d.ts:56`: *"Model alias (e.g. 'fable', 'opus', 'sonnet', 'haiku') or full model ID (e.g. 'claude-fable-5')."*

Runtime model switching: `Query.setModel(model?: string): Promise<void>` (`SDK_ROOT/sdk.d.ts:2435`).

### 2.10 `cwd`

`SDK_ROOT/sdk.d.ts:1433-1436`:

```ts
    /**
     * Current working directory for the session. Defaults to `process.cwd()`.
     */
    cwd?: string;
```

### 2.11 `env` — **replaces**, does not merge

`SDK_ROOT/sdk.d.ts:1482-1500`:

```ts
    /**
     * Environment variables for the Claude Code process.
     *
     * When set, this value REPLACES the subprocess environment entirely — it is
     * not merged with `process.env`. Spread `process.env` yourself if the
     * subprocess still needs inherited variables like `PATH`, `HOME`, or
     * `ANTHROPIC_API_KEY`. When omitted, the subprocess inherits `process.env`.
     *
     * SDK consumers can identify their app/library to include in the User-Agent header by setting:
     * - `CLAUDE_AGENT_SDK_CLIENT_APP` - Your app/library identifier (e.g., "my-app/1.0.0", "my-library/2.1")
     *
     * @example
     * ```typescript
     * env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'my-app/1.0.0' }
     * ```
     */
    env?: {
        [envVar: string]: string | undefined;
    };
```

### 2.12 `executable` / `executableArgs`

`SDK_ROOT/sdk.d.ts:1501-1509`:

```ts
    /**
     * JavaScript runtime to use for executing Claude Code.
     * Auto-detected if not specified.
     */
    executable?: 'bun' | 'deno' | 'node';
    /**
     * Additional arguments to pass to the JavaScript runtime executable.
     */
    executableArgs?: string[];
```

### 2.13 Partial-message and hook-event stream toggles

`SDK_ROOT/sdk.d.ts:1674-1678`:

```ts
    /**
     * Include partial/streaming message events in the output.
     * When true, `SDKPartialAssistantMessage` events will be emitted during streaming.
     */
    includePartialMessages?: boolean;
```

`SDK_ROOT/sdk.d.ts:1770-1773` and `:1777`:

```ts
     * @default false
     */
    includeHookEvents?: boolean;
...
    forwardSubagentText?: boolean;
```

(`includeHookEvents` default is `false` per `:1771`.) `forwardSubagentText` — *"Forward subagent text and thinking blocks as assistant/user messages with `parent_tool_use_id` set."* (`SDK_ROOT/sdk.d.ts:1679-1685`)

### 2.14 Other `Options` fields present (names only, for completeness)

`abortController?`, `additionalDirectories?`, `agent?`, `agents?`, `allowedTools?`, `canUseTool?`, `continue?`, `cwd?`, `disallowedTools?`, `toolAliases?`, `tools?`, `env?`, `executable?`, `executableArgs?`, `extraArgs?`, `fallbackModel?`, `enableFileCheckpointing?`, `toolConfig?`, `forkSession?`, `betas?`, `hooks?`, `onElicitation?`, `onUserDialog?`, `supportedDialogKinds?`, `persistSession?`, `sessionStore?`, `sessionStoreFlush?`, `loadTimeoutMs?`, `includeHookEvents?`, `includePartialMessages?`, `forwardSubagentText?`, `thinking?`, `effort?`, `maxThinkingTokens?` (deprecated), `maxTurns?`, `maxBudgetUsd?`, `taskBudget?`, `mcpServers?`, `model?`, `outputFormat?`, `pathToClaudeCodeExecutable?`, `permissionMode?`, `planModeInstructions?`, `allowDangerouslySkipPermissions?`, `permissionPromptToolName?`, `plugins?`, `promptSuggestions?`, `agentProgressSummaries?`, `resume?`, `sessionId?`, `resumeSessionAt?`, `resumeDropsTurn?`, `sandbox?`, `settings?`, `managedSettings?`, `settingSources?`, `skills?`, `debug?`, `debugFile?`, `stderr?`, `strictMcpConfig?`, `systemPrompt?`, `title?`, `spawnClaudeCodeProcess?`. (All from `SDK_ROOT/sdk.d.ts:1369-2158`.)

Notable non-obvious ones:

- `SDK_ROOT/sdk.d.ts:2037` — `skills?: string[] | 'all';`
- `SDK_ROOT/sdk.d.ts:2063` — `strictMcpConfig?: boolean;` — *"Only use MCP servers passed via the `mcpServers` option … ignoring all other MCP configurations: project `.mcp.json`, user settings, plugins, and on-disk agent frontmatter … Maps to the CLI `--strict-mcp-config` flag."* (`:2056-2062`)
- `SDK_ROOT/sdk.d.ts:2055` — `stderr?: (data: string) => void;`
- `SDK_ROOT/sdk.d.ts:2157` — `spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;`
- `SDK_ROOT/sdk.d.ts:1589` — `onElicitation?: OnElicitation;`
- `SDK_ROOT/sdk.d.ts:1603` — `onUserDialog?: OnUserDialog;`
- `SDK_ROOT/sdk.d.ts:1849` — `agentProgressSummaries?: boolean;`
- `SDK_ROOT/sdk.d.ts:1839` — `promptSuggestions?: boolean;`

---

## 3. Streaming message types

### 3.1 The `SDKMessage` union (real, 2026-09 build)

`SDK_ROOT/sdk.d.ts:4331-4334` (comment + the full union, verbatim; it is one long line in the file):

```ts
/**
 * Every conversational and informational message the CLI emits on its output stream, discriminated by type (and subtype for system/result messages). Consumers should ignore types and subtypes they do not recognize: the set grows over time.
 */
export declare type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay | SDKResultMessage | SDKSystemMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKStatusMessage | SDKAPIRetryMessage | SDKControlRequestProgressMessage | SDKModelRefusalFallbackMessage | SDKModelRefusalNoFallbackMessage | SDKLocalCommandOutputMessage | SDKHookStartedMessage | SDKHookProgressMessage | SDKHookResponseMessage | SDKPluginInstallMessage | SDKToolProgressMessage | SDKAuthStatusMessage | SDKTaskNotificationMessage | SDKTaskStartedMessage | SDKTaskUpdatedMessage | SDKTaskProgressMessage | SDKBackgroundTasksChangedMessage | SDKThinkingTokensMessage | SDKSessionStateChangedMessage | SDKWorkerShuttingDownMessage | SDKCommandsChangedMessage | SDKNotificationMessage | SDKFilesPersistedEvent | SDKToolUseSummaryMessage | SDKMemoryRecallMessage | SDKRateLimitEvent | SDKElicitationCompleteMessage | SDKPermissionDeniedMessage | SDKPromptSuggestionMessage | SDKMirrorErrorMessage | SDKInformationalMessage | SDKConversationResetMessage;
```

**Design implication:** there is no single "streaming event" enum you can exhaust — the built-in instruction is to *ignore unrecognized `type`/`subtype`*.

### 3.2 `SDKAssistantMessage`

`SDK_ROOT/sdk.d.ts:3059-3072`:

```ts
/**
 * An assistant message. While a response streams the CLI emits one assistant message per completed content block, so several consecutive assistant messages can share message.id and each carries just that block in message.content; on those, message.stop_reason is null and message.usage is not final — the turn's stop reason and total usage arrive on the result message. parent_tool_use_id is non-null when the message was produced inside a subagent started by that tool_use.
 */
export declare type SDKAssistantMessage = {
    type: 'assistant';
    /**
     * Shaped like an Anthropic Messages API Message object (role "assistant"): id, model, content blocks (text, thinking, tool_use, ...), stop_reason and usage. When streamed, content typically holds the single block this message delivers and stop_reason is still null — see SDKAssistantMessage. See the Messages API reference for the block types.
     */
    message: BetaMessage;
    parent_tool_use_id: string | null;
    error?: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
    request_id?: string;
```

Additional optional members on `SDKAssistantMessage`: `resumed_from_incomplete_thinking?: true` (`:3076`), `supersedes?: UUID[]` (`:3080`), `aborted?: true` (`:3084`), `subagent_type?: string` (`:3088`), `task_description?: string` (`:3092`), `timestamp?: string` (`:3097`), `context_usage?: SDKContextUsage` (`:3102`). Closing brace at `SDK_ROOT/sdk.d.ts:3115`.

`BetaMessage` is the Anthropic SDK type — `SDK_ROOT/sdk.d.ts:1`:

```ts
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
```

**So: full assistant content blocks (`text`, `thinking`, `tool_use`, …) arrive inside `message.content` of an `SDKAssistantMessage`.**

### 3.3 `SDKPartialAssistantMessage` — text deltas and `stream_event`

`SDK_ROOT/sdk.d.ts:4476-4489`:

```ts
/**
 * An incremental streaming event for the assistant message being generated, emitted only when partial messages are requested (--include-partial-messages). The complete assistant message still follows as its own message.
 */
export declare type SDKPartialAssistantMessage = {
    type: 'stream_event';
    /**
     * One Anthropic Messages API streaming event (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop) as defined for the streaming Messages API.
     */
    event: BetaRawMessageStreamEvent;
    parent_tool_use_id: string | null;
    uuid: UUID;
    session_id: string;
    ttft_ms?: number;
};
```

`BetaRawMessageStreamEvent` is the Anthropic SDK union — `SDK_ROOT/sdk.d.ts:2`:

```ts
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
```

**So: text deltas and `tool_use` start/delta blocks arrive as `type: 'stream_event'` messages whose `event` is the raw Anthropic Messages streaming event** (gate: `includePartialMessages: true`, §2.13). The fully assembled block still arrives later as an `SDKAssistantMessage` — `SDK_ROOT/sdk.d.ts:4477`: *"The complete assistant message still follows as its own message."*

### 3.4 `SDKUserMessage` (and the CLI-generated `tool_result` carrier)

`SDK_ROOT/sdk.d.ts:4963-4972`:

```ts
/**
 * A user-role message. A client writes one to the CLI to submit a prompt (this starts a turn); the CLI emits them for user-role content it adds to the conversation itself, chiefly the tool_result blocks answering the assistant's tool_use blocks.
 */
export declare type SDKUserMessage = {
    type: 'user';
    /**
     * An Anthropic Messages API user message: a MessageParam with role "user" whose content is a string or an array of content blocks (text, image, document, tool_result, ...). See the Messages API reference for the block types.
     */
    message: MessageParam;
    parent_tool_use_id: string | null;
```

Other members: `isSynthetic?: boolean` (`:4973`), `tool_use_result?: unknown` (`:4977`), `priority?: 'now' | 'next' | 'later'` (`:4978`), `origin?: SDKMessageOrigin` (`:4979`), `shouldQuery?: boolean` (`:4985`), `timestamp?: string` (`:4989`), `uuid?: UUID` / `session_id?: string` (`:5004-5005`), `subagent_type?` / `task_description?` (`:5009`, `:5013`).

`tool_use_result` is the structured tool output — `SDK_ROOT/sdk.d.ts:4974-4977`:

```
     * Structured tool output — the tool's full Output object, not the string content sent to the model. The shape is per-tool, keyed by the matching tool_use block's name (see the *Output types in toolTypes); MCP and dynamic tools carry their own shapes, so the field stays unknown-typed. ...
```

`SDKUserMessageReplay` is the same shape with `type: 'user'` — `SDK_ROOT/sdk.d.ts:5016-5056`.

`MessageParam` comes from `@anthropic-ai/sdk/resources` — `SDK_ROOT/sdk.d.ts:8`.

### 3.5 `SDKSystemMessage` / `init` (the turn-start banner)

`SDK_ROOT/sdk.d.ts:4768-4792`:

```ts
/**
 * Session metadata the CLI emits at the start of each turn, normally ahead of every other message of that turn: session_id, model, working directory, tools, MCP servers, slash commands, permission mode, and the capabilities list for feature detection.
 */
export declare type SDKSystemMessage = {
    type: 'system';
    subtype: 'init';
    agents?: string[];
    apiKeySource: ApiKeySource;
    betas?: string[];
    claude_code_version: string;
    cwd: string;
    tools: string[];
    mcp_servers: {
        name: string;
        status: string;
    }[];
    model: string;
    permissionMode: PermissionMode;
    slash_commands: string[];
    terminal_slash_commands?: string[];
    output_style: string;
    skills: string[];
    plugins: {
        name: string;
```

Also `includePartialMessages` requires the CLI ≥ a given version; the stream gate is the option, not the message.

---

## 4. MCP tool timeout configuration

**There is no `timeout` field on an in-process SDK tool definition.** `SdkMcpToolDefinition` (`SDK_ROOT/sdk.d.ts:4297-4304`) exposes only `name`, `description`, `inputSchema`, `annotations`, `_meta`, `handler`. And `tool()`'s `_extras` (`SDK_ROOT/sdk.d.ts:8066-8070`) exposes only `annotations`, `searchHint`, `alwaysLoad` — no `timeout`.

Timeouts are configured **per MCP server** (stdio/sse/http/claudeai-proxy), or globally via an env var:

`SDK_ROOT/sdk.d.ts:1052-1055` (identical wording at `:1063-1066` for http, `:1178-1181` for sse, `:1195-1198` for stdio, `:1053` for claudeai-proxy):

```
     * Per-server tool-call timeout in milliseconds. Overrides the MCP_TOOL_TIMEOUT environment variable for this server. Hard wall-clock limit per call; progress notifications do not extend it. Values below 1000ms are ignored (falls through to MCP_TOOL_TIMEOUT or the default).
```

Field declarations:

- `SDK_ROOT/sdk.d.ts:1055` — `timeout?: number;` (on `McpClaudeAIProxyServerConfig`)
- `SDK_ROOT/sdk.d.ts:1066` — `timeout?: number;` (on `McpHttpServerConfig`)
- `SDK_ROOT/sdk.d.ts:1181` — `timeout?: number;` (on `McpSSEServerConfig`)
- `SDK_ROOT/sdk.d.ts:1198` — `timeout?: number;` (on `McpStdioServerConfig`)

**In-process (`type: 'sdk'`) servers have no `timeout` field at all** (`SDK_ROOT/sdk.d.ts:1075-1086`). Their bound is the env var — `SDK_ROOT/sdk.d.ts:502-503`:

```
 * Tool calls are bounded by the MCP tool-call timeout — the MCP_TOOL_TIMEOUT
 * env var (ms), effectively unbounded by default.
```

`MCP_TOOL_TIMEOUT` is referenced exactly at `SDK_ROOT/sdk.d.ts:502, 1053, 1064, 1179, 1196` — no other occurrences in any `.d.ts` in the package.

Separately, *built-in* tool inputs have their own timeouts (not MCP-related): e.g. `BashInput.timeout` — `SDK_ROOT/sdk-tools.d.ts:665-668`:

```ts
  /**
   * Optional timeout in milliseconds (max 600000)
   */
  timeout?: number;
```

and `TaskOutputInput.timeout` — `SDK_ROOT/sdk-tools.d.ts:701-704`. Note `sdk-tools.d.ts:666` caps Bash at `600000` ms.

---

## 5. `canUseTool` signature and `PermissionResult`

`SDK_ROOT/sdk.d.ts:199-209`:

```ts
/**
 * Permission callback function for controlling tool usage.
 * Called before each tool execution to determine if it should be allowed.
 *
 * Return `null` ONLY after the consumer has already sent the
 * control_response out-of-band (e.g. a signed HTTP POST echoing
 * `requestId`); the SDK will skip its own transport write. Fail-closed: an
 * accidental null means no control_response is sent and the tool stays
 * blocked indefinitely — permission prompts have no park deadline.
 */
export declare type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
```

The `options` object members (`SDK_ROOT/sdk.d.ts:210-268`+):

- `signal: AbortSignal;` — `:211` (*"Signaled if the operation should be aborted."*)
- `suggestions?: PermissionUpdate[];` — `:220`
- `blockedPath?: string;` — `:225`
- `decisionReason?: string;` — `:227`
- `title?: string;` — `:233` (*"Full permission prompt sentence rendered by the bridge (e.g. "Claude wants to read foo.txt")…"*)
- `displayName?: string;` — `:238` (*"Short noun phrase for the tool action (e.g. "Read file")…"*)
- `description?: string;` — `:243`
- `toolUseID: string;` — `:248`
- `agentID?: string;` — `:250`
- `requestId: string;` — `:256` (*"The control_request envelope's `request_id`…"*)
- `matchedAskRule?: { source: string; ... }` — `:264-265`

Return type (`SDK_ROOT/sdk.d.ts:2218-2230`):

```ts
export declare type PermissionResult = {
    behavior: 'allow';
    updatedInput?: Record<string, unknown>;
    updatedPermissions?: PermissionUpdate[];
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
} | {
    behavior: 'deny';
    message: string;
    interrupt?: boolean;
    toolUseID?: string;
    decisionClassification?: PermissionDecisionClassification;
};
```

Note the deny arm's `message` is **required** and the allow arm carries `updatedInput` (not `message`).

Supporting types:

- `SDK_ROOT/sdk.d.ts:2173` — `export declare type PermissionBehavior = 'allow' | 'deny' | 'ask';`
- `SDK_ROOT/sdk.d.ts:2178` — `export declare type PermissionDecisionClassification = 'user_temporary' | 'user_permanent' | 'user_reject';`
- `SDK_ROOT/sdk.d.ts:2232-2235` — `PermissionRuleValue = { toolName: string; ruleContent?: string; };`
- `SDK_ROOT/sdk.d.ts:2237-2264` — `PermissionUpdate` union: `addRules | replaceRules | removeRules | setMode | addDirectories | removeDirectories`, each with a `destination: PermissionUpdateDestination`.

Denials are also observable in the stream — `SDK_ROOT/sdk.d.ts:4500-4504`:

```ts
export declare type SDKPermissionDeniedMessage = {
    type: 'system';
    subtype: 'permission_denied';
    tool_name: string;
    tool_use_id: string;
```

with `decision_reason_type?`, `decision_reason?`, `message: string` (`:4512`, `:4516`, `:4520`). Authority caveat (`SDK_ROOT/sdk.d.ts:4498`): *"Best-effort advisory: in rare races a denial can book without a frame or a frame can lack a booking twin — **result.permission_denials is the authoritative record**."*

---

## 6. Errors: how they surface

### 6.1 Result subtype error + `is_error`

`SDK_ROOT/sdk.d.ts:4632-4635`:

```ts
/**
 * The outcome of a turn. The CLI emits exactly one result message per turn, after that turn's assistant, user and stream_event messages; treat it as the turn-complete signal (informational system messages such as task notifications, session state changes or prompt suggestions may still follow it). subtype "success" carries the final assistant text in result — or, with is_error true, the error text when the turn ended on an API error; the error subtypes say why the turn stopped early. In single-prompt (non-streaming-input) mode the process exits after the turn.
 */
export declare type SDKResultMessage = SDKResultSuccess | SDKResultError;
```

`SDK_ROOT/sdk.d.ts:4601-4629` (error arm):

```ts
export declare type SDKResultError = {
    type: 'result';
    subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
    duration_ms: number;
    duration_api_ms: number;
    is_error: boolean;
    num_turns: number;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    errors: string[];
    terminal_reason?: TerminalReason;
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
    origin?: SDKMessageOrigin;
    uuid: UUID;
    session_id: string;
};
```

`SDK_ROOT/sdk.d.ts:4637-4677` (success arm; note `is_error` exists on success too, and `api_error_status`):

```ts
export declare type SDKResultSuccess = {
    type: 'result';
    subtype: 'success';
    duration_ms: number;
    duration_api_ms: number;
    ttft_ms?: number;
    ttft_stream_ms?: number;
    time_to_request_ms?: number;
    user_message_uuid?: string;
    request_sent_wall_ms?: number;
    time_to_request_from_spawn_ms?: number;
    warm_spare_claimed?: boolean;
    time_origin_ms?: number;
    is_error: boolean;
    api_error_status?: number | null;
    num_turns: number;
    result: string;
    stop_reason: string | null;
    total_cost_usd: number;
    usage: NonNullableUsage;
    modelUsage: Record<string, ModelUsage>;
    permission_denials: SDKPermissionDenial[];
    structured_output?: unknown;
    deferred_tool_use?: SDKDeferredToolUse;
    terminal_reason?: TerminalReason;
    fast_mode_state?: FastModeState;
    fast_mode_disabled_reason?: FastModeDisabledReason;
    origin?: SDKMessageOrigin;
    uuid: UUID;
    session_id: string;
};
```

So: **turn-level failure = a `type: 'result'` message with `subtype` one of the four error strings; API failure inside a nominal success turn = `subtype: 'success'` + `is_error: true`.** The exact error text is in `result: string` (`:4653`), the human-readable error list in `errors: string[]` (`:4623`), and the raw HTTP status in `api_error_status?: number | null` (`:4651`).

### 6.2 `SDKAssistantMessageError` (auth / rate-limit / overflow-adjacent)

`SDK_ROOT/sdk.d.ts:3117`:

```ts
export declare type SDKAssistantMessageError = 'authentication_failed' | 'oauth_org_not_allowed' | 'account_on_hold' | 'billing_error' | 'rate_limit' | 'overloaded' | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' | 'max_output_tokens';
```

Surfaced as `error?: SDKAssistantMessageError` on an assistant message — `SDK_ROOT/sdk.d.ts:3069`.

### 6.3 Authentication evidence

`SDK_ROOT/sdk.d.ts:4775-4778` (on the `init` system message):

```ts
    /**
     * Where the credential used for API requests came from: 'ANTHROPIC_API_KEY' (environment variable), 'apiKeyHelper' (the configured helper command), '/login managed key' (an API key created and stored by /login with an Anthropic Console account), or 'none' (no API key in use - e.g. claude.ai OAuth login, a bearer token, or a third-party cloud provider). 'user' | 'project' | 'org' | 'temporary' | 'oauth' are legacy members that current CLIs never emit; they remain only so the type stays backward compatible.
     */
    apiKeySource: ApiKeySource;
```

`SDK_ROOT/sdk.d.ts:127`:

```ts
export declare type ApiKeySource = 'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none' | 'user' | 'project' | 'org' | 'temporary' | 'oauth';
```

There is also a dedicated auth stream message — `SDK_ROOT/sdk.d.ts:3119-3125`:

```ts
export declare type SDKAuthStatusMessage = {
    type: 'auth_status';
    isAuthenticating: boolean;
    output: string[];
    error?: string;
    uuid: UUID;
    session_id: string;
```

`apiProvider` (backend identity) is on `AccountInfo` — `SDK_ROOT/sdk.d.ts:29-32`:

```ts
    /**
     * Active API backend. Anthropic OAuth login only applies when "firstParty"; for 3P providers the other fields are absent and auth is external (AWS creds, gcloud ADC, etc.). "gateway" means the CLI is authenticated against an enterprise gateway.
     */
    apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'anthropicAws' | 'anthropicGoogleCloud' | 'mantle' | 'gateway';
```

### 6.4 Context overflow / "prompt too long"

There is no `overflow` field. The closest evidence is the terminal reason — `SDK_ROOT/sdk.d.ts:8035`:

```ts
export declare type TerminalReason = 'blocking_limit' | 'rapid_refill_breaker' | 'prompt_too_long' | 'image_error' | 'model_error' | 'api_error' | 'malformed_tool_use_exhausted' | 'aborted_streaming' | 'aborted_tools' | 'stop_hook_prevented' | 'hook_stopped' | 'tool_deferred' | 'max_turns' | 'background_requested' | 'completed' | 'budget_exhausted' | 'structured_output_retry_exhausted' | 'tool_deferred_unavailable' | 'turn_setup_failed';
```

It is carried as `terminal_reason?: TerminalReason` on both result arms (`SDK_ROOT/sdk.d.ts:4624` and `:4671`), i.e. read it off the `result` message. `'prompt_too_long'` is the overflow signal.

Context size is reported structurally via `SDKContextUsage` (`SDK_ROOT/sdk.d.ts:3197`) and attached to the synthetic `/context` assistant message as `context_usage?: SDKContextUsage` (`SDK_ROOT/sdk.d.ts:3102`).

### 6.5 Rate limits / usage limits

`SDK_ROOT/sdk.d.ts:4569-4599`:

```ts
export declare type SDKRateLimitEvent = {
    type: 'rate_limit_event';
    rate_limit_info: SDKRateLimitInfo;
    uuid: UUID;
    session_id: string;
};
...
export declare type SDKRateLimitInfo = {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';
    utilization?: number;
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
    ...
```

Also exported for prefix-matching error strings: `USAGE_LIMIT_ERROR_PREFIXES`, `USAGE_WARNING_PREFIXES`, `USAGE_TRANSITION_PREFIXES`, `ORG_POLICY_LIMIT_PREFIXES` (see `SDK_ROOT/sdk.d.ts:2167` and the `sdk.mjs` export line in §0). `SDK_ROOT/sdk.d.ts:2160-2167`:

```ts
/**
 * Emitted on the same severity:'error' path as the usage-limit bucket, but
 * the condition is an org policy, not an exhausted limit — consumers route
 * these to org-disabled presentation, never the usage-limit card.
 *
 * @alpha
 */
export declare const ORG_POLICY_LIMIT_PREFIXES: readonly ['This service is disabled for your org'];
```

### 6.6 Model refusal / retraction (a non-error-path failure mode worth designing for)

`SDK_ROOT/sdk.d.ts:4408-4435`:

```ts
/**
 * Emitted when the primary model ends the stream with stop_reason "refusal" and the turn is retried once on a fallback model (direction: "retry"). ...
 */
export declare type SDKModelRefusalFallbackMessage = {
    type: 'system';
    subtype: 'model_refusal_fallback';
    trigger: 'refusal';
    direction: 'retry' | 'revert' | 'sticky';
    scope?: 'session' | 'local';
    original_model: string;
    fallback_model: string;
    request_id: string | null;
    api_refusal_category?: string | null;
    api_refusal_explanation?: string | null;
    retracted_message_uuids?: string[];
    refused_user_message_uuid?: string | null;
    content: string;
    uuid: UUID;
    session_id: string;
};
```

Also relevant: `SDKAssistantMessage.supersedes?: UUID[]` (`SDK_ROOT/sdk.d.ts:3080`) — *"Wire uuids of previously-delivered messages that this message replaces (refusal-fallback supersede). … Evict the named messages on arrival…"* (`:3078`)

---

## 7. Things worth flagging for the design

1. **One result per turn, not per session, in streaming-input mode.** `SDK_ROOT/sdk.d.ts:4633`: *"The CLI emits exactly one result message per turn … In single-prompt (non-streaming-input) mode the process exits after the turn."* Accumulators (`total_cost_usd`, `modelUsage`) are **cumulative but reset on `/clear`** — `SDK_ROOT/sdk.d.ts:4610`: *"each result carries the running total so far, so read the latest result rather than summing across results."*
2. **`env` replaces, never merges** (`SDK_ROOT/sdk.d.ts:1485-1488`).
3. **In-process MCP tool calls are unbounded by default** (`SDK_ROOT/sdk.d.ts:502-503`); the only knobs are `MCP_TOOL_TIMEOUT` (env) or a per-server `timeout` field that in-process servers do not have.
4. **`includePartialMessages` is off unless set** (`SDK_ROOT/sdk.d.ts:1674-1678`).
5. **One assistant message per completed content block while streaming** — so consecutive `type: 'assistant'` frames can share `message.id`, and `message.stop_reason` is `null` there; the turn's stop reason and final usage are on the `result` message (`SDK_ROOT/sdk.d.ts:3060`). Do not treat an assistant frame as turn-complete.
6. **`canUseTool` can return `null`** only after an out-of-band control_response; failing to send one blocks the tool forever (`SDK_ROOT/sdk.d.ts:203-207`).

---

## GAPS / UNVERIFIED

- **Only declarations were read.** `sdk.d.ts` / `sdk-tools.d.ts` / `bridge.d.ts` / `package.json` / `README.md` were inspected; `sdk.mjs` (1.39 MB, minified) was only used to confirm the runtime export names in §0. No implementation semantics beyond doc comments were verified.
- **`sdk-tools.d.ts` tool-input shapes were only spot-checked** (Bash, TaskOutput, ExitPlanMode). The full built-in tool input/output catalogue (`*Input` / `*Output` types) was not enumerated.
- **`bridge.d.ts` (16.5 KB) was not read.** It exports a second transport surface (`./bridge`) that may be relevant if the design ever moves off `query()`; unverified.
- **`browser-sdk.d.ts` (4.2 KB) was not read.** Presumed irrelevant for a Node 20 local service; unverified.
- **No `SDKUserMessage`-as-input example was located in the installed package.** Streaming-input usage is only implied by `prompt: string | AsyncIterable<SDKUserMessage>` (`SDK_ROOT/sdk.d.ts:2705`) plus the `Query` docblock's "only supported when streaming input/output is used" (`:2390-2391`). No runnable streaming-input sample exists in the installed README.
- **`SDKControlInterruptResponse`, `SDKControlRequestProgressMessage`, `FastModeState`, `ModelUsage`, `NonNullableUsage`, `ToolConfig`, `SandboxSettings`, `SessionStore`, `PluginConfig`, `ThinkingConfig` details were not read** — named here only because they appear in the signatures above.
- **The `0.3.220` copy** (two `.pnpm` entries under `<local copy>`) was found but **not diffed** against `0.3.241`. If the new service pins a different version, re-verify; the `SDKMessage` union and `Options` list are known to grow between versions (`SDK_ROOT/sdk.d.ts:4332`).
- **No verification that a given model string (e.g. `claude-sonnet-5`) is accepted by the CLI at runtime.** Only that the strings appear in doc comments (`SDK_ROOT/sdk.d.ts:1758`) and in `EffortLevel` documentation (`:1706`: *"'xhigh' — Deeper than high (Fable 5, Opus 4.7+, Sonnet 5)"*).
- **`MCP_TOOL_TIMEOUT` default value was not found in the package** — only "effectively unbounded by default" (`SDK_ROOT/sdk.d.ts:503`). No numeric default is declared anywhere in the `.d.ts` files.
- **`modelUsage`/`usage` inner shapes (`ModelUsage`, `NonNullableUsage`) were not read**, so per-token accounting fields are unverified.
- **Line numbers are for `@anthropic-ai/claude-agent-sdk@0.3.241` as installed at `SDK_ROOT`.** A different install path or version will shift them.
