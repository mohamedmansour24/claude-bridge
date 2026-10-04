# claude-bridge

A small local service that lets **Hermes Agent** think with **Claude on a Claude
subscription**, with no API key and no one reading the owner's login.

Hermes runs its own agent loop: it sends messages + tool schemas to an
OpenAI-compatible endpoint and runs the tools itself. `claude-bridge` serves that
endpoint on loopback and satisfies each request through the official
`@anthropic-ai/claude-agent-sdk`, which spawns the official `claude` binary using
that binary's own login.

It was built for Hermes, but any client that speaks OpenAI Chat Completions with
its own tool loop and lets you set a custom base URL can use it.

Nothing else may touch the login. The bridge never reads, logs, copies or
transmits any credential, token, cookie, keychain item or login file, and never
calls a model API itself.

```
Hermes ──OpenAI Chat Completions──▶ claude-bridge ──Agent SDK──▶ claude (own login)
   ▲                                       │
   └───────── tool results ────────────────┘   (Claude executes nothing)
```

- Wire facts (Hermes client): [`docs/HERMES-CLIENT-FACTS.md`](./docs/HERMES-CLIENT-FACTS.md)
- Wire facts (installed Agent SDK 0.3.241): [`docs/SDK-FACTS.md`](./docs/SDK-FACTS.md)
- Reference implementation study: [`docs/REFERENCE-NOTES.md`](./docs/REFERENCE-NOTES.md)

> **Use it with your own Claude login, on your own machine, for your own use.**
> The bridge uses whichever `claude` login exists on the computer it runs on.
> Do not expose it to other people or put it behind a product others use:
> a personal Claude subscription is not meant to be shared or resold. Check
> Anthropic's current terms for your use case.

## Quick start

```bash
npm install -g @anthropic-ai/claude-code   # if you don't have `claude` yet
claude                                    # sign in once with your subscription, then exit
git clone https://github.com/mohamedmansour24/claude-bridge && cd claude-bridge
npm install && npm run build
export CLAUDE_BRIDGE_KEY="$(openssl rand -hex 32)"   # keep this; your client needs it
npm start                                  # listens on http://127.0.0.1:8765/v1
```

Then in your client choose a custom OpenAI-compatible provider: base URL
`http://127.0.0.1:8765/v1`, API key = your `CLAUDE_BRIDGE_KEY`, model e.g.
`claude-opus-5-5`. The client must run on the same machine.

## Known issues

- A subscription usage cap is not reported as a rate limit: it shows up as
  `503 CLAUDE_BRIDGE_STALL`, `502 CLI_EXIT`, or a request that runs until the
  20-minute wall clock.
- Switching model or effort in the middle of a conversation is ignored until the
  conversation cold-starts.
- `usage` is zero on tool-call turns; `response_format`, `tool_choice`,
  `max_tokens` and `temperature` are ignored; images in tool results are dropped.
- Idle Claude processes are only cleaned up when a new one is started.

## The invariants

These hold by construction, and the test suite asserts each one.

1. **No credential handling by the bridge.** It never reads, copies, logs,
   transmits or stores a credential, token, cookie, keychain item or login file,
   and never opens `~/.claude`, `~/.hermes`, `~/.config`, `~/.codex`, `~/.gemini`,
   `~/.zcode`, any `.env` or any `auth*.json`. The only path to Claude is the
   Agent SDK spawning an **official** `claude` program, whose own login it uses
   by itself. Exactly one of three binaries is used, and the startup line says
   which:
   1. `CLAUDE_BRIDGE_CLAUDE_PATH` if set (or `--claude-path`) **and it names a
      real executable** — an absolute path that exists, or a bare name found on
      `PATH` (then used as the absolute candidate). A value that names nothing
      spawnable makes the bridge **refuse to start** and name the value: it never
      quietly spawns a different CLI than the one you named, and it never hands
      the SDK a relative or missing path. Only an absent, empty or
      whitespace-only value counts as "unset";
   2. otherwise `claude` found on `PATH`;
   3. otherwise the CLI **bundled with `@anthropic-ai/claude-agent-sdk`** — with
      no explicit value set, the bridge does not refuse to start just because
      `PATH` has no `claude`, it falls back to that official CLI; the SDK spawns
      it because `pathToClaudeCodeExecutable` is left unset.
   The bridge also **never calls a model API itself**.
2. **Claude executes nothing.** `tools: []`, `settingSources: []`,
   `strictMcpConfig: true`, `canUseTool` denies everything except the bridge's own
   `mcp__hermes__*` names, no permission-bypass mode or flag ever, and
   `cwd` is an empty private temp dir created `0700` per process and removed on
   every exit path. Every tool Claude "calls" is only *reported* to Hermes.
3. **Loopback only.** Binds `127.0.0.1`, refuses any non-loopback `Host` or
   `Origin`, and requires `CLAUDE_BRIDGE_KEY` (≥ 32 characters, compared in
   constant time) on every request except `/healthz`. The `Host`/`Origin` check
   is a strict parser, not a substring match: only `127.0.0.1`, `localhost` and
   the bracketed `[::1]` (each with an optional single `:port`) are accepted, so
   `127.0.0.1:8801@evil.com`, `[::1].attacker.com`, `127.0.0.1.evil.com`,
   `localhost.attacker.com`, an unbracketed `::1` and `Origin: null` are all
   refused with 403. It refuses to start without a key. The owner sets the key;
   the bridge never generates, prints or stores one.
4. **No content in logs.** Only request ids, counts, durations, model names and
   outcome codes. The filter is structural, in three rules: (1) a field name must
   be on the allowlist; (2) **every** string written on a line — every field
   value *and* the `event` name — must be a short machine-token-shaped string
   that is **not credential-shaped** (an `sk-…`/`sk-ant-…` key, a GitHub/Slack/
   Google/AWS token, a JWT, or a long opaque base64 blob), so a credential-shaped
   value cannot be logged verbatim through **any** field, whether or not that
   field has a rule of its own; and (3) a field whose value comes from the CLI,
   the SDK or a request must additionally be a member of its closed set (or match
   the version shape) — `apiKeySource`, `claudeCodeVersion`, `subtype`,
   `terminalReason`, `kind`, `outcome`, `model`, `phase` — so an unknown enum is
   dropped rather than guessed at. Bridge codes (`CLAUDE_BRIDGE_STALL`,
   `context_length_exceeded`), hex request/proc ids, model ids, `code` slugs,
   versions and short enums still log normally. The spawned CLI's own stderr is
   piped into the bridge and discarded (byte count only), never inherited into
   the bridge's console or log.

## Requirements

- Node 20+ (developed and tested on Node 22)
- The official `claude` program, already signed in
  (`claude` once in a terminal). It is looked up as above: an explicit
  `CLAUDE_BRIDGE_CLAUDE_PATH`, then `PATH`, then the CLI bundled with the Agent
  SDK. Whichever one runs, the login is the one that program already has — the
  bridge never touches it. If you do set `CLAUDE_BRIDGE_CLAUDE_PATH`, it must
  name an executable file: the bridge refuses to start (naming the value) rather
  than silently running a different CLI. If the bridge reports
  `CLAUDE_BRIDGE_NOT_SIGNED_IN`, run `claude` once in a terminal and sign in.
- Hermes Agent (any version that speaks OpenAI Chat Completions)

## Install and start

```bash
cd claude-bridge
npm install
npm run build

# 1) set your own key (>= 32 chars). Use whatever secret manager you like;
#    the bridge never generates or prints one.
export CLAUDE_BRIDGE_KEY="$(head -c 32 /dev/urandom | base64 | tr -d '=' | head -c 40)"

# 2) run it (foreground)
node dist/server.js --port 8765
```

Then `http://127.0.0.1:8765/v1` is your endpoint, with `GET /healthz` and
`GET /v1/models` for sanity checks:

```bash
curl -s http://127.0.0.1:8765/healthz
curl -s -H "authorization: Bearer $CLAUDE_BRIDGE_KEY" http://127.0.0.1:8765/v1/models
```

Exposed model ids (each maps 1:1 to the same id in the Agent SDK):

| id | notes |
| --- | --- |
| `claude-fable-5-1` | |
| `claude-opus-5-5` | |
| `claude-opus-5` | |
| `claude-sonnet-5` | |
| `claude-haiku-4-5` | also the default auxiliary model |

`--fake` runs the bridge with a scripted pseudo-model instead of the real binary
(no Claude, no login, useful for wiring a client):

```bash
CLAUDE_BRIDGE_KEY=... node dist/server.js --fake --port 8765
```

## Connecting Hermes (Custom endpoint, per profile)

Hermes reads everything from the active profile's `config.yaml`
(`$HERMES_HOME/config.yaml`). Two options:

**Option A — CLI wizard**: `hermes model` → choose **Custom endpoint**, then give

- base URL: `http://127.0.0.1:8765/v1`
- API key: your `CLAUDE_BRIDGE_KEY`
- model: `claude-sonnet-5` (or any id from the table above)

**Option B — edit the profile's `config.yaml` directly** (this is what the dry
run does):

```yaml
model:
  provider: custom
  default: claude-sonnet-5
  base_url: http://127.0.0.1:8765/v1
  api_key: <your CLAUDE_BRIDGE_KEY>
```

Notes:

- The base URL must include `/v1`; Hermes appends `/chat/completions` itself and
  does not insert `/v1`. (The bridge also answers `/chat/completions` without the
  prefix, in case a profile is configured without it.)
- **Per profile**: Hermes reads config from the active profile, so two profiles
  can point at two different bridges, or one at the bridge and one at a hosted
  provider. `HERMES_HOME` selects the profile — the bridge has no notion of
  profiles and needs no per-profile state.
- Hermes' auxiliary calls (titles, compression, vision) arrive **without tools**
  and are served as cold one-shots with `maxTurns: 1` and no MCP server. If an
  auxiliary call asks for a model id this bridge does not expose (for example
  Hermes' last-resort `gpt-4o-mini`), it is answered with
  `CLAUDE_BRIDGE_AUX_MODEL` (default `claude-haiku-4-5`). Main requests with an
  unknown model id get HTTP 400.

## Configuration

| env var | default | meaning |
| --- | --- | --- |
| `CLAUDE_BRIDGE_KEY` | — (**required**, ≥ 32 chars) | bearer key for every request |
| `CLAUDE_BRIDGE_CLAUDE_PATH` | unset (then `PATH`, then the SDK's bundled CLI) | explicit path to the official `claude` binary; must name an executable — an unusable value refuses startup |
| `CLAUDE_BRIDGE_PORT` / `--port` | `8765` | listen port (loopback only) |
| `CLAUDE_BRIDGE_AUX_MODEL` | `claude-haiku-4-5` | model for no-tools/unknown-id aux calls |
| `CLAUDE_BRIDGE_MAX_PROCS` | `4` | hard cap on concurrent Claude processes (more → 429 + `Retry-After`) |
| `CLAUDE_BRIDGE_PARKED_TIMEOUT_MS` | `1800000` (30 min) | how long a parked tool call may wait for Hermes |
| `CLAUDE_BRIDGE_IDLE_TIMEOUT_MS` | `600000` (10 min) | idle (nothing parked) process lifetime |
| `CLAUDE_BRIDGE_REQUEST_TIMEOUT_MS` | `1200000` (20 min) | per-request wall clock |
| `CLAUDE_BRIDGE_STALL_TIMEOUT_MS` | `90000` | silent-hang watchdog → 503 |
| `CLAUDE_BRIDGE_TOOL_SETTLE_MS` | `250` | quiet window before a tool-call turn is treated as complete |
| `CLAUDE_BRIDGE_KILL_GRACE_MS` | `5000` | SIGTERM → SIGKILL grace for the process group |
| `CLAUDE_BRIDGE_MAX_TURNS` | `256` | SDK `maxTurns` guardrail for conversations |
| `CLAUDE_BRIDGE_TEMP_BASE` | `$TMPDIR/claude-bridge` | where the per-process private `0700` cwd is made |
| `CLAUDE_BRIDGE_MAX_BODY_BYTES` | `67108864` (64 MiB) | hard cap on a request body, enforced while it is read (never buffered past the cap) → 413 |
| `CLAUDE_BRIDGE_DEFAULT_EFFORT` | `medium` | reasoning effort when a request names none (`low`/`medium`/`high`/`xhigh`/`max`) |
| `CLAUDE_BRIDGE_EFFORT_<MODEL_ID>` | unset | per-model default effort, id upper-cased with `_` (e.g. `CLAUDE_BRIDGE_EFFORT_CLAUDE_OPUS_5_5=high`); beats the default |
| `--fake` | off | scripted pseudo-model instead of the real binary |

### Reasoning effort

Agents run at **medium** effort by default; without this the
Claude default (high on Opus) applies. A request may override it with the
OpenAI/OpenRouter shapes `reasoning: {effort: "..."}` (what Hermes sends in
`extra_body.reasoning`) or top-level `reasoning_effort`. `none`/`minimal`/`low` map to
`low`; `medium`, `high`, `xhigh`, `max` pass through; `reasoning: {enabled: false}`
with no effort means `low`. Anything else is HTTP 400. Resolution order: request, then
`CLAUDE_BRIDGE_EFFORT_<MODEL_ID>`, then `CLAUDE_BRIDGE_DEFAULT_EFFORT`. The value goes
to the SDK as `Options.effort`. It is fixed when a Claude process starts, so a warm
process continuing a conversation keeps the effort it was started with. The effective
value is logged as `effort=` on `cold_start`, `process_started` and `request_ok`.

### Errors Hermes will see

| HTTP | code | when |
| --- | --- | --- |
| 503 | `CLAUDE_BRIDGE_STALL` | no Claude output within the stall watchdog (subscription cap / silent hang) |
| 503 | `CLAUDE_BRIDGE_NOT_SIGNED_IN` | Claude is not signed in — run `claude` once in a terminal and `/login` (503 so Hermes shows this message instead of "rejected your API key") |
| 400 | `context_length_exceeded` | Claude reports prompt-too-long (Hermes compresses on this) |
| 429 | `CLAUDE_BRIDGE_MAX_PROCS` | process cap reached (`Retry-After` header set) |
| 504 | `CLAUDE_BRIDGE_PARKED_TIMEOUT` | a parked call was never answered in time |
| 504 | `CLAUDE_BRIDGE_REQUEST_TIMEOUT` | per-request wall clock exceeded |
| 409 | `CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS` | a request's tool-result ids are not *exactly* the parked ids of one assistant turn (subset, superset, repeated id, unknown id, or ids from two parked turns) |
| 400 | `model_not_found` | unknown model id on a tools-bearing request |
| 400 | `CLAUDE_BRIDGE_BAD_REQUEST` | malformed request |
| 401 | `CLAUDE_BRIDGE_UNAUTHORIZED` | missing/wrong bearer key |
| 403 | `CLAUDE_BRIDGE_FORBIDDEN_HOST` | non-loopback `Host`/`Origin` |
| 413 | `CLAUDE_BRIDGE_BODY_TOO_LARGE` | request body exceeded `CLAUDE_BRIDGE_MAX_BODY_BYTES` |

If a failure happens after the SSE stream has started, the error arrives in-band
as an OpenAI error object on a choiceless chunk followed by `data: [DONE]`.

## Running it in the background (macOS launchd — TEMPLATE, NOT INSTALLED)

`deploy/launchd.plist.template` is a template only. **Nothing is installed by
this project.** If you want it, review it, fill in the key, and install it
yourself:

```bash
cp deploy/launchd.plist.template ~/Library/LaunchAgents/com.local.claude-bridge.plist
# edit the paths and the key, then:
launchctl load ~/Library/LaunchAgents/com.local.claude-bridge.plist
```

Put the key in the plist's `EnvironmentVariables` (or a `chmod 600` file you
source) — never in a repository.

## Limits (read this before you rely on it)

- **One subscription is shared by everything.** Every Hermes step is a Claude
  turn on the same Claude Max login: main turns, titles, compression, vision.
  Caps and rate limits apply to all of it at once, and the bridge is only one of
  the programs spending it.
- **Each Hermes step is a Claude turn** and holds a process slot. Four live
  conversations (or parked tool calls) is the cap by default; the fifth request
  gets 429.
- **A long tool wait holds a Claude process.** Hermes may wait for a human
  approval; the parked process stays alive for up to 30 minutes.
- **Claude cannot see files.** `cwd` is an empty temp dir and no built-in tools
  are enabled: Claude only reads what Hermes puts in the prompt.
- **`max_tokens` from Hermes is ignored.** Claude Code uses the model's native
  output ceiling. Hermes already recommends leaving `model.max_tokens` unset.
- **A cold start re-renders history as text.** When a request cannot be matched
  to a live process (new chat, Hermes restarted, history edited/compressed/
  forked, parked process timed out), a fresh Claude process receives the whole
  conversation as a text transcript. Tool calls appear as
  `[called mcp__hermes__<name>(<args>)]`, tool results as their text, images from
  data URLs as `[image #n]` with the image attached. This costs tokens and loses
  structured fidelity compared with a warm continuation.
- **A tool-result batch must match the parked ids exactly, or it is refused.**
  The ids a request brings back must be *precisely* the ids parked for one
  assistant turn, each exactly once. A subset, a superset, a repeated id, an
  unknown id, or ids belonging to two different parked turns is answered
  `409 CLAUDE_BRIDGE_PARTIAL_TOOL_RESULTS`; the bridge does **not** resume, does
  **not** cold start, and does **not** dispose or forget the parked process — its
  temp dir, its parked calls and its deadline stay exactly as they were. The
  parked call keeps its own 30-minute deadline, and if the missing id never
  arrives the process fails as `CLAUDE_BRIDGE_PARKED_TIMEOUT`. Send a turn's tool
  results together.
- **A parked call that runs out its deadline disposes its process, and a later
  request carrying that turn's batch then cold-starts.** The
  *deadline*, not the arrival of the results, is what ends a parked turn. In the
  window where the deadline has passed but the process has not yet been torn
  down, a request still receives `504 CLAUDE_BRIDGE_PARKED_TIMEOUT` (the resume
  path checks the deadline before anything else), not a cold start.
- **The CLI's stderr is dropped.** It is piped into the bridge and discarded
  (only a byte count is kept), so nothing a CLI writes to stderr — which can
  contain prompt text — can reach the bridge's console, its log, or you.
- **The bridge keeps no state on disk.** Everything lives in memory plus
  per-process temp dirs that are removed on teardown; restarting it drops all
  live conversations (Hermes then cold-starts).

## What is NOT verified

In plain words, by this project's own tests:

- **The test suite uses a scripted fake.** The bridge has been used daily against
  the real `claude` binary with Hermes, but only `scripts/smoke-real.mjs`
  exercises the real binary on your machine.
- **The subscription path is untested.** Nobody has observed what this bridge
  does at a real five-hour cap, or whether Claude Code's silent hang is what the
  stall watchdog sees first.
- **The bundled-CLI fallback is untested against a real spawn.** Which binary is
  used is decided and logged by the bridge (and unit-tested with an injected
  `PATH`), but no test may spawn a real `claude`: whether the SDK's bundled CLI
  is present and signed in on your machine is something only your own
  `scripts/smoke-real.mjs` run can show.
- **The explicit-path refusal is tested at the decision level, not against a
  spawn.** That an unusable `CLAUDE_BRIDGE_CLAUDE_PATH` makes the bridge exit
  before any spawn is unit-tested (`resolveClaudeBinarySource` /
  `buildProcessDeps` with an injected `exists`); the exit path through
  `node dist/server.js` was not run for it either.
- **`model.max_tokens` is not enforced**, so a long answer may be cut by the
  model's own ceiling rather than by Hermes' preference.
- **The launchd template is untested** and is not installed.
- **Claude's real streaming event order is inferred** from the SDK's type
  declarations and a daily-working reference implementation, not observed here.
  The bridge is written to tolerate both "tool_use blocks then handlers" and
  "handlers interleaved", and to work with or without `stream_event` partials —
  but only a real run proves which happens.

## Owner smoke test (the one script that touches the real binary)

```bash
cd claude-bridge
npm install && npm run build
node scripts/smoke-real.mjs
```

It starts the real bridge, then:

1. one prompt with tools off → text streams;
2. offers a fake `get_time` tool → Claude calls it → the script parks the call
   for 5 s → returns `12:00` → the final answer must contain `12:00`;
3. asks Claude to create a file with its `Bash`/`Write` tools → nothing may be
   called and no file may appear;
4. prints PASS/FAIL per step, plus the SDK version and the CLI version reported
   by the session — and nothing derived from a credential.

Exit code is 0 only if every step passed.
