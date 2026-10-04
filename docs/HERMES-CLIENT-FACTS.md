# HERMES-CLIENT-FACTS

**Subject:** what Hermes Agent v0.21 (Python) sends to, and accepts from, an OpenAI-Chat-Completions-compatible endpoint.
**Target (read-only):** `<hermes-agent checkout>`
**Purpose:** make the Claude-bridge's request mapping and response/SSE serialization exactly correct.
**Method:** static reading of the vendored tree. Every claim is followed by `file:line` and a short verbatim quote. Nothing here was executed against a live Hermes.

**Versions / grounding facts**
- `pyproject.toml:40` — `"openai==2.24.0",` (the OpenAI Python SDK is the wire client; it is a hard dependency, and it is *not* vendored in this tree, so SDK-internal pydantic schema is marked UNVERIFIED below where it matters).
- `hermes_constants.py:1094-1095` — `PARTIAL_STREAM_STUB_ID = "partial-stream-stub"` / `FINISH_REASON_LENGTH = "length"`.

---

## 1. Custom endpoint config: where base_url / API key / model id live, per-profile isolation, and the exact URL path

### 1.1 Where the three values are stored and read

A "Custom endpoint" is provider `custom` (bare) or `custom:<name>` (named entry in `providers:` / `custom_providers:`).

- Bare custom = `model.base_url` in `config.yaml` or `OPENAI_BASE_URL` in the environment:
  - `agent/auxiliary_client.py:2589-2590` — `"""Resolve the active custom/main endpoint like the main CLI (env OPENAI_BASE_URL or config-saved)."""`
  - `agent/auxiliary_client.py:2597-2600` — `openai_base = os.getenv("OPENAI_BASE_URL", "").strip().rstrip("/")` … `runtime = {"base_url": openai_base, "api_key": _scoped_key_env("OPENAI_API_KEY")}`.
- Named custom providers carry `base_url`, `model`, `api_key` / `key_env`, `api_mode` per entry:
  - `hermes_cli/runtime_provider_custom.py:481` — `base_url = ((explicit_base_url or "").strip() or custom_provider.get("base_url", "")).rstrip("/")`
  - `hermes_cli/runtime_provider_custom.py:493-496` — `candidates = [ explicit_key, _clean(custom_provider.get("api_key", "")), rp._getenv(_clean(custom_provider.get("key_env", "")), "").strip(), ... ]`
  - `hermes_cli/runtime_provider_custom.py:172-181` — `def _get_named_custom_provider(requested_provider: str)` reads `providers` then legacy `custom_providers` from `config.yaml`.
- The `model` id used on the wire is the agent's main model (`agent.model`), i.e. `model.default` in config or the CLI `--model`; named entries can pin their own via `custom_provider.get("model")` (see 1.3).
- Final client kwargs are assembled at init:
  - `agent/agent_init.py:785` — `client_kwargs = {"api_key": api_key, "base_url": base_url}`
  - `agent/agent_init.py:917-921` — `agent._client_kwargs = client_kwargs  # stored for rebuilding after interrupt` … `agent.api_key = client_kwargs.get("api_key", "")` … `agent.base_url = client_kwargs.get("base_url", agent.base_url)`
  - `agent/agent_runtime_helpers.py:1756` — `client = process_bootstrap.OpenAI(**client_kwargs)` (the actual SDK client).
  - `agent/client_lifecycle.py:481-482` — `self._client_kwargs["api_key"] = self.api_key` / `self._client_kwargs["base_url"] = self.base_url`.

### 1.2 Per-profile isolation

Profiles are separate `HERMES_HOME` trees; config (`providers:` / `custom_providers:` / `model.base_url`) is read from the active profile's `config.yaml` via `load_config()`/`load_config_readonly()` (`hermes_cli/config.py:688`, `hermes_cli/runtime_provider_custom.py:177`). Hermes also has a scoped-key helper `_scoped_key_env(name)` (`agent/auxiliary_client.py:1059`) so `key_env` resolves inside the active profile scope. Config is reloaded per resolution, not cached globally, so two profiles can point at two different custom endpoints. *(Exact HERMES_HOME-per-profile path resolution was not traced in this pass — see GAPS.)*

### 1.3 The exact URL path Hermes appends

**The AIAgent is built on the official `openai` SDK** (`agent/agent_runtime_helpers.py:1756`), and every chat call is `client.chat.completions.create(**kwargs)`:
- `agent/chat_completion_helpers.py:661` — `return make_client("chat_completion_request").chat.completions.create(**api_kwargs)`
- `agent/chat_completion_helpers.py:2872` — `return request_client.chat.completions.create(**stream_kwargs)`

The OpenAI SDK composes `POST {base_url}/chat/completions`. Hermes relies on exactly that, and **does not insert `/v1` itself**:
- `agent/agent_runtime_helpers.py:1265-1270` — `endpoint = "/responses" if agent.api_mode == "codex_responses" else "/chat/completions"` … `"url": f"{agent.base_url.rstrip('/')}{endpoint}"` (used for the request debug dump, so it mirrors the real URL).
- The sibling Anthropic path states the SDK's composition rule verbatim: `agent/anthropic_adapter.py:316-317` — `# SDK appends ``/v1/messages``.` (and therefore strips a trailing `/v1` at `agent/anthropic_adapter.py:319`).
- Hermes' own OpenAI-compatible **proxy** proves the same convention: `hermes_cli/proxy/server.py:144` — `rel_path = "/" + request.match_info.get("tail", "").lstrip("/")`; `hermes_cli/proxy/server.py:64` — `upstream_url = f"{cred.base_url.rstrip('/')}{rel_path}"`; `hermes_cli/proxy/adapters/base.py:35-37` — `"""Paths relative to the proxy's ``/v1`` mount (``"/chat/completions"`` ⇒ ``/v1/chat/completions``); ..."""`.
- All documented custom `base_url` examples include the `/v1` segment: `cli-config.yaml.example:149` — `#     base_url: "https://llm.internal.example.com/v1"`; `cli-config.yaml.example:164` — `#     base_url: https://api.router.com/v1`; `cli-config.yaml.example:202`, `:211`, `:216`, `:1889`.

**Conclusion:** with `base_url = http://127.0.0.1:PORT/v1`, Hermes POSTs to `http://127.0.0.1:PORT/v1/chat/completions`. If a user configures a base_url *without* `/v1`, Hermes will POST to `{base_url}/chat/completions` with no `/v1` inserted.

### 1.4 api_mode selection (which wire is used at all)

- `hermes_cli/runtime_provider_custom.py:418-419` — `return rp._runtime("custom", api_mode or rp._detect_api_mode_for_url(base_url) or "chat_completions", base_url, api_key or "no-key-required", **extra)`
- `hermes_cli/runtime_provider.py:124-131` — a base_url whose path ends in `/anthropic` or `/anthropic/v1`, or `api.kimi.com/.../coding`, is forced to `anthropic_messages`; everything else falls through to `chat_completions`.
- So a bridge served at a plain `http://host:port/v1` is spoken to as **chat_completions** unless the user sets `api_mode: anthropic_messages` in the provider entry.

---

## 2. Request body: exact JSON fields sent to /v1/chat/completions

Body construction: `agent/transports/chat_completions.py::ChatCompletionsTransport.build_kwargs` (`:353`), which for a provider **without** a registered profile (i.e. `custom`, which has no file under `plugins/model-providers/`) takes the legacy path (`:371-425`), ending in `_base_kwargs` + `_apply_max_tokens` + `extra_body` + `request_overrides` + `_finish_kwargs`.

### 2.1 Always present

- `agent/transports/chat_completions.py:268` — `api_kwargs: dict[str, Any] = {"model": model, "messages": sanitized}` → **`model`** and **`messages`**.
- `tools` only when non-empty: `agent/transports/chat_completions.py:280-282` — `if tools:` … `api_kwargs["tools"] = sanitize_moonshot_tools(tools) if is_moonshot_model(model) else tools`.
- `timeout` when a per-provider timeout is configured: `agent/transports/chat_completions.py:278-279` — `if params.get("timeout") is not None: api_kwargs["timeout"] = params["timeout"]` (this is an SDK-level kwarg, not part of the JSON body).

### 2.2 Output cap

- `agent/transports/chat_completions.py:250-261` — `def _apply_max_tokens(...)`: `"""Resolve max_tokens — priority: ephemeral > user > profile default > anthropic_max_output."""`
- The wire key is chosen by `run_agent.py:647-652` — `if (self._is_direct_openai_url() or self._is_azure_openai_url() or self._is_github_copilot_url() or model_forces_max_completion_tokens(self.model)): return {"max_completion_tokens": value} return {"max_tokens": value}`.
- **For a generic custom endpoint this is `max_tokens`.** It is **omitted entirely** when `model.max_tokens` is unset: `agent/agent_init.py:1672-1677` only assigns `agent.max_tokens` when `model.max_tokens` exists in config, and `cli-config.yaml.example:119` — `#   Leave unset to use the model's native output ceiling (recommended).`

### 2.3 temperature

- `agent/transports/chat_completions.py:263-277` — temperature is set **only on the profile path**: `if profile is not None:` … `api_kwargs["temperature"] = ...`.
- `agent/chat_completion_helpers.py:1485-1499` — the shared `_common` dict passed to `build_kwargs` contains no `temperature` key (it passes `max_tokens`, `ephemeral_max_output_tokens`, `reasoning_config`, `request_overrides`, …).
- ⇒ **For a bare custom endpoint, `temperature` is NOT sent** on the main path (unless a `custom_providers[].extra_body`/`request_overrides` injects it).

### 2.4 stream / stream_options (streaming only)

- `agent/chat_completion_helpers.py:2931-2933` — `def _open_stream(next_api_kwargs): timeout = _httpx.Timeout(...); return self._open_chat_stream({**next_api_kwargs, "stream": True, "timeout": timeout})`
- `agent/chat_completion_helpers.py:2864-2867` — `def _open_chat_stream(self, stream_kwargs): # Native Gemini rejects OpenAI's usage-streaming extension. if not is_native_gemini_base_url(self.agent.base_url): stream_kwargs["stream_options"] = {"include_usage": True}`

### 2.5 extra_body (SDK merges these keys into the top level of the JSON body)

- `agent/transports/chat_completions.py:414-415` — `if supports_reasoning and not is_lmstudio:` … `extra_body["reasoning"] = {"enabled": not off, "effort": "none" if off else _effort}` (only when `agent._supports_reasoning_extra_body()` is True, which `agent/reasoning_params.py:50-70` gates to Nous / Vercel AI Gateway / GitHub / LM Studio / Ollama Cloud / OpenRouter — **False for a generic custom endpoint**).
- `agent/transports/chat_completions.py:400-401` / `:396-398` — OpenRouter-only `provider` / `plugins` keys (not sent for custom).
- `agent/transports/chat_completions.py:428-431` — `if params.get("extra_body_additions"): extra_body.update(...)`; `if extra_body: api_kwargs["extra_body"] = extra_body`.
- `agent/agent_init.py:293-300` — a matching `custom_providers`/`providers` entry's `extra_body` dict is merged into `request_overrides["extra_body"]` and lands on the wire.

### 2.6 request_overrides (fast mode / config overrides)

- `agent/transports/chat_completions.py:432-433` — `if params.get("request_overrides"): api_kwargs.update(params["request_overrides"])`
- `agent/fast_mode.py:38-49` — `effective_request_overrides` may add `{"service_tier": "priority"}` (`hermes_cli/models.py:985-996`), gated to OpenAI/xAI models, so **normally absent for custom**.

### 2.7 prompt_cache_key

- `agent/transports/chat_completions.py:103-109` — `if not supports_prompt_cache_key: return` … `api_kwargs["prompt_cache_key"] = cache_key`
- `agent/transports/chat_completions.py:190-196` — `"""True only for the exact api.openai.com host (implies ``prompt_cache_key`` support).` … `Not a substring match: Azure / strict compat endpoints stay opt-in via ``supports_prompt_cache_key``."""`
- Test proving a bare/custom provider never gets it: `tests/agent/transports/test_chat_completions.py:829-835` — `@pytest.mark.parametrize("provider", [None, "anthropic", "custom"])` … `assert "prompt_cache_key" not in body`.

### 2.8 Fields Hermes does NOT send on the chat_completions wire

- `tool_choice`: never set by the chat_completions transport — the only `kwargs["tool_choice"]` in the codebase is the Codex/Responses transport: `agent/transports/codex.py:521` — `kwargs["tool_choice"] = "auto"`.
- `parallel_tool_calls`: same — only `agent/transports/codex.py:522` — `kwargs["parallel_tool_calls"] = True`.
- `response_format`: **not** set by the main agent loop; it *is* set by auxiliary title generation via `extra_body={"response_format": ...}` (see §6).
- `n`, `logprobs`, `user`, `seed`, `stop`: absent.

### 2.9 Message shape on the wire

- Internal-only keys are stripped: `agent/transports/chat_completions.py:35-38` — `_STRIP_MSG_KEYS = ("codex_reasoning_items", "codex_message_items", "tool_name", "effect_disposition", "timestamp", "platform_message_id", "api_content", "anthropic_content_blocks", "bedrock_content_blocks")`; tool-call keys `agent/transports/chat_completions.py:39` — `_STRIP_TC_KEYS = ("call_id", "response_item_id")`; any `_`-prefixed key is dropped (`:304-305`).
- A `system` first message becomes `developer` only for GPT-5/Codex model names: `agent/prompt_builder.py:561` — `DEVELOPER_ROLE_MODELS = ("gpt-5", "codex")`; applied at `agent/transports/chat_completions.py:240-244`.
- Empty assistant `tool_calls` are removed before send: `agent/transports/chat_completions.py:296-300` — `"""Sanitized copy of ``msg``, or None when nothing needs stripping.` … `(and an assistant ``tool_calls: []`` / ``null`` (strict providers reject both))."""` → `out_msg.pop("tool_calls", None)` (`:308-309`).

### 2.10 MUST-be-tolerated / MUST-be-present notes

- **MUST tolerate unknown top-level fields.** If the user configures `custom_providers[].extra_body` or fast-mode overrides, arbitrary extra keys appear. Also the design comment `agent/transports/chat_completions.py:75-80` explicitly notes many compat endpoints reject unknown fields (that's why Hermes is conservative), which cuts the other way: **the bridge must accept everything Hermes may send, and Hermes deliberately avoids sending junk.**
- **Nothing in the request body is mandatory for Hermes to function.** `tools` may be absent (no toolsets), `max_tokens`/`temperature` may be absent.

---

## 3. Streaming

### 3.1 How the SSE is read

Hermes does not hand-parse SSE in the main path; it consumes the **OpenAI SDK's stream object**:
- `agent/chat_completion_helpers.py:2864-2873` — `_open_chat_stream` → `request_client.chat.completions.create(**stream_kwargs)`
- `agent/chat_completion_helpers.py:2952` — `for chunk in _iter_provider_stream_chunks(stream, response=lambda: self._attempt_stream_response):`

SDK-level SSE decode failures are translated rather than crashing: `agent/chat_completion_helpers.py:240-248` — `"""Yield SDK chunks while translating SDK-level SSE decode failures."""` … `except json.JSONDecodeError as error:` → `raise _provider_stream_error_from_json_decode_error(...)`.

Chunk access is attribute-based off the SDK objects (so the bridge must emit standard OpenAI chunk JSON):
- `agent/chat_completion_helpers.py:2968-2976` — `if hasattr(chunk, "model") and chunk.model:` … `if not chunk.choices:` / `usage, finish_reason = self._choiceless_chunk(chunk, finish_reason)` … `choice = chunk.choices[0]` … `delta = choice.delta`
- `agent/chat_completion_helpers.py:2979-2981` — `finish_reason = getattr(choice, "finish_reason", None) or finish_reason` ; `if hasattr(chunk, "usage") and chunk.usage: usage_obj = chunk.usage`

Text and reasoning deltas: `agent/chat_completion_helpers.py:2983` — `reasoning_text = getattr(delta, "reasoning_content", None) or getattr(delta, "reasoning", None)`; `:2993` — `delta_content = flatten_message_text(getattr(delta, "content", None), sep="")`.

### 3.2 `[DONE]` — REQUIRED by the client

Hermes ships a proxy whose entire purpose is injecting the missing sentinel, and states the rule:
- `hermes_cli/proxy/sse_done.py:1-7` — `"""SSE ``[DONE]`` sentinel normalization for OpenAI-compatible proxies.` / `Strict OpenAI clients treat a stream without ``data: [DONE]`` as truncated. The tracker watches the forwarded SSE bytes and says whether to append ONE ``[DONE]`` after a *clean* upstream EOF: only after a terminal choice (``finish_reason`` non-null) or ``lastOne: true``; never after an error event, an interrupted stream, or when the upstream already sent ``[DONE]``."""`
- `hermes_cli/proxy/sse_done.py:15` — `DONE_SSE_FRAME = b"data: [DONE]\n\n"`
- `hermes_cli/proxy/sse_done.py:48-60` — `def should_append_done(self) -> bool:` … `return self.saw_terminal_finish or self.saw_last_one`
- `hermes_cli/proxy/sse_done.py:79-81` — `if payload == b"[DONE]": self.saw_done = True; return`
- Frame format used/accepted: `gateway/platforms/api_server.py:223-227` — `"""Encode one SSE frame (``event:`` line if given, then ``data: <json>\n\n``) ..."""` → `return f"{prefix}data: {json.dumps(data, ensure_ascii=ensure_ascii)}\n\n".encode()`
- Test fixture of the exact accepted shape: `tests/agent/transports/test_chat_completions.py:746-748` — `'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\n'` / `"data: [DONE]\n\n"`.

### 3.3 Tool-call delta assembly — `_ToolCallAccumulator`

`agent/chat_completion_helpers.py:2619-2681`:
- `:2620-2622` — `"""Assemble streamed tool-call deltas into complete ``tool_calls`` entries (``acc``: slot index -> entry dict). Ollama-compatible endpoints reuse index 0 for every call in a parallel batch, distinguishing them only by id, so a new id at an already-seen raw index is redirected to a fresh slot."""`
- `:2640-2663` — `def feed(self, tc_delta)`: reads `index` (`:2642-2644` — `raw_idx = getattr(tc_delta, "index", None); if raw_idx is None: raw_idx = 0`), reads `id` (`:2645-2647`; integer ids are stringified, `:2648-2649` `if isinstance(tc_id, int):  # Poolside sends integer ids`), re-slots on a new id at a seen index (`:2652-2655`).
- Entry skeleton — **this is the shape the bridge must emit deltas towards**: `:2658-2660` — `entry = self.acc.setdefault(idx, {"id": tc_id or "", "type": "function", "function": {"name": "", "arguments": ""}, "extra_content": None})`
- Names are **assigned, not concatenated** (`:2665-2668` — `entry["function"]["name"] = tc_function.name`, with the comment `# Assignment, not +=: names arrive complete and some providers (MiniMax via NVIDIA NIM) resend the full name every chunk`), while **arguments are accumulated and joined once**: `:2634-2638` — `def materialize(self) -> dict: """Join buffered argument deltas into each entry's ``arguments``; idempotent. Returns ``acc``."""` → `self.acc[idx]["function"]["arguments"] = "".join(parts)`.
- ⇒ The bridge may stream `function.arguments` in many small deltas; it may also stream the whole name once. `index` may be omitted (defaults to 0) but parallel calls in one turn **must carry distinct `id`s**.

### 3.4 Does Hermes require an explicit finish_reason? — YES

- `agent/chat_completion_helpers.py:3074-3077` — `"""Assemble the non-streaming-shaped response after the chunk loop. A stream ending with no finish_reason is a drop, not a completion: return a partial-stream stub so the loop fails fast instead of executing empty args or stamping "stop"."""`
- `agent/chat_completion_helpers.py:3082-3084` — `if finish_reason is None and not content_parts and not reasoning_parts and not tool_calls_acc: raise EmptyStreamError("Provider returned an empty stream with no finish_reason (possible upstream error or malformed SSE response).")`
- `agent/chat_completion_helpers.py:3085-3094` — tool args incomplete **and** no finish_reason ⇒ mid-tool-call drop ⇒ `_build_partial_stream_stub(...)`.
- `agent/chat_completion_helpers.py:3095-3100` — text-only, no tool calls, **and `usage_obj is None`** ⇒ `"""Text-only drop: otherwise the partial text is stamped "stop" and the next step is lost. A usage object proves the provider finished (include_usage's final chunk)."""` ⇒ partial stub.
- `agent/chat_completion_helpers.py:3101` — `effective_finish_reason = "length" if has_truncated_tool_args else (finish_reason or "stop")`
- ⇒ **Emit a non-null `finish_reason` on the terminal choice chunk (and/or a usage chunk) or Hermes treats the stream as truncated.**

### 3.5 finish_reason values Hermes treats specially

- `"length"` → truncation-recovery path: `agent/turn_truncation.py:1` — `"""Truncation recovery (``finish_reason == "length"``) for the conversation turn loop.`; dispatch at `agent/turn_response_check.py:163-165` — `if finish_reason == "length": _tv = recover_from_truncation(...)`.
- `"content_filter"` → refusal path: `agent/turn_response_check.py:145-148` — `# HTTP-200 refusals are deterministic: one fallback try, else return the refusal.` / `if finish_reason == "content_filter":`
- `"tool_calls"` with an empty/absent `tool_calls` array → re-prompt nudge: `agent/turn_final_response.py:169-176` — `# Dropped tool-call recovery (copilot/Claude): finish_reason="tool_calls" with empty tool_calls would end the turn unstarted; re-prompt (max 3 CONSECUTIVE stalls).` / `if (finish_reason == "tool_calls" and not assistant_message.tool_calls and ...)`.
- `"error"` / `"error_finish"` → provider-error-as-content: `agent/chat_completion_helpers.py:47` — `_PROVIDER_STREAM_ERROR_FINISH_REASONS = {"error", "error_finish"}`; consumed by `agent/chat_completion_helpers.py:293-299` — `def _provider_stream_error_from_text(text, finish_reason, ...)` … `if str(finish_reason or "").lower() not in _PROVIDER_STREAM_ERROR_FINISH_REASONS: return None`. **The bridge must never use these as a normal terminal reason.**
- Any other/null → `"stop"` fallback at `agent/chat_completion_helpers.py:3101`.
- The streamed response is then re-shaped into a non-streaming-looking object: `agent/chat_completion_helpers.py:3107-3109` — `message = SimpleNamespace(role=role, content=full_content, tool_calls=mock_tool_calls, reasoning_content=full_reasoning)` … `SimpleNamespace(id="stream-" + str(uuid.uuid4()), model=model_name, usage=usage_obj, choices=[SimpleNamespace(index=0, message=message, finish_reason=effective_finish_reason)])` — i.e. **the assembled `id` is synthesised locally; the bridge's chunk `id` is not used.**

### 3.6 Usage in the final chunk — requested, not strictly mandatory

- Hermes **asks for it**: `agent/chat_completion_helpers.py:2866-2867` — `stream_kwargs["stream_options"] = {"include_usage": True}`.
- It is **used if present**: `:2844` — `usage = chunk.usage if hasattr(chunk, "usage") and chunk.usage else None  # final usage chunk`; `:2980-2981` — `if hasattr(chunk, "usage") and chunk.usage: usage_obj = chunk.usage`.
- But the only place its absence changes behaviour is the text-only-drop heuristic (§3.4, `:3095-3100`). Otherwise missing usage degrades to "usage=unavailable" accounting: `agent/turn_usage.py:80-86` — `if not (hasattr(response, 'usage') and response.usage):` … `"API call #%d: model=%s provider=%s in=? out=? total=? latency=%.1fs usage=unavailable"`.
- Recommendation: **send a final `{"choices": [], "usage": {...}}` chunk then `data: [DONE]`.**

### 3.7 Usage on a chunk with empty choices — YES, accepted

- `agent/chat_completion_helpers.py:2839-2844` — `def _choiceless_chunk(chunk, finish_reason): """Chunk with empty ``choices`` -> ``(usage, finish_reason)``. ..."""` / `usage = chunk.usage if hasattr(chunk, "usage") and chunk.usage else None  # final usage chunk`
- `agent/chat_completion_helpers.py:2970-2973` — `if not chunk.choices: usage, finish_reason = self._choiceless_chunk(chunk, finish_reason); usage_obj = usage or usage_obj; continue`
- Bonus: `choices: []` with `"lastOne": true/1/"true"` and no finish_reason is treated as a clean terminal `stop`: `agent/chat_completion_helpers.py:2857-2861` — `last_one = getattr(chunk, "lastOne", None)` … `if last_one in (True, 1, "true") and finish_reason is None: finish_reason = "stop"`.
- In-stream error objects on a choiceless chunk are raised rather than swallowed: `:2847-2853` — reads `error_type` / `error_message` and raises `ProviderStreamError`.

### 3.8 SSE-echo guard (bridge must not do this)

If the bridge ever put raw SSE text into `delta.content`, Hermes buffers it and can classify it as an error: `agent/chat_completion_helpers.py:260-264` — `"""Return True while pending text still looks like an SSE control block."""`; consumed at `:2998-3002`. Non-JSON SSE `data:` raises a `ProviderStreamError` (see `:221-232`).

---

## 4. Non-streaming

### 4.1 The call

- `agent/chat_completion_helpers.py:633-661` — `_dispatch_nonstreaming_api_request` … `return make_client("chat_completion_request").chat.completions.create(**api_kwargs)`
- `agent/chat_completion_helpers.py:1297-1311` — `interruptible_api_call(...)` wraps `_NonStreamRequest` (`:1087`).

### 4.2 How the response is read

Normalization (`agent/transports/chat_completions.py:488-533`):
- `:494` — `choice = response.choices[0]`
- `:495-498` — `msg = getattr(choice, "message", None)` … `_fr = getattr(choice, "finish_reason", None)` … `finish_reason = (str(_fr) if isinstance(_fr, int) else _fr) or "stop"  # Poolside returns int finish_reason`
- `:500-501` — `if getattr(msg, "tool_calls", None): tool_calls = [tc for tc in (self._normalize_tool_call(tc) for tc in msg.tool_calls) if tc is not None]`
- `:503` — `usage = Usage.from_openai(response.usage) if hasattr(response, "usage") and response.usage else None`
- Tool-call field reads (`agent/transports/chat_completions.py:530-547`): `tc_function = getattr(tc, "function", None)`; `name = getattr(tc_function, "name", None)`; `if tc_function is None or name is None: return None`; `arguments = getattr(tc_function, "arguments", None)`; `arguments="{}" if arguments is None else arguments`; `id=getattr(tc, "id", None)`.
- Usage fields (`agent/transports/types.py:55-57`): `return cls(**{k: getattr(u, k, 0) or 0 for k in ("prompt_tokens", "completion_tokens", "total_tokens")})` — **all three are `getattr(..., 0)`-tolerant; missing counts become 0.**

### 4.3 Expected tool_calls entry shape = OpenAI `ChatCompletionMessageToolCall`

- Hermes imports the real SDK type and constructs it: `agent/acp_openai_bridge.py:18` — `from openai.types.chat.chat_completion_message_tool_call import ChatCompletionMessageToolCall, Function`; `:75-80` — `return ChatCompletionMessageToolCall(id=call_id, call_id=call_id, response_item_id=None, type="function", function=Function(name=name, arguments=arguments),)`
- On the streaming path Hermes synthesizes the same shape: `agent/chat_completion_helpers.py:3067-3069` — `SimpleNamespace(id=tc["id"], type=tc["type"], extra_content=tc.get("extra_content"), function=SimpleNamespace(name=..., arguments=arguments))`
- The contract is spelled out for text-bridged clients: `agent/acp_openai_bridge.py:25-28` — `"... containing id/type/function{name,arguments}. arguments must be a JSON string."`

**So a tool call in `message.tool_calls` must be:** `{"id": "<string>", "type": "function", "function": {"name": "<string>", "arguments": "<JSON string>"}}`.
- `arguments` **must be a JSON string**, not an object: Hermes `json.loads(...)` it — `agent/chat_completion_helpers.py:3052-3062` — `arguments = tc["function"]["arguments"]` … `json.loads(arguments)` … on failure `_repair_tool_call_arguments(...)`, and `"{}"` means unrepairable → flagged truncated.
- Tool-call entry missing `function.name` is **silently dropped**: `agent/transports/chat_completions.py:530-535` — `"""One SDK tool call -> ToolCall; None when it lacks a function/name (matches Relay's codec)."""`
- `id` may be missing/blank (Hermes mints one, see §5.1).

### 4.4 Response validation

- `agent/transports/chat_completions.py:549-551` — `def validate_response(self, response): """Check that response has valid choices.""" return bool(response is not None and getattr(response, "choices", None))`
- Enforced at `agent/turn_recovery.py:1021-1027` — `def validate_response_shape(agent, response): """Validate the raw provider response via the transport; ..."""` / `if agent._get_transport().validate_response(response): return False, []`.
- ⇒ **`choices` must be a non-empty list.**

### 4.5 Usage is optional on non-streaming too

Hermes' own test fixture returns a full completion with **no** `usage` field: `tests/agent/transports/test_chat_completions.py:750-758` — `return httpx.Response(200, json={ "id": "chatcmpl_1", "object": "chat.completion", "created": 0, "model": kwargs["model"], "choices": [{ "index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop", }], })`.
Consequences of omitting it: `agent/turn_usage.py:80-86` (logged as `usage=unavailable`), and the empty-response guard fails open (`agent/empty_response_guard.py:160-166` — `"""... failing open."""` / `if output is None or getattr(canonical, "prompt_tokens", 0) <= 0: return (False, False)`).

---

## 5. Tool-result messages sent back to the model

### 5.1 Shape

- `agent/tool_dispatch_helpers.py:369-390` — `def make_tool_result_message(name, content, tool_call_id, *, effect_disposition=None) -> dict: """Build a tool-result message: OpenAI ``name`` (wire format) plus internal ``tool_name`` (session DB). ..."""` → message dict:
  ```
  "role": "tool",
  "name": name,
  "tool_name": name,
  "content": wrapped,
  "tool_call_id": tool_call_id,
  ```
- `tool_name` is internal and stripped before send (`agent/transports/chat_completions.py:36`).
- Invalid-name calls get a tool message too: `agent/turn_tool_round.py:103-110` — `"role": "tool", "name": tc.function.name, "tool_call_id": coalesce_tool_call_id(tc), "content": _invalid_tool_name_error_content(...)`.

### 5.2 Ordering relative to the assistant message with tool_calls

- Assistant first, then results: `agent/turn_tool_round.py:96-99` — `assistant_msg, duplicate_previous_interim = stage_tool_call_message(...)` … `append_message(messages, assistant_msg)`.
- Results appended per call in a defined order: `agent/tool_executor.py:1012-1013` — `tool_message = make_tool_result_message(function_name, _tool_content, tool_call_id, effect_disposition=effect_disposition)` … `messages.append(tool_message)`.
- **Positional adjacency is a hard invariant Hermes enforces on itself before every request** (and strict providers enforce on Hermes): `agent/agent_runtime_helpers.py:2620-2629` — `# Kimi) enforce the POSITIONAL invariant: an assistant message carrying tool_calls must be IMMEDIATELY followed by tool messages covering every tool_call_id.` … `"... must be followed by tool messages responding to each 'tool_call_id' (insufficient tool messages following tool_calls message)"`.
- Missing results are stubbed, orphan results are dropped: `agent/agent_runtime_helpers.py:2641-2648` — `"content": "[Result unavailable — see context summary above]", "tool_call_id": coalesce_tool_call_id(tc) or key`.
- ⇒ **The bridge must preserve the transcript order it is given; no reordering is needed on its side, but if it ever reorders it will produce Hermes-side 400s.**

### 5.3 Assistant message replay (what Hermes sends back for the assistant turn)

- `agent/chat_completion_helpers.py:1622-1624` — `tc_dict = {"id": call_id, "call_id": call_id, "response_item_id": response_item_id, "type": tool_call.type, "function": {"name": tool_call.function.name, "arguments": tool_call.function.arguments}}`
- `call_id`/`response_item_id` are stripped before the wire (`agent/transports/chat_completions.py:39`), leaving `{"id","type","function":{...}}` — the standard shape.
- `agent/chat_completion_helpers.py:1727-1728` — `if assistant_tool_calls: msg["tool_calls"] = [_assistant_tool_call_dict(agent, tc, i) for i, tc in enumerate(assistant_tool_calls)]`

---

## 6. Auxiliary calls (titles / compression / vision / etc.)

Central entry point `agent/auxiliary_client.py:6938-6946` — `def call_llm(task=None, *, provider=None, model=None, base_url=None, api_key=None, main_runtime=None, messages, temperature=None, max_tokens=None, tools=None, timeout=None, extra_body=None, reasoning_config=None, extra_headers=None, api_mode=None, stream=False, stream_options=None, route_info=None, latency_info=None)`.

### 6.1 Which model id

Default config for an unset aux task is "inherit the main model":
- `hermes_cli/config_defaults.py:14` — `d = {"provider": "auto", "model": "", "base_url": "", "api_key": "", "timeout": timeout, "extra_body": {}}`
- `hermes_cli/config_defaults.py:688-691` — `# Per-task blocks share one shape (_aux): provider "auto" = inherit the main model; base_url overrides provider; ...`
- `hermes_cli/config_defaults.py:705-719` — `"title_generation": { "enabled": True, "provider": "auto", "model": "", ... }`
- `hermes_cli/config_defaults.py:692` — `"vision": _aux(120, download_timeout=30),`; `:696` — `"compression": _aux(120, max_output_tokens=0),`
- `hermes_cli/config_defaults.py:680-681` — the aux auto-chain's OpenRouter fallback default is `google/gemini-3.6-flash` (PAID), only reached when the primary route is unusable.
- On a custom endpoint, the aux client falls back to the main model id, with `gpt-4o-mini` only as a last resort: `agent/auxiliary_client.py:2667` — `model = _read_main_model_for_aux() or "gpt-4o-mini"`.
- `agent/auxiliary_client.py:4040-4056` — `_main_route_target(...)`: `main_model = str(runtime.get("model") or _read_main_model() or "")` — i.e. **the main model id**; `# Latency-critical tasks (titling only) opt in to the provider's fast model.` (opt-in only: `_FAST_MODEL_TASKS = frozenset({"title_generation"})`, `agent/auxiliary_client.py:798-804`).
- Vision keeps the main model unless a provider vision default exists (`agent/auxiliary_client.py:4951-4957` — `provider_vision_default = _resolve_provider_vision_default(main_provider); vision_model = provider_vision_default or main_model`), and `_PROVIDER_VISION_MODELS` has no `custom` entry (`agent/auxiliary_client.py:811`).

**⇒ For a Custom endpoint, aux calls use the same model id as the main model unless the user overrides `auxiliary.<task>.model`.**

### 6.2 Tools in aux calls — NO

- Title generation: `agent/title_generator.py:264-271` — `response = call_llm( task="title_generation", messages=[{"role": "system", "content": prompt}, {"role": "user", "content": user_snippet}], max_tokens=64, temperature=0.3, timeout=timeout, main_runtime=main_runtime, extra_body={"response_format": _TITLE_RESPONSE_FORMAT}, )` — **no `tools`; sets `temperature: 0.3`, `max_tokens: 64`, and `response_format` via extra_body.**
- Compression: `agent/context_compressor.py:3180-3190` — `call_kwargs: Dict[str, Any] = { "task": "compression", "main_runtime": {...}, "messages": [{"role": "user", "content": prompt}], "route_info": _aux_route, # NO max_tokens: ... }` — **no `tools`, no `max_tokens`, single user message.**
- Micro-compaction (same task): `agent/micro_compaction.py:120-125` — `call_kwargs = { "task": "compression", "messages": ..., "max_tokens": min(1500, ...), "temperature": 0.1, }` — **no `tools`.**
- Vision: `tools/vision_tools.py:641-642` — `return {"task": "vision", "messages": messages, "temperature": temperature, "timeout": timeout, **({"model": model} if model else {})}` — **no `tools`**; messages are a single user message with `image_url`/`video_url` data-URL parts (`tools/vision_tools.py:645-648`).
- The plumbing only adds `tools` when a caller passes them: `agent/auxiliary_client.py:5950-5951` — `if tools: kwargs["tools"] = _dedupe_tool_names(tools, provider, model)`.
- Aux responses are validated for `choices[0].message` only: `agent/auxiliary_client.py:5992-6002` — `if not choices or not hasattr(choices[0], "message"): raise AttributeError("missing choices[0].message")` … `"Expected object with .choices[0].message — check provider adapter or custom endpoint compatibility."`

**⇒ The bridge may serve aux calls as a no-tools one-shot, but it MUST still return `choices[0].message.content` (a plain string) and must tolerate `response_format`, `temperature`, and omitted `max_tokens`.**

### 6.3 Are aux calls streamed?

- Default: **no** — a plain `client.chat.completions.create(**kwargs)` (`agent/auxiliary_client.py:6233-6237`).
- Exceptions: (a) a progress hook is active, or (b) the provider is "stream-only": `agent/auxiliary_client.py:6136-6150` — `def _provider_requires_stream(provider, base_url): """Providers that only accept streaming (non-stream=400): Tencent Copilot, any ``auxiliary.stream_only_base_urls`` substring, and the managed local llama-server ..."""`
- When it does stream, the request gains the same OpenAI extension: `agent/auxiliary_client.py:6207-6211` — `stream_kwargs["stream"] = True` / `stream_kwargs["stream_options"] = {"include_usage": True}`, then it is re-aggregated (`_ChatStreamAccumulator`, `:6298-6428`), which tolerates choiceless chunks (`:6378-6380` — `choices = getattr(chunk, "choices", None) or []; if not choices: return`).
- ⇒ **A config `auxiliary.stream_only_base_urls` entry matching your bridge would force streamed aux calls; otherwise expect non-streamed.** Supporting both is safest.

### 6.4 Aux request body extras

- `agent/auxiliary_client.py:5927-5973` — `_build_call_kwargs`: `kwargs = {"model": model, "messages": messages, "timeout": timeout}` … `if temperature is not None: ... kwargs["temperature"] = temperature` … `if max_tokens is not None and _forwards_max_tokens(...): kwargs.update(auxiliary_max_tokens_param(max_tokens, model=model))` … `if merged_extra := _merge_aux_extra_body(...): kwargs["extra_body"] = merged_extra`.
- Task-level `extra_body` from config is merged (`agent/auxiliary_client.py:6545-6547` — `effective_extra_body = _get_task_extra_body(task); effective_extra_body.update(extra_body or {})`).
- Aux accounting only needs `response.usage` if present: `agent/aux_accounting.py:70-77` — `raw_usage = getattr(response, "usage", None); if raw_usage is None: return`.

---

## 7. Context overflow — exact code/string and HTTP status

### 7.1 The structured error code

- `agent/error_classifier.py:420` — `**dict.fromkeys(("context_length_exceeded", "max_tokens_exceeded"), _V_CONTEXT_OVERFLOW),` — **`context_length_exceeded` is confirmed** as the structured `code` that maps to `context_overflow`.
- `agent/error_classifier.py:346` — `_V_CONTEXT_OVERFLOW = _v(_R.context_overflow, should_compress=True)` — the verdict sets `should_compress=True`.
- The code is read from `error.code`/`error.error_code`/nested `error.message` JSON: `agent/error_classifier.py:879-903` (`_code_from_payload(payload, ("code", "error_code"), peek_message=True)` … `def _extract_error_code(body)`).

### 7.2 Message fallbacks (used when there is no usable code)

- `agent/error_classifier.py:177-190` — `_CONTEXT_OVERFLOW_PATTERNS = ( "context length", "context size", "maximum context", "token limit", "too many tokens", "reduce the length", "exceeds the limit", "context window", "prompt is too long", "prompt exceeds max length", "max_tokens", "maximum number of tokens", "exceeds the max_model_len", "max_model_len", "prompt length", "input is too long", "maximum model length", "context length exceeded", "truncating input", "slot context", "n_ctx_slot", "超过最大长度", "上下文长度", "tokens in request more than max tokens allowed", ... )`
- Note the phrase other code refers to: `agent/conversation_compression.py:1334` — `a real upstream ``context_length_exceeded`` auto-reset (wipe) a session whose compression was merely`.

### 7.3 Which HTTP status matters

Stage order is `_STAGES` = plugin → provider special cases → **status** → MoA → **error code** → message patterns → transport (`agent/error_classifier.py:590-593`). Status therefore wins when it has a handler:

- **400** → `_classify_400` (`agent/error_classifier.py:674-721`). Overflow is reached through `_400_TAIL_RULES` (`:394-399`, which include `_CONTEXT_OVERFLOW_PATTERNS`) or the generic-large-session branch (`:715-719` — `is_generic = len(body_msg) < 30 or body_msg in {"error", ""}` … `if is_generic and c.large_session(0.4, 80000, 80): return _V_CONTEXT_OVERFLOW`). ⇒ **400 + `code:"context_length_exceeded"` + a message matching one of the patterns is reliably classified as overflow.**
- **413** → `_STATUS_HANDLERS[413]` = `_V_PAYLOAD_TOO_LARGE` (`agent/error_classifier.py:726`), and `_V_PAYLOAD_TOO_LARGE = _v(_R.payload_too_large, should_compress=True)` (`:347`). Handled by its own recovery: `agent/turn_overflow.py:452-453` — `if classified.reason == FailoverReason.payload_too_large: return _recover_payload_too_large(st, _retry)`.
- **5xx (500/502/503/529)** → an overflow phrase in the body is still honoured: `agent/error_classifier.py:381-383` — `_OVERFLOW_AS_5XX_RULES = ( (_EMPTY_PROVIDER_RESPONSE_PATTERNS, _V_SERVER_ERROR), (_CONTEXT_OVERFLOW_PATTERNS, _V_CONTEXT_OVERFLOW), )`.
- **Status-less disconnect on a large session** can also be read as overflow: `agent/error_classifier.py:554-566` — `if any(p in msg for p in _SERVER_DISCONNECT_PATTERNS) and not c.status_code:` … `return _V_CONTEXT_OVERFLOW if c.large_session(0.6, 120000, 200) else _V_TIMEOUT` (with a reasoning-model override to timeout).

### 7.4 What Hermes does with it

- `agent/turn_overflow.py:457-465` — `st.is_context_length_error = ( classified.reason == FailoverReason.context_overflow or wrapped_output_cap_budget is not None )` / `if st.is_context_length_error: return _recover_context_length(st, _retry, error_msg)`.
- `agent/turn_overflow.py:358-361` — `"""Context-length error. Two shapes: "prompt too long" = INPUT overflows the window (shrink context_length + compress); "max_tokens too large" = input fits but input + max_tokens > window (shrink the OUTPUT cap only)."""`
- Compression is triggered at `agent/turn_overflow.py:396` — `deferred, shrank, new_tokens = st.compress_scored_by_tokens(st.request_tokens(), fail_on_timeout=True)`.

**⇒ Recommended bridge behaviour for overflow: HTTP 400 with body `{"error": {"message": "This model's maximum context length is N tokens... context length exceeded", "type": "invalid_request_error", "code": "context_length_exceeded"}}`.**

---

## 8. Auth header

- The client is the OpenAI SDK with `api_key` set: `agent/agent_init.py:785` — `client_kwargs = {"api_key": api_key, "base_url": base_url}`; `agent/agent_runtime_helpers.py:1756` — `client = process_bootstrap.OpenAI(**client_kwargs)`. The SDK therefore sends **`Authorization: Bearer <api_key>`** by default. Hermes' own request dump asserts that header name: `agent/agent_runtime_helpers.py:1270-1273` — `"headers": { "Authorization": f"Bearer {agent._mask_api_key_for_logs(api_key)}", "Content-Type": "application/json", }`.
- No default header is added for an arbitrary custom host: `agent/agent_init.py:977-981` — `def _host_default_headers_factory(base_url): for host, factory in _HOST_DEFAULT_HEADERS: if base_url_host_matches(base_url, host): return factory; return None` (hosts are OpenRouter, ai-gateway, NVIDIA, routermint, GitHub Copilot, api.kimi.com, qwen, chatgpt.com, x.ai — see `agent/client_lifecycle.py:38-50`).
- **No API key configured ⇒ the literal placeholder is sent**: `hermes_cli/runtime_provider_custom.py:418-419` — `_custom_runtime(..., base_url, api_key or "no-key-required", ...)`; and `agent/auxiliary_client.py:2610-2612` — `# Local servers (Ollama, vLLM, ...) ignore auth but the SDK needs a non-empty key.` … `custom_key = "no-key-required"`. Expect `Authorization: Bearer no-key-required` if the user leaves the key blank.
- Users can override/extend headers per custom provider: `hermes_cli/config_providers.py:465-477` — `"""Merge per-provider ``extra_headers`` onto OpenAI client ``default_headers`` (provider wins over SDK defaults, most specific level). SECURITY: values may carry credentials; never log."""` (`cli-config.yaml.example:147-154` documents `extra_headers` under `providers:`) — including the ability to replace `Authorization`.
- The SDK also sends its own fingerprint headers (`User-Agent: OpenAI/Python ...`, `X-Stainless-*`); Hermes explicitly strips/edits these only for specific vendors (`agent/auxiliary_client.py:837-840` — `"""Merge user ``model.default_headers`` onto resolved headers (user wins; ``model.extra_headers`` alias wins over both). Mirrors ``AIAgent._apply_user_default_headers`` so a custom endpoint behind a WAF rejecting ``User-Agent`` / ``X-Stainless-*`` works for aux calls. SECURITY: never log values."""`).

**⇒ The bridge should accept `Authorization: Bearer <anything>` (including `no-key-required`) and ignore it unless it wants to enforce a token. Content-Type is `application/json`.**

---

## 9. Hard requirements the bridge could violate

**Response envelope (non-streaming)** — Hermes' own reference OpenAI server emits exactly this and it is the safest contract to mirror:
- `gateway/platforms/api_server_openai_routes.py:561-566` — `response_data = { "id": completion_id, "object": "chat.completion", "created": created, "model": model_name, "choices": [{"index": 0, "message": {"role": "assistant", "content": final_response}, "finish_reason": finish_reason}], "usage": _chat_usage_payload(usage)}`
- `gateway/platforms/api_server_openai_routes.py:486` — `completion_id = f"chatcmpl-{uuid.uuid4().hex[:29]}"`
- `gateway/platforms/api_server.py:637-640` — `"""OpenAI Chat Completions ``usage`` block (prompt/completion/total) from the agent's usage."""` → `dict(zip(("prompt_tokens", "completion_tokens", "total_tokens"), values))`
- Gemini's native shim builds the same envelope for the SDK: `agent/gemini_native_adapter.py:445-448` — `"""OpenAI chat.completion / chat.completion.chunk envelope around one choice."""` → `cls(id=f"chatcmpl-{uuid.uuid4().hex[:12]}", object=object_, created=int(time.time()), model=model, choices=[choice], usage=usage)`

**What Hermes itself strictly dereferences:** `response.choices[0]` (`agent/transports/chat_completions.py:494`), `.choices` truthiness (`:551`), `message`, `message.tool_calls`, `choice.finish_reason`, `response.usage` (all `getattr`-guarded). **Missing `object`/`created`/`id`/`model` would be caught by the OpenAI SDK's pydantic model before Hermes ever sees the object** — that is the practical reason to emit them, but the exact pydantic required-field list is **not verifiable inside this repo** (the SDK is a pinned external dependency, `pyproject.toml:40` ⇒ `openai==2.24.0`). See GAPS.

**Streaming envelope:**
- `gateway/platforms/api_server_openai_routes.py:623-625` — `def _chunk(delta, finish_reason=None, **extra): return {"id": completion_id, "object": "chat.completion.chunk", "created": created, "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}], **extra}`
- **`data: [DONE]` is required** — `hermes_cli/proxy/sse_done.py:3` — `Strict OpenAI clients treat a stream without ``data: [DONE]`` as truncated.`

**Concrete failure modes to avoid**
1. No `finish_reason` on the terminal chunk ⇒ partial-stream stub / `EmptyStreamError` (§3.4).
2. No `[DONE]` ⇒ treated as truncated (§3.2).
3. `function.arguments` as a JSON object instead of a JSON string ⇒ `json.loads` fails / repair path (§4.3).
4. Tool-call deltas that resend the *same* name with `+=` semantics — Hermes assigns names, so resending is safe; but **changing `id` mid-call at the same index spawns an extra slot** (§3.3, `:2652-2655`) — a parallel batch must use stable distinct ids per call.
5. Returning an overflow as a bare `400 {"error": {"message": "..."}}` with no matching phrase ⇒ classified `format_error` and Hermes may fall back instead of compressing (§7.3).
6. Using `finish_reason: "error"`/`"error_finish"` for normal completion ⇒ Hermes raises `ProviderStreamError` (§3.5).
7. Emitting raw SSE text inside `delta.content` ⇒ SSE-echo guard/error (§3.8).
8. Omitting `usage` entirely: **survivable** but logs `usage=unavailable`, disables cost/compaction adjudication, and (on a text-only stream) makes Hermes treat the stream as dropped (§3.4, `:3095-3100`). Send it.

---

## GAPS / UNVERIFIED

1. **OpenAI SDK pydantic required fields.** `openai==2.24.0` (`pyproject.toml:40`) is not vendored and not installed in this environment, so I could not read `openai/types/chat/chat_completion.py` to prove which of `id` / `object` / `created` / `model` / `choices` are hard-required by the SDK before Hermes sees the object. Hermes' own reference server emits all of them (`gateway/platforms/api_server_openai_routes.py:561-566`, `agent/gemini_native_adapter.py:445-448`), and its own test fixtures emit `id`/`object`/`created`/`model`/`choices` (§4.5) — treat all five as required, but this is inference, not a file:line proof of the SDK schema.
2. **`stream_options` acceptance/strictness per bridge.** Hermes always sends `{"include_usage": true}` on the main streaming path (`agent/chat_completion_helpers.py:2866-2867`) except native Gemini. Whether an endpoint that rejects `stream_options` is tolerated was not traced (no 400-retry-without-stream_options path was found for chat_completions; only the Codex/aux paths have parameter-drop rungs, e.g. `agent/codex_responses_adapter.py:742`).
3. **Per-profile HERMES_HOME path resolution.** I confirmed config is read from the active profile's `config.yaml` and that `_scoped_key_env` exists (`agent/auxiliary_client.py:1059`), but I did not trace the concrete `$HERMES_HOME` → profile directory mapping or the profile-scoped `providers:` overlay order.
4. **Exact behaviour when the bridge is registered as a *named* custom provider with `api_mode:` unset and a non-`/v1` base_url.** `_detect_api_mode_for_url` returns `None` for such URLs and the default is `chat_completions` (`hermes_cli/runtime_provider_custom.py:418`), but I did not verify any additional path normalization for custom entries (only OpenCode-family and Azure paths are normalized, `hermes_cli/runtime_provider_custom.py:514-522`).
5. **Headers the SDK adds by itself** (`User-Agent: OpenAI/Python x.y.z`, `X-Stainless-*`, `Accept: application/json`) could not be enumerated from this repo; only Hermes-added override logic was read (`agent/client_lifecycle.py:38-50`, `agent/agent_init.py:880-900`).
6. **`max_tokens` vs `max_completion_tokens` for a custom endpoint serving an OpenAI "forced" model name.** `model_forces_max_completion_tokens(self.model)` (`run_agent.py:649`) was not expanded; the bridge should accept **both** keys.
7. **Whether Hermes retries a streamed request without `stream_options` after a 400.** No such rung was found for `chat_completions`, but absence of code is not proof of absence of behaviour across the whole retry ladder (`agent/auxiliary_client.py:6639-6852` was read only partially).
8. **`_provider_stream_error_from_text` SSRF/`error` event shape coverage.** Read in full for the main path; the aux streamed path has its own error handling (`agent/auxiliary_client.py:6216-6265`) that was only skimmed.
9. **Item 4's `usage` field names beyond the standard three.** `agent/usage_pricing.py:466-470` maps many aliases (`input_tokens`, `cached_tokens`, `prompt_cache_hit_tokens`, …) but the canonical read path is `Usage.from_openai` (`agent/transports/types.py:55-57`) — only `prompt_tokens` / `completion_tokens` / `total_tokens` are read for the normalized response.
10. **Any behaviour specific to Hermes > v0.21** (this tree is the pinned vendor copy; `agent` directory mtimes 2026-09-05).
