# REFERENCE NOTES — engine-adapter native Claude bridge (read-only study)

TARGET (READ-ONLY, not modified): `<engine-adapter>/src`

Purpose: record exactly how an existing, daily-working implementation drives Claude on a
subscription via the official `@anthropic-ai/claude-agent-sdk` (which spawns the official
`claude` binary) while exposing the HOST's tools to Claude through an **in-process MCP
server**. Every claim carries `file:line` plus a verbatim quote. Unknowns are marked in
**GAPS / UNVERIFIED** at the end.

Paths below are relative to `.../engine-adapter/src/`.

---

## 1. The exact Agent SDK `query()` options object

The native session builds one `Options` object and passes it to `query()`. Verbatim
(`native/claude-native-session.ts:391-403`):

```ts
    const options: Options = {
      ...claudeSharedQueryOptions(cwd, spec, this.controller, () => {}),
      tools: [],
      mcpServers: { harness: { type: 'sdk', name: 'harness', instance: server } },
      toolAliases: this.mirror.toolAliases,
      ...system === undefined ? {} : { systemPrompt: system },
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      maxTurns: NATIVE_CLAUDE_MAX_TURNS,
      ...nativeClaudeSecurityHandlers(this.deps),
    }
    this.query = (deps.query ?? officialQuery)({ prompt: this.prompts.iterable, options })
```

Where each key comes from:

- `...claudeSharedQueryOptions(cwd, spec, this.controller, () => {})` — spread at
  `native/claude-native-session.ts:392`. This helper supplies the process/transport keys
  (see below).
- `tools: []` — `native/claude-native-session.ts:393`. Built-ins are disabled; only the
  in-process MCP server's tools are reachable.
- `mcpServers` — `native/claude-native-session.ts:394`; the in-process **`type: 'sdk'`**
  server named `harness`, carrying the live `instance`.
- `toolAliases` — `native/claude-native-session.ts:395`; maps harness tool name → visible
  `mcp__harness__*` name.
- `systemPrompt` — `native/claude-native-session.ts:396`; set only when
  `system !== undefined`.
- `settingSources: []` — `native/claude-native-session.ts:397`.
- `strictMcpConfig: true` — `native/claude-native-session.ts:398`.
- `includePartialMessages: true` — `native/claude-native-session.ts:399`.
- `maxTurns: NATIVE_CLAUDE_MAX_TURNS` — `native/claude-native-session.ts:400`.
- `...nativeClaudeSecurityHandlers(this.deps)` — `native/claude-native-session.ts:401`
  (adds `canUseTool`, `onElicitation`, `onUserDialog`).
- `query({ prompt, options })` — `native/claude-native-session.ts:403`; `prompt` is the
  streaming `AsyncIterable<SDKUserMessage>` (`this.prompts.iterable`).

`NATIVE_CLAUDE_MAX_TURNS` value (`native/claude-native-session.ts:27-28`):

```ts
/** Large guardrail only; the harness, rather than Claude, bounds normal steps. */
export const NATIVE_CLAUDE_MAX_TURNS = 256
```

`claudeSharedQueryOptions` returns the remaining (process-level) keys — verbatim
(`backends/claude-code.ts:62-83`):

```ts
/** The SDK process options shared by discovery and the native harness arm. */
export function claudeSharedQueryOptions(
  cwd: string,
  spec: ClaudeCodeRunSpec,
  controller: AbortController,
  capture: (child: SubprocessHandle, process: ManagedClaudeCodeProcess) => void,
): Pick<Options, 'abortController' | 'cwd' | 'pathToClaudeCodeExecutable' | 'model' | 'effort' | 'env' | 'persistSession' | 'permissionMode' | 'spawnClaudeCodeProcess'> {
  return {
    abortController: controller, cwd,
    ...spec.executable === undefined ? {} : { pathToClaudeCodeExecutable: spec.executable },
    ...spec.model === undefined ? {} : { model: spec.model },
    ...spec.effort === undefined ? {} : { effort: spec.effort },
    env: { ...scrubbedClaudeParentEnv(), ...spec.env }, persistSession: false, permissionMode: CLAUDE_CODE_PERMISSION_MODE,
    spawnClaudeCodeProcess: (options: SpawnOptions) => {
      assertClaudeSdkArgvSafe(options.args)
      const child = spec.spawn(claudeSpawnSpec(options, spec.disposeGraceMs))
      const process = new ManagedClaudeCodeProcess(child)
      capture(child, process)
      return process
    },
  }
}
```

So the shared options contribute: `abortController`, `cwd`, `pathToClaudeCodeExecutable`
(only if `spec.executable` set), `model` (only if set), `effort` (only if set), `env`,
`persistSession: false`, `permissionMode`, and `spawnClaudeCodeProcess`.

- The abort controller is `new AbortController()` owned by the session and passed in:
  `native/claude-native-session.ts:354` — `private readonly controller = new AbortController()`.
- `permissionMode` constant (`backends/claude-code.ts:9-10`):

```ts
/** Native sessions use default so their mirrored MCP calls reach canUseTool. */
export const CLAUDE_CODE_PERMISSION_MODE = 'default'
```

- The env is scrubbed: ambient `CLAUDE_*` vars are dropped except `CLAUDE_CONFIG_DIR`
  (`backends/claude-code.ts:51-59`):

```ts
const CLAUDE_ENV_PASSTHROUGH = new Set(['CLAUDE_CONFIG_DIR'])

function scrubbedClaudeParentEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(scrubbedParentEnv())) {
    const upper = key.toUpperCase()
    if (!upper.startsWith('CLAUDE_') || CLAUDE_ENV_PASSTHROUGH.has(upper)) env[key] = value
  }
  return env
}
```

- The `spawnClaudeCodeProcess` path runs `assertClaudeSdkArgvSafe(options.args)` before
  spawning (`backends/claude-code.ts:76`), which refuses permission-bypass argv
  (`backends/claude-code.ts:13-28`):

```ts
    if (argument === '--allow-dangerously-skip-permissions' || argument?.startsWith('--allow-dangerously-skip-permissions=')) {
      throw new OfficialCliStartError('CLI_PERMISSION_DENIED', 'engine-adapter: Claude Code permission-bypass argument refused')
    }
```

**Stateless/auxiliary variant** (compaction, session-title) uses the same shared options but
no MCP server — verbatim (`native/claude-native-session.ts:620-632`):

```ts
    const query = (this.deps.query ?? officialQuery)({
      prompt: onePrompt(userMessage(resolved.prompt, resolved.images)),
      options: {
        ...claudeSharedQueryOptions(input.cwd, input.spec, controller, () => {}),
        tools: [],
        settingSources: [],
        strictMcpConfig: true,
        includePartialMessages: true,
        maxTurns: NATIVE_CLAUDE_MAX_TURNS,
        ...nativeClaudeSecurityHandlers(this.deps),
        ...options.system === undefined ? {} : { systemPrompt: options.system },
      },
    })
```

**Discovery variant** (model listing) additionally sets `pathToClaudeCodeExecutable` and
`mcpServers: {}` (`provider-runtime.ts:477-487`):

```ts
    const options: Options = {
      abortController: controller,
      cwd: process.cwd(),
      pathToClaudeCodeExecutable: descriptor.executable,
      maxTurns: 0,
      persistSession: false,
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      tools: [],
```

### How streamed text and tool-use events arrive

- Messages are consumed by an async iteration over `this.query.next()`
  (`native/claude-native-session.ts:455-456`) — `const message = next.value`.
- `stream_event` frames drive the bridge collector:
  `native/claude-native-session.ts:479-491` — `this.bridge.observeStreamEvent(message.event)`.
- `assistant` frames: `native/claude-native-session.ts:493` —
  `this.bridge.observeAssistantMessage(message.message)`.
- `system`/`init` records the SDK session id and continues
  (`native/claude-native-session.ts:475-478`).
- `result` frames carry terminal state / usage
  (`native/claude-native-session.ts:499-525`).
- `isDiagnosticWorthy` filters per-token noise; `content_block_delta` and `thinking_tokens`
  are excluded (`native/claude-native-session.ts:317-323`):

```ts
function isDiagnosticWorthy(message: SDKMessage): boolean {
  if (message.type === 'stream_event') {
    const kind = (message.event as { type?: string }).type
    return kind !== 'content_block_delta'
  }
  return !(message.type === 'system' && 'subtype' in message && message.subtype === 'thinking_tokens')
}
```

- Partial messages are mandatory for cost telemetry (`parked-calls.ts:154-157`):

```ts
  /**
   * Observe one raw SDKPartialAssistantMessage event. includePartialMessages
   * is mandatory: only its message_delta reports authoritative cost telemetry.
   */
```

---

## 2. In-process MCP server creation and host-tool → MCP-tool projection

The server is constructed by `createHarnessMcpServer` — verbatim
(`tool-mirror.ts:124-146`):

```ts
/**
 * Build q14's low-level JSON-Schema MCP server without zod tool registration.
 * B2 claims a call by the observed stream order: q13 observed serial dispatch,
 * with no retries, so handler order equals the collected block order.
 */
export function createHarnessMcpServer(options: HarnessMcpServerOptions): McpServer {
  const server = new McpServer({ name: options.serverName, version: '0.0.1' }, { capabilities: { tools: {} } })
  const byName = new Map(options.tools.map(tool => [tool.name, tool] as const))
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }))
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name)
    if (tool === undefined) throw new Error(`unknown mirrored MCP tool "${request.params.name}"`)
    return options.onCall(
      tool.harnessName,
      request.params.arguments ?? {},
      extra,
      toolUseIdFromMcpMeta(request.params._meta, extra),
    )
  })
  return server
}
```

Key facts: it is a **low-level JSON-Schema server** (no zod tool registration), built with
`new McpServer({ name: options.serverName, version: '0.0.1' }, { capabilities: { tools: {} } })`
(`tool-mirror.ts:130`), registering `ListToolsRequestSchema` and `CallToolRequestSchema`
handlers directly on `server.server`.

Wiring into the session — server name is `'harness'` (`native/claude-native-session.ts:386-390`):

```ts
    const server = (deps.createMcpServer ?? createHarnessMcpServer)({
      serverName: 'harness',
      tools: this.mirror.tools,
      onCall: async (harnessName, args, extra, preferredCallId) => await this.onCall(harnessName, args, extra, preferredCallId),
    })
```

and the mirror is built from harness tool schemas with the same server name
(`native/claude-native-session.ts:378-379`):

```ts
    this.mirror = mirrorTools(tools, { serverName: 'harness' })
    this.fingerprint = toolListFingerprint(tools)
```

Each host tool becomes an MCP entry whose `inputSchema` is the harness JSON schema
unchanged (`tool-mirror.ts:104`):

```ts
    tools.push({ name, description: schema.description, inputSchema: schema.parameters, harnessName: schema.name })
```

(so `MirroredTool.inputSchema` = `schema.parameters`; interface at `tool-mirror.ts:8-13`).

**MCP-legal aliasing / naming** — the provider-visible name is `mcp__<server>__<name>`, and
names exceeding the capture-proven 114-char visible budget are SHA-256-shortened
(`tool-mirror.ts:44-72`, `74-77`):

```ts
/** q25 proved that 114 visible characters round-trip; 128 remains untested. */
const PROVIDER_VISIBLE_NAME_LIMIT = 114

function providerPrefix(serverName: string): string { return `mcp__${serverName}__` }
```

```ts
function aliasDiscriminator(harnessName: string): string {
  return createHash('sha256').update(harnessName).digest('hex').slice(0, 8)
}
```

```ts
function assertVisibleName(serverName: string, name: string): void {
  const visibleName = `${providerPrefix(serverName)}${name}`
  if (visibleName.length > PROVIDER_VISIBLE_NAME_LIMIT) throw new MirroredToolNameError(name, visibleName)
}
```

`mirrorTools` (`tool-mirror.ts:86-110`) builds `tools`, `toolAliases`
(harness name → visible name) and `reverseNames` (both inner name and visible name →
harness name):

```ts
    reverseNames[name] = schema.name
    reverseNames[visibleName] = schema.name
    aliases[schema.name] = visibleName
```

If a harness tool name already looks like an MCP client name
(`mcp__<something>__…`), it is rewritten to a short alias
(`tool-mirror.ts:94-99`, helpers at `49-56`, `62-72`).

**Correlation id from MCP meta** — the SDK-supplied `tool_use` id is read from the
namespaced key `claudecode/toolUseId` on both handler inputs (`tool-mirror.ts:148-157`):

```ts
/**
 * q20 proved the namespaced `claudecode/toolUseId` key on both handler inputs.
 * Generic historical shapes remain fallbacks for SDK compatibility.
 */
export function toolUseIdFromMcpMeta(paramsMeta: unknown, extra: unknown): string | undefined {
  for (const candidate of [metaToolUseId(extra), metaToolUseId(paramsMeta)]) {
    if (candidate !== undefined) return candidate
  }
  return undefined
}
```

with the id shape gate (`tool-mirror.ts:159-164`):

```ts
/** Anthropic tool-use ids are `toolu_…`; anything else is not a usable correlation key. */
const TOOL_USE_ID = /^toolu_[A-Za-z0-9_]+$/u

function wellFormedId(value: unknown): string | undefined {
  return typeof value === 'string' && TOOL_USE_ID.test(value) ? value : undefined
}
```

---

## 3. `canUseTool` — exact allow/deny logic

Verbatim (`native/claude-native-session.ts:194-206`):

```ts
/** Security handlers shared between interactive sessions and auxiliary turns. */
export function nativeClaudeSecurityHandlers(deps?: NativeClaudeDependencies): Pick<Options, 'canUseTool' | 'onElicitation' | 'onUserDialog'> {
  return {
    canUseTool: async (toolName) => toolName.startsWith('mcp__harness__')
      ? { behavior: 'allow' as const }
      : (deps?.diagnostic?.(`native Claude denied non-mirrored tool ${toolName}`), {
          behavior: 'deny' as const,
          message: 'Only harness-mirrored tools are available in this session.',
        }),
    onElicitation: async () => ({ action: 'decline' as const }),
    onUserDialog: async () => ({ behavior: 'cancelled' as const }),
  }
}
```

- Allow: **only** names beginning `mcp__harness__` (i.e. the bridge's own mirrored tools).
- Deny: everything else (built-ins, other MCP servers) with `behavior: 'deny'` and a fixed
  message; a diagnostic line is emitted.
- Elicitation is declined; user dialogs are cancelled.
- The discriminator is the literal string prefix `mcp__harness__`; the server name `harness`
  is what `mirrorTools(..., { serverName: 'harness' })` and the `mcpServers` entry use
  (`native/claude-native-session.ts:378`, `394`).
- A CLI-side permission denial on a mirrored tool is handled explicitly
  (`native/claude-native-session.ts:494-498`):

```ts
        if (message.type === 'system' && message.subtype === 'permission_denied' && message.tool_name.startsWith('mcp__harness__')) {
          this.bridge.failAll(failure('CLI_PERMISSION_DENIED', 'Claude Code denied a mirrored harness tool.'))
          yield* emitStep(this.bridge.collectedStep(), emitOptions(failure('CLI_PERMISSION_DENIED', 'Claude Code denied a mirrored harness tool.')))
          return
        }
```

---

## 4. History → single text prompt rendering

### 4a. Native prompt renderer (`renderNativeCliPrompt`)

Verbatim header + signature (`native/claude-native-session.ts:30-53`):

```ts
/**
 * Render conversation messages faithfully for the native Claude prompt.
 *
 * Tool calls are rendered as "[called <name>(<args>)]", tool results as their
 * text (or "[tool error] ..." when isError is true), reasoning as its text,
 * unknown blocks as "[<type> block omitted]", history images hoisted with
 * "[image #n]" in-position placeholders, and images beyond budget degraded
 * to "[image omitted: over budget]".
 */
export function renderNativeCliPrompt(
  messages: readonly Message[],
  options?: {
    readonly keptIndices?: ReadonlySet<number>
  },
): {
  readonly prompt: string
  readonly images: readonly ImageAttachmentRef[]
} {
  const images: ImageAttachmentRef[] = []
  if (messages.length === 0) return { prompt: '', images: [] }

  const trailingUserIndex = messages.findLastIndex(message => message.role !== 'user') + 1
  const historyMessages = messages.slice(0, trailingUserIndex)
  const currentMessages = messages.slice(trailingUserIndex)
```

Exact block formats (`native/claude-native-session.ts:58-95`):

```ts
  function renderContent(content: readonly ContentBlock[], isHistory: boolean): string {
    const parts: string[] = []
    for (const block of content) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          parts.push(block.text)
          break
        case 'tool-call':
          parts.push(`[called ${block.name}(${block.arguments})]`)
          break
        case 'tool-result': {
          const inner = renderContent(block.content, isHistory)
          parts.push(block.isError ? (inner.length > 0 ? `[tool error] ${inner}` : '[tool error]') : inner)
          break
        }
        case 'image': {
          const index = imageCounter++
          const isKept = options?.keptIndices !== undefined ? options.keptIndices.has(index) : true
          if (isKept) {
            images.push(block.attachment)
            if (isHistory) {
              parts.push(`[image #${images.length}]`)
            }
          } else {
            parts.push('[image omitted: over budget]')
          }
          break
        }
        default: {
          const type = (block as { type?: string }).type ?? 'unknown'
          parts.push(`[${type} block omitted]`)
          break
        }
      }
    }
    return parts.join('')
  }
```

History section assembly (`native/claude-native-session.ts:97-113`):

```ts
  if (historyMessages.length > 0) {
    const lines: string[] = [TRANSCRIPT_HISTORY_BEGIN]
    for (const message of historyMessages) {
      lines.push(`[${message.role}] ${renderContent(message.content, true)}`)
    }
    lines.push(TRANSCRIPT_HISTORY_END)
    sections.push(lines.join('\n'))
  }

  const currentTexts: string[] = []
  for (const message of currentMessages) {
    const text = renderContent(message.content, false)
    if (text.length > 0) currentTexts.push(text)
  }
  if (currentTexts.length > 0) {
    sections.push(currentTexts.join('\n\n'))
  }

  return { prompt: sections.join('\n\n'), images }
```

So the exact formats are:
- Tool call: `[called <name>(<arguments>)]` (`:67`) — `<arguments>` is the raw JSON string.
- Tool result: the rendered inner text, or `[tool error] <inner>` when `isError` (`:71`).
- Reasoning: raw `block.text` (same branch as text, `:63-64`).
- History image: `[image #n]` placeholder in position; the actual image is hoisted into
  `images[]` (`:74-86`).
- Dropped image: `[image omitted: over budget]` (`:83`).
- Unknown: `[<type> block omitted]` (`:89`).
- History lines: `[<role>] <content>` (`:100`), wrapped by
  `TRANSCRIPT_HISTORY_BEGIN` / `TRANSCRIPT_HISTORY_END` (`:98`,`:102`).
- Trailing live (current) run: last run of user messages found with
  `findLastIndex(m => m.role !== 'user') + 1` (`:51`), rendered WITHOUT the `[role]` prefix
  and joined by `\n\n` (`:106-113`); top-level sections joined with `\n\n` (`:115`).

Delimiters (`prompt.ts:52-57`):

```ts
/** The history section's opening delimiter. */
export const TRANSCRIPT_HISTORY_BEGIN = '=== Conversation history (oldest first) ==='
/** The history section's authoritative closing delimiter (V1 transcript.ts:15). */
export const TRANSCRIPT_HISTORY_END = '=== End of conversation history ==='
/** The current task's opening delimiter. */
export const TRANSCRIPT_TASK_BEGIN = '=== Current task ==='
```

### 4b. How the trailing live user message is placed (streaming session)

- On the FIRST step, the entire rendered history+current prompt is pushed as the opening
  user message (`native/claude-native-session.ts:600-605`):

```ts
      const resolved = await resolveNativePromptAndImages(
        options.messages,
        this.deps.readInputImage,
        options.signal ?? new AbortController().signal,
      )
      session.pushOpening(userMessage(resolved.prompt, resolved.images))
```

- On LATER steps, only a NEW last-user message (detected by a watermark change) is pushed as
  a fresh SDK user message (`native/claude-native-session.ts:439-451`):

```ts
      const lastUser = inputMessages.findLast(message => message.role === 'user' && !isToolResultMessage(message))
      if (this.firstStep) {
        if (lastUser !== undefined) {
          this.lastUserWatermark = userMessageWatermark(lastUser)
        }
        this.firstStep = false
      } else if (lastUser !== undefined) {
        const currentWatermark = userMessageWatermark(lastUser)
        if (currentWatermark !== this.lastUserWatermark) {
          this.lastUserWatermark = currentWatermark
          const resolved = await resolveNativePromptAndImages([lastUser], this.deps.readInputImage, this.controller.signal)
          this.prompts.push(userMessage(resolved.prompt, resolved.images))
        }
      }
```

`userMessage(...)` shapes the SDK user message (text first, then base64 images)
(`native/claude-native-session.ts:299-312`):

```ts
function userMessage(text: string, images: readonly InputImage[]): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map(image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: Buffer.from(image.bytes).toString('base64') } })),
      ],
    },
    parent_tool_use_id: null,
    session_id: '',
  }
}
```

### 4c. Non-native (layer-1) prompt builders in `prompt.ts`

For the OTHER backends (and any non-native path) the module also has
`renderHistoryTranscript` and `buildCliPrompt` (`prompt.ts:188-254`):

```ts
export function renderHistoryTranscript(messages: readonly Message[]): string {
  const lines: string[] = [TRANSCRIPT_HISTORY_BEGIN]
  for (const message of messages) {
    lines.push(`[${message.role}] ${transcriptTextOf(message.content, 'omit')}`)
  }
  lines.push(TRANSCRIPT_HISTORY_END)
  return lines.join('\n')
}
```

```ts
  const sections: string[] = []
  if (system !== undefined && system.length > 0) {
    sections.push(`${PROMPT_INSTRUCTIONS_BEGIN}\n${system}\n${PROMPT_INSTRUCTIONS_END}`)
  }
  sections.push(renderHistoryTranscript(history))
  sections.push(`${TRANSCRIPT_TASK_BEGIN}\n${task}`)
  return { prompt: sections.join('\n\n'), images }
```

Note: this is a *text-only* serializer with placeholders for non-text blocks
(`transcriptTextOf`, `prompt.ts:120-146`); it is used by the non-native official-CLI path,
whereas the NATIVE Claude arm uses `renderNativeCliPrompt` (§4a), which renders tool calls
and results faithfully.

---

## 5. PARKING — mint id, park, resume, timeouts

### Minting / claiming the id

The bridge collects `tool_use` blocks as they stream; the id is the Anthropic `toolu_…` id
from the block (`parked-calls.ts:274-283`):

```ts
  private observeBlockStart(event: Record<string, unknown>): void {
    const index = typeof event.index === 'number' ? event.index : undefined
    const block = isRecord(event.content_block) ? event.content_block : undefined
    if (index === undefined || block === undefined || typeof block.type !== 'string') return
    if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      this.toolCalls.set(index, { index, id: block.id, name: block.name, argumentsJson: '', closed: false })
    } else if (block.type === 'text' || block.type === 'thinking') {
      this.content.set(index, { index, type: block.type === 'thinking' ? 'reasoning' : 'text', text: '', closed: false })
    }
  }
```

`claimCall` matches a collected, CLOSED call by harness name (or by a preferred id) and
marks it claimed (`parked-calls.ts:193-210`):

```ts
  /**
   * q13/q21's MCP-handler dispatch lets B2 claim calls in observed block order.
   *
   * Preconditions (B2 captures must keep proving them): the CLI dispatches the
   * MCP `tools/call` handlers one at a time and in block order, and that
   * handler fires only after its block's `content_block_stop` — an unclosed
   * block is never claimable. `canUseTool` fires before block stop and must
   * never call this method. A preferred id that matches no unclaimed call of
   * this name returns undefined rather than silently taking the next call.
   */
  claimCall(harnessName: string, preferredCallId?: string): string | undefined {
    const calls = [...this.previousToolCalls.values(), ...this.toolCalls.values()].sort((a, b) => a.index - b.index)
    const matching = calls.filter(call => call.closed && this.resolveHarnessName(call.name) === harnessName && !this.claimedCallIds.has(call.id))
    const claimed = preferredCallId === undefined ? matching[0] : matching.find(call => call.id === preferredCallId)
    if (claimed === undefined) return undefined
    this.claimedCallIds.add(claimed.id)
    return claimed.id
  }
```

### The MCP `onCall` handler → claim then park

Verbatim (`native/claude-native-session.ts:556-571`):

```ts
  private async onCall(harnessName: string, _args: Record<string, unknown>, extra: unknown, preferredCallId?: string): Promise<CallToolResult> {
    let callId = preferredCallId === undefined ? undefined : this.bridge.claimCall(harnessName, preferredCallId)
    // q20/q22: an id-bearing handler fires after its own block stop, but may
    // precede the message barrier; claim and park it immediately. Id-less SDK
    // versions retain the barrier/order fallback.
    if (callId === undefined && preferredCallId === undefined) {
      callId = this.bridge.claimCall(harnessName)
      if (callId === undefined) {
        await this.barrier.promise
        callId = this.bridge.claimCall(harnessName)
      }
    }
    if (callId === undefined) throw new Error('native Claude MCP call could not be correlated to a collected tool_use')
    const signal = extra !== null && typeof extra === 'object' && 'signal' in extra ? (extra as { signal?: AbortSignal }).signal : undefined
    return await new Promise<CallToolResult>((resolve, reject) => this.bridge.park(callId, resolve as never, reject, signal))
  }
```

### Park / resume

`park` stores a pending resolver keyed by callId, resolving immediately if a result already
arrived (`parked-calls.ts:229-238`):

```ts
  /** Park a CLI invocation by its collected tool_use id. */
  park(callId: string, resolve: (result: McpToolResult) => void, reject: (reason: unknown) => void, signal?: AbortSignal): void {
    if (this.disposed) { reject(new ParkedCallAbortError('The native CLI session was disposed.')); return }
    const ready = this.results.get(callId)
    if (ready !== undefined) { this.results.delete(callId); resolve(ready); return }
    const onAbort = () => this.rejectHandler(callId, new ParkedCallAbortError())
    if (signal?.aborted === true) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })
    this.handlers.set(callId, { resolve, reject, ...(signal === undefined ? {} : { signal }), onAbort })
  }
```

Resume happens when the harness supplies results on a LATER turn: `deliverResults` maps all
results, stages them, then resolves any parked handler (`parked-calls.ts:240-245`):

```ts
  /** Map all results before committing any, so image-read failures are atomic. */
  async deliverResults(toolResults: readonly ToolResultBlock[]): Promise<void> {
    const mapped = await Promise.all(toolResults.map(async result => ({ callId: String(result.toolCallId), result: await mapToolResult(result, this.readImage) })))
    for (const entry of mapped) this.results.set(entry.callId, entry.result)
    for (const entry of mapped) if (this.resolveHandler(entry.callId, entry.result)) this.results.delete(entry.callId)
  }
```

```ts
  private resolveHandler(callId: string, result: McpToolResult): boolean {
    const handler = this.handlers.get(callId)
    if (handler === undefined) return false
    this.handlers.delete(callId)
    handler.signal?.removeEventListener('abort', handler.onAbort as EventListener)
    handler.resolve(result)
    return true
  }
```

The session delivers results at the start of the next step
(`native/claude-native-session.ts:436-438`):

```ts
      const toolResults = openingIncludesRequest ? [] : trailingToolResults(options.messages)
      if (toolResults.length > 0) await this.bridge.deliverResults(toolResults)
```

`trailingToolResults` takes only the trailing run of tool-result messages, results last
(`native/claude-native-session.ts:292-297`):

```ts
/** Only the harness's next call may carry results, and it carries them last. */
function trailingToolResults(messages: readonly Message[]): readonly ToolResultBlock[] {
  let first = messages.length
  while (first > 0 && isToolResultMessage(messages[first - 1]!)) first -= 1
  return messages.slice(first).map(message => (message as Message & { readonly content: readonly [ToolResultBlock] }).content[0])
}
```

### Failure / abort handling (this is the effective "timeout" story)

- All parked handlers are rejected on failure; staged results cleared. Collected step blocks
  REMAIN so an error finish can still show already-visible text
  (`parked-calls.ts:247-254`):

```ts
  /**
   * Reject parked handlers and clear delivered results. Collected step blocks
   * remain available so an error finish can preserve already-visible text.
   */
  failAll(reason: unknown): void {
    for (const callId of [...this.handlers.keys()]) this.rejectHandler(callId, abortReason(reason))
    this.results.clear()
  }
```

- The bridge is designed so it "never awaits a parked CLI promise"
  (`parked-calls.ts:106-109`):

```ts
/**
 * One native transport's bridge state. It never executes harness tools and it
 * never awaits a parked CLI promise: q15 proves that promise may never settle.
 */
```

- Abort wiring: the session's `onAbort` fails all parked calls and disposes
  (`native/claude-native-session.ts:429`):

```ts
    const onAbort = () => { aborted = true; this.bridge.failAll(abortFailure(signal?.reason)); this.dispose() }
```

- Abort error type (`stream-emitter.ts:194-199`):

```ts
export class ParkedCallAbortError extends Error {
  constructor(message = 'The native CLI tool call was aborted.') {
    super(message)
    this.name = 'AbortError'
  }
}
```

- **Timeout: there is NO dedicated wall-clock timeout for a parked call** in this package.
  The only rejections are dispose, failure/error finishes, and the per-call `AbortSignal`
  passed from the SDK handler's `extra.signal` (`native/claude-native-session.ts:569`) or
  the session controller (a session-level abort at `:429`). See GAPS.

- Cross-step isolation / registry keying is `(sessionId, purpose)`
  (`parked-calls.ts:331-344`):

```ts
/** Registry enforces `(sessionId,purpose)` isolation; undefined and '' differ. */
export class ParkedCallsRegistry {
```

---

## 6. Auth / overflow evidence extraction

### Auth evidence

Name: `claudeAuthenticationEvidence` (`backends/claude-code.ts:85-101`):

```ts
/**
 * Explicit Claude authentication evidence. Only these fixed CLI phrases map a
 * failure to `CLI_NOT_AUTHENTICATED`; every other error stays generic.
 */
const CLAUDE_AUTHENTICATION_PATTERN =
  /not logged in|please run \/login|oauth token (?:expired|revoked)|401 unauthorized|authentication failed|invalid api key/i

/**
 * Whether a Claude failure carries explicit authentication evidence.
 * @param error - the underlying host-side failure.
 * @returns `true` only when the message matches the fixed evidence pattern.
 */
export function claudeAuthenticationEvidence(error: unknown): boolean {
  if (error === undefined || error === null) return false
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
  return CLAUDE_AUTHENTICATION_PATTERN.test(message)
}
```

Returns a boolean; the signal string is the regex above; on match the session emits
`failure('CLI_NOT_AUTHENTICATED', 'Claude Code is not authenticated; please run /login.')`
(`native/claude-native-session.ts:514-515`).

### Overflow evidence

Name: `claudeContextOverflowEvidence` (`backends/claude-code.ts:103-149`):

```ts
/**
 * Explicit Claude / Anthropic context overflow evidence, on top of the
 * harness's own `isContextWindowExceededError` classifier. Only phrases whose
 * object IS the model context qualify (the harness rule, llm/src/error.ts):
 * Anthropic's 400 "prompt is too long: N tokens > M maximum" and the
 * "input length and max_tokens exceed" envelope. A bare mention of "context
 * window" in some other error must NOT trigger compaction plus a retry.
 * UNCITED against a live CLI overflow: the SDK spawns the PATH `claude`, so
 * no bundle could be grepped; the live overflow check records the verbatim
 * text (design §3 P3 live gate).
 */
const CLAUDE_CONTEXT_OVERFLOW_PATTERN =
  /\bprompt is too long\b|\binput length and `?max_tokens`? exceed\b/i
```

```ts
export function claudeContextOverflowEvidence(error: unknown): boolean {
  if (error === undefined || error === null) return false
  if (typeof error === 'string') {
    return isContextWindowExceededError(error) || CLAUDE_CONTEXT_OVERFLOW_PATTERN.test(error)
  }
  if (error instanceof Error) {
    if (isContextWindowExceededError(error.message) || CLAUDE_CONTEXT_OVERFLOW_PATTERN.test(error.message)) {
      return true
    }
  }
  if (typeof error === 'object') {
    const candidate = error as Record<string, unknown>
    if (typeof candidate.message === 'string' && (isContextWindowExceededError(candidate.message) || CLAUDE_CONTEXT_OVERFLOW_PATTERN.test(candidate.message))) {
      return true
    }
    if (typeof candidate.result === 'string' && (isContextWindowExceededError(candidate.result) || CLAUDE_CONTEXT_OVERFLOW_PATTERN.test(candidate.result))) {
      return true
    }
    if (Array.isArray(candidate.errors)) {
      for (const item of candidate.errors) {
        if (typeof item === 'string' && (isContextWindowExceededError(item) || CLAUDE_CONTEXT_OVERFLOW_PATTERN.test(item))) {
          return true
        }
      }
    }
  }
  return false
}
```

Returns a boolean; uses the harness `isContextWindowExceededError`
(imported at `backends/claude-code.ts:4`) OR the regex above; matches over `string`,
`Error.message`, `candidate.message`, `candidate.result`, and each `candidate.errors[]`
string.

### Where they are consumed

`result`-message error classification (`native/claude-native-session.ts:509-521`):

```ts
          if (resultIsError(message)) {
            const hasAuthEvidence = ('errors' in message && Array.isArray(message.errors) && message.errors.some(claudeAuthenticationEvidence))
              || ('result' in message && typeof message.result === 'string' && claudeAuthenticationEvidence(message.result))
            const hasOverflowEvidence = ('errors' in message && Array.isArray(message.errors) && message.errors.some(claudeContextOverflowEvidence))
              || ('result' in message && typeof message.result === 'string' && claudeContextOverflowEvidence(message.result))
            const problem = hasAuthEvidence
              ? failure('CLI_NOT_AUTHENTICATED', 'Claude Code is not authenticated; please run /login.')
              : hasOverflowEvidence
                ? failure(CONTEXT_WINDOW_EXCEEDED_CODE, 'Claude Code prompt exceeded the model context window.')
                : failure('CLI_EXIT', 'Claude Code reported an error in the native session.')
```

Thrown-exception classification (`native/claude-native-session.ts:535-541`):

```ts
        const isAuth = claudeAuthenticationEvidence(error)
        const isOverflow = claudeContextOverflowEvidence(error)
        const problem = isAuth
          ? failure('CLI_NOT_AUTHENTICATED', 'Claude Code is not authenticated; please run /login.')
          : isOverflow
            ? failure(CONTEXT_WINDOW_EXCEEDED_CODE, 'Claude Code prompt exceeded the model context window.')
            : failure('CLI_EXIT', 'Claude Code native session failed.')
```

Same pattern in the stateless path (`native/claude-native-session.ts:666-679`, `693-699`).
`CONTEXT_WINDOW_EXCEEDED_CODE` is imported from `@deepseek-ai/dsh-llm`
(`native/claude-native-session.ts:5`).

Other typed codes used: `CLI_MAX_TURNS` on `error_max_turns`
(`native/claude-native-session.ts:501-507`), `CLI_EXIT` on early end (`:470`),
`CLI_PERMISSION_DENIED` (`:495`), `CLI_UNEXPECTED_TOOL_CALL` (`:642`).

Failure-code vocabulary (`official-cli.ts:111-119`):

```ts
export const OFFICIAL_CLI_FAILURE_CODES = [
  'CLI_NOT_AUTHENTICATED',
  'CLI_NOT_FOUND',
  'CLI_PERMISSION_DENIED',
  'CLI_PROTOCOL',
  'CLI_REFUSED',
  'CLI_EXIT',
  'CLI_EMPTY_RESPONSE',
] as const
```

**Refused flags** (argv refusals) in `backends/claude-code.ts:12-28` (see §1): refusal of
`--allow-dangerously-skip-permissions`, `--permission-mode` (unless `default`), and
`--allowedTools`/`--allowed-tools`.

---

## 7. Binary resolution (PATH vs explicit override)

The ONLY place the claude binary is chosen is `locateProviderBinary`
(`binary-path.ts:224-251`) — verbatim:

```ts
export function locateProviderBinary(
  configKey: EngineConfigKey,
  configured: string | undefined,
  allowPathLookup: boolean,
  exists: (path: string) => boolean = isExecutableFile,
): LocatedBinary {
  if (configured !== undefined) {
    if (configured.trim().length === 0) {
      throw new Error(`engine-adapter: ${configKey}.command must be a non-empty absolute path`)
    }
    if (isAbsolute(configured)) return { command: configured, origin: 'configured' }
    if (allowPathLookup) return { command: configured, origin: 'lookup' }
    throw new EngineBinaryPathError(configKey, configured)
  }
  // The opt-in is checked BEFORE the default table so that
  // `allowPathLookup: true` with no command restores the pre-P8b-4 behaviour
  // exactly — that is what the flag is for, and a half-restored behaviour
  // would be worse than either.
  if (allowPathLookup) return { command: pathLookupName(configKey), origin: 'lookup' }
  for (const candidate of officialBinaryCandidates(configKey)) {
    if (exists(candidate)) return { command: candidate, origin: 'default' }
  }
  if (configKey === 'claudeCode') {
    const bundled = sdkClaudeBinary()
    if (bundled !== undefined && exists(bundled)) return { command: bundled, origin: 'sdk-bundled' }
  }
  return { command: undefined, origin: 'none' }
}
```

Order of precedence:
1. Explicit `command` (config override). MUST be absolute → `origin: 'configured'`; a bare
   name is REFUSED with `EngineBinaryPathError` UNLESS `allowPathLookup: true`
   (`origin: 'lookup'`).
2. If no command and `allowPathLookup: true` → bare PATH name
   (`pathLookupName`, `binary-path.ts:160-165`), `origin: 'lookup'`.
3. Official absolute install locations table (`origin: 'default'`).
4. Claude only: SDK-bundled binary (`origin: 'sdk-bundled'`).
5. Otherwise `undefined` / `origin: 'none'` — provider refuses to start.

Claude candidates table (`binary-path.ts:136-142`):

```ts
  const table: Record<EngineConfigKey, readonly string[]> = {
    claudeCode: [
      '/opt/homebrew/bin/claude',
      join(home, '.local', 'bin', 'claude'),
      join(home, '.claude', 'local', 'claude'),
      '/usr/local/bin/claude',
    ],
```

SDK-bundled binary resolution (`binary-path.ts:177-184`):

```ts
export function sdkClaudeBinary(): string | undefined {
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const packageName = `@anthropic-ai/claude-agent-sdk-${platform}-${process.arch}`
  try {
    const packageJson = createRequire(import.meta.url).resolve(`${packageName}/package.json`)
    return join(dirname(packageJson), process.platform === 'win32' ? 'claude.exe' : 'claude')
  } catch { return undefined }
}
```

The rationale (no PATH search by default) is documented at `binary-path.ts:1-42`
("A provider's binary is an ABSOLUTE path, and nothing else", `PATH` resolution only behind
`allowPathLookup: true`).

**There is NO `CLAUDE_PATH`-style environment override in this package.** A grep for
`CLAUDE_PATH` / `CLAUDE_CODE_EXECUTABLE` returns nothing; the only override mechanism is a
config `command` (absolute) that becomes `spec.executable` → the SDK option
`pathToClaudeCodeExecutable` (`backends/claude-code.ts:71`). The bare PATH name is resolved
by the spec list (`pathLookupName` → `spec.probe.command`, `binary-path.ts:160-165`).

The chosen executable flows: config → `descriptor.executable` → `spec.executable`
(`adapter.ts:1008`) → `pathToClaudeCodeExecutable` (`backends/claude-code.ts:71`) and also
the SDK discovery option (`provider-runtime.ts:480`).

---

## 8. Process-group kill / temp dir / cwd containment

### Process termination

The SDK's custom-spawn process object is `ManagedClaudeCodeProcess`; the SDK's `kill()`
routes to the shared tree-scoped owner (`backends/claude-process.ts:117-132`):

```ts
  /**
   * Route the SDK's termination request to the tree-scoped process owner.
   * @param _signal - SDK-selected signal; the shared seam owns its escalation ladder.
   * @returns false only after exit or a previous termination request.
   */
  kill(_signal: NodeJS.Signals): boolean {
    if (
      this.killRequested
      || this.outcomeValue !== undefined
    ) {
      return false
    }
    this.killRequested = true
    this.child.terminate()
    return true
  }
```

So whole-tree termination is delegated to `child.terminate()` on the shared
`@deepseek-ai/dsh-subprocess` handle (the escalation ladder SIGTERM → grace → SIGKILL lives
there, per the comment). No `detached`/`setsid`/`process.kill(-pid)` appears in this package
(grep for `detached|setsid|process group|killTree` finds only `terminate()`/`kill` usages).

The spawn spec pins stdio, cwd, grace, signal and env (`backends/claude-process.ts:47-62`):

```ts
export function claudeSpawnSpec(
  options: SpawnOptions,
  graceMs: number,
): SubprocessSpawnSpec {
  if (options.cwd === undefined || options.cwd.length === 0) {
    throw new Error('engine-adapter: the Claude SDK spawn request omitted its workspace')
  }
  return {
    argv: [options.command, ...options.args],
    cwd: options.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
    graceMs,
    signal: options.signal,
    env: sdkEnvironmentOverlay(options.env),
  }
}
```

`sdkEnvironmentOverlay` tombstones surviving ambient names the SDK removed
(`backends/claude-process.ts:31-39`).

`settleRun` (`lifecycle.ts:65-93`) implements the abort→grace→forced-dispose race for the
official-CLI runs generally (its doc says "an uncooperative child whose completion never
settles must not hold the caller past the disposal grace ... on expiry the run
force-terminates through its memoized dispose").

### cwd / workspace containment

`cwd` is supplied from the session spec and passed to the SDK (`backends/claude-code.ts:70`
— `abortController: controller, cwd,`) and required non-empty at spawn
(`backends/claude-process.ts:51-53`). The workspace-containment primitive is
`workspace-containment.ts` (used by Activity and file admission, not by the SDK transport
itself) (`workspace-containment.ts:59-65`):

```ts
export function canonicalWorkspace(cwd: string): string | undefined {
  try {
    return realpathSync.native(cwd)
  } catch {
    return undefined
  }
}
```

with a segment bound (`workspace-containment.ts:22-27`):

```ts
/**
 * The walk bound. Segment counts are unbounded in an untrusted provider
 * string; the bound turns a pathological path into a refusal instead of
 * unbounded syscalls.
 */
export const MAX_WORKSPACE_PATH_SEGMENTS = 256
```

### Temp dir

**No temp-dir creation was found in this package.** A grep for `tmpdir|mkdtemp|TMPDIR`
returns no temp-dir usage (the only `temp`-ish hits were unrelated filenames like
`q3-attempt3.txt`). The SDK-spawned claude child is given `cwd` and piped stdio; no
`mkdtemp`/`os.tmpdir()` call exists here. See GAPS.

---

## GAPS / UNVERIFIED

1. **No wall-clock timeout for parked calls.** `ParkedCalls.park` (`parked-calls.ts:230-238`)
   has no timer; rejection comes only from dispose, `failAll`, or an aborted
   `AbortSignal`. The task asked about "timeouts" — none is implemented in this package.
   Any timeout must live in the SDK/host caller (UNVERIFIED here).
2. **Process-group semantics are delegated, not visible.** `kill()` calls
   `this.child.terminate()` (`backends/claude-process.ts:130`); the SIGTERM→SIGKILL ladder
   and any actual process-group (`setsid`, negative-PID kill) behaviour is UNVERIFIED in
   this package — it is owned by `@deepseek-ai/dsh-subprocess` (`subprocess-local`), which is
   outside `src/`.
3. **`scrubbedParentEnv` / `SubprocessHandle` internals** are imported from
   `@deepseek-ai/dsh-subprocess` (`backends/claude-code.ts:5`, `backends/claude-process.ts:15-20`)
   and not defined in this package; their exact scrub list is UNVERIFIED here.
4. **`isContextWindowExceededError`** is imported from `@deepseek-ai/dsh-llm`
   (`backends/claude-code.ts:4`); its exact pattern set is UNVERIFIED here.
5. **Reason for `error_max_turns` / `permission_denied` message subtypes** is taken from the
   SDK's message shapes (`native/claude-native-session.ts:494`, `501`); the exact SDK type
   definitions were not read.
6. **`claudeSharedQueryOptions` caller `capture` callback is a no-op** in the native session
   (`native/claude-native-session.ts:392` passes `() => {}`), so the spawned child handle is
   not retained by the session itself; how the child handle is tracked for teardown in the
   native arm is not shown here (UNVERIFIED — the handle is returned through the SDK's
   `spawnClaudeCodeProcess` return value).
7. **Version/timing caveats in comments** ("q13/q14/q20/q21/q22/q25", "LIVE 2026-09-05")
   are author notes, not independently verified. `PROVIDER_VISIBLE_NAME_LIMIT = 114`
   is asserted as "capture-proven"; the 128-char API figure is described as untested
   (`tool-mirror.ts:44`).
8. Exact SDK version pinned in this package was not read (no `package.json` inspected);
   the `mcpServers: { type: 'sdk', instance }` shape implies a specific
   `@anthropic-ai/claude-agent-sdk` version (UNVERIFIED).
