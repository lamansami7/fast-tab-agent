# Fast Tab Agent

An AI browser agent for Chrome, plus a **universal provider system**: bring any
OpenAI-compatible endpoint, any model, any number of configurations.

Describe a task in plain language. The agent reads the current tab, plans, and
executes one action at a time — clicking, typing, scrolling, navigating,
extracting — until the goal is done.

All AI traffic runs inside the extension's background service worker. API keys
never reach a web page, a prompt, or a log.

---

## Highlights

**Agent**

- Snapshot → plan → act → observe → replan loop, with automatic repair of
  malformed model output.
- Ten whitelisted actions (`click`, `type`, `select`, `key`, `scroll`,
  `navigate`, `back`, `wait`, `extract`, `done`); every element id is validated
  against the live page before anything is clicked.
- In-page status pill with a Stop button, plus a step timeline in the popup that
  survives closing and reopening the popup.
- Step budget, cancellation, and two-strike failure handling so it can't loop
  forever.

**Providers**

- Nine presets (NVIDIA NIM, Groq, OpenAI, OpenRouter, Together AI, DeepSeek,
  Cerebras, Mistral, Ollama) that are just **templates** — every field is
  editable.
- Fully custom providers: any base URL, any model id, optional endpoint path,
  custom auth header/scheme, extra headers and arbitrary request parameters.
- Independent storage per provider: switching configurations never overwrites
  another provider's key or custom model.
- Autosave with a visible save state, connection testing with real error
  classes, optional model discovery, and a trust warning whenever a key is
  about to be sent to a non-preset host.
- No hardcoded models, no model catalogue requirement, no SDKs, no runtime
  dependencies.

---

## Install

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select the repository root (the folder
   containing `manifest.json`).
5. Pin **Fast Tab Agent** and open it from the toolbar.

Requires Chrome 116+ (Manifest V3).

## Quick start

1. Open the popup and click the provider chip in the header. A starter
   NVIDIA NIM configuration is waiting — or add your own provider.
2. Paste an API key (or point at a local Ollama server, which needs none), then
   press **Test connection**, then **Use this provider**.
3. Open any normal `http(s)` website, describe the task, and press **Run agent**.
4. A small pill in the page shows progress and offers **Stop**. Open the popup
   again to see the step-by-step timeline and the final answer.

Keyboard shortcuts: `⌘/Ctrl + Enter` runs the agent; `Esc` closes panels.

---

## Provider system

### Presets

| Provider     | Base URL                                   | Suggested model                 |
| ------------ | ------------------------------------------ | ------------------------------- |
| NVIDIA NIM   | `https://integrate.api.nvidia.com/v1`      | `meta/llama-3.3-70b-instruct`   |
| Groq         | `https://api.groq.com/openai/v1`           | `llama-3.3-70b-versatile`       |
| OpenAI       | `https://api.openai.com/v1`                | `gpt-4o-mini`                   |
| OpenRouter   | `https://openrouter.ai/api/v1`             | user configurable               |
| Together AI  | `https://api.together.xyz/v1`              | user configurable               |
| DeepSeek     | `https://api.deepseek.com/v1`              | user configurable               |
| Cerebras     | `https://api.cerebras.ai/v1`               | user configurable               |
| Mistral      | `https://api.mistral.ai/v1`                | user configurable               |
| Ollama       | `http://localhost:11434/v1`                | user configurable               |

A preset only pre-fills a name, base URL and (sometimes) a model. The model is
always editable, and presets whose catalogues change often intentionally start
with an empty model so nothing goes stale.

### Adding, editing, switching

The header chip opens the provider panel. Each row is a saved configuration:

- **Active** — the provider used for the next task. Click **Use** on another row
  to switch; switching never mutates any provider record.
- Click a row to edit it. Fields autosave (650 ms debounce, plus on blur) and the
  footer shows `Saving…` → `Saved · 14:32`.
- **Add provider** offers the nine presets plus **Custom provider**.
- **Delete** asks for confirmation and removes only that provider's storage key.
- Duplicate names, duplicate presets and multiple keys for the same provider are
  all fine — every record has its own generated id.

### Custom providers

Any endpoint that implements `POST {baseUrl}/chat/completions` works. Configure:

| Field             | Notes                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Provider name     | Free text                                                          |
| Base URL          | `https://…` (or `http://localhost…`); validated on save and on use |
| Model             | Free text — any id the endpoint accepts, including ones released later |
| API key           | Optional for local endpoints                                       |
| Endpoint path     | Optional override, e.g. `/v2/chat/completions`                     |
| Auth header       | `Authorization` by default; set `api-key` for Azure-style gateways |
| Scheme            | `Bearer` by default; leave empty to send the raw key               |
| Extra headers     | JSON object, e.g. `{"HTTP-Referer":"https://example.com"}`          |
| Custom parameters | JSON object merged into the request body (`top_p`, `seed`, …)       |
| Temperature       | Optional, omitted unless you set it                                |
| Max tokens        | Optional, omitted unless you set it                                |
| JSON mode         | Optional `response_format: json_object`                            |

The editor always shows the exact resolved endpoint (`POST https://host/v1/chat/completions`)
so there is no ambiguity about where a request will go.

### Model support

Models are plain strings. There is no fixed list, no required catalogue, and no
automatic replacement when settings change — a model you type is preserved
verbatim. **Fetch models** is an optional convenience that calls `GET /models`;
if an endpoint doesn't support it, the button reports that and you simply type
the id.

### Storage

`chrome.storage.local`, one key per provider plus a small index:

```jsonc
// fta.providers.index
{ "v": 1, "ids": ["p_3f9c…", "p_8ba1…"], "activeId": "p_3f9c…", "updatedAt": 1730000000000 }

// fta.provider.p_3f9c…
{
  "id": "p_3f9c…",
  "name": "Groq",
  "type": "preset",              // "preset" | "custom"
  "presetId": "groq",
  "baseUrl": "https://api.groq.com/openai/v1",
  "apiKey": "gsk_…",
  "model": "llama-3.3-70b-versatile",
  "endpointPath": "",
  "authHeader": "Authorization",
  "authScheme": "Bearer",
  "extraHeaders": {},
  "params": {},
  "useJsonMode": false,
  "temperature": null,
  "maxTokens": null,
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000
}

// fta.settings — agent preferences (max steps, HUD, JSON mode, private HTTP)
```

Because each record is its own key:

- saving provider A never rewrites provider B;
- a corrupted record is skipped and the index repaired, leaving the rest intact;
- deleting every provider is remembered (no surprise re-seeding);
- legacy layouts (`providers: [...]`, `activeProviderId`, or flat
  `apiKey`/`model`/`baseUrl` keys) are imported once and cleaned up.

---

## Security model

**Keys stay in the extension.**

- API keys live in `chrome.storage.local` and are read only by the background
  worker, which performs every AI request.
- The popup shows the key only inside the password field you are editing.
- The content script never receives provider data: it sees goals, action objects
  and page content only.
- Keys are never placed in model prompts, never written to the DOM of a page,
  never logged, and never returned in status messages — error strings pass
  through a redactor that also catches `Bearer …` and `sk-…` patterns.

**Endpoints are validated before every request.**

| Rule | Behaviour |
| --- | --- |
| Allowed schemes | `http:`, `https:` only — `file:`, `javascript:`, `chrome:`, `data:`, `ftp:` are rejected |
| Embedded credentials | rejected (`https://user:pass@host` must be rewritten) |
| Remote transport | HTTPS required; plain HTTP is refused |
| Local development | `http://` allowed for `localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]` |
| Private LAN | `http://` to RFC1918/CGNAT/`.local` only after opting in under *Agent preferences* |
| Link-local | `169.254.0.0/16`, `fe80::/10` and cloud metadata hosts are always refused |
| Query/fragment | rejected on the base URL so the destination can't be re-routed |
| Redirects | automatic following is disabled — a redirect fails the call instead of forwarding the key; cross-host responses are rejected as well |
| Custom hosts | the editor warns that the key will be sent there, and shows the exact host |

**Connection testing** performs a minimal chat completion through the same
validated path. It never touches the page and never reports success unless the
API returned a usable reply.

**Storage access level.** The worker calls
`chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })`, so
content scripts running alongside a page cannot read provider records even if
they were compromised; only the popup and the worker can.

**Permissions requested:** `storage` (provider config and task state),
`scripting` + `activeTab` (inject the page agent on demand) and `<all_urls>`
(needed to reach arbitrary user-configured API hosts and to read the active
tab). No telemetry, analytics, or third-party services are involved; requests go
only to the endpoint you configured.

---

## Architecture

```
┌──────────────────────────── src/popup ────────────────────────────┐
│ popup.html / popup.css / popup.js                                 │
│ - provider list, editor, autosave, test UI, task timeline         │
│ - no network calls: everything goes through runtime messages       │
└───────────────────────────────┬───────────────────────────────────┘
                                │ chrome.runtime.sendMessage
┌───────────────────────────────▼───────────────────────────────────┐
│ src/background.js (service worker)                                │
│ - provider store (one storage key per provider)                   │
│ - endpoint validation, request building, error mapping            │
│ - the ONLY place fetch() talks to a provider                      │
│ - task loop driver + progress broadcasts                          │
└───────┬───────────────────────────────────────────────┬───────────┘
        │ src/lib/api.js (fetch)                        │ chrome.tabs.sendMessage
        ▼                                               ▼
  OpenAI-compatible API                       src/content/agent.js
  POST {baseUrl}/chat/completions             - snapshot of the page
                                              - executes one action
                                              - in-page status pill
```

**Library modules** (all dependency-free, all unit tested):

| Module | Responsibility |
| --- | --- |
| `src/lib/constants.js` | storage keys, limits, default settings |
| `src/lib/presets.js` | preset templates and host recognition |
| `src/lib/urls.js` | endpoint validation, `/chat/completions` construction |
| `src/lib/providers.js` | provider schema, normalisation, validation, headers, masking |
| `src/lib/provider-store.js` | per-provider storage, index, migration, seeding |
| `src/lib/errors.js` | error vocabulary, classification, redaction |
| `src/lib/api.js` | chat completions, retries, adaptive compatibility, testing, `/models` |
| `src/lib/prompt.js` | agent prompts, JSON extraction, action validation |
| `src/lib/agent-runner.js` | the plan → act → observe loop |

### Message protocol

| Message | Purpose |
| --- | --- |
| `providers:list` | all configurations + active id |
| `providers:save` | upsert one configuration (validates hard URL errors) |
| `providers:delete` / `providers:activate` | remove / switch |
| `providers:test` | validate + minimal chat request; accepts an unsaved draft |
| `providers:models` | optional `GET /models` discovery |
| `settings:get` / `settings:save` | agent preferences |
| `task:start` / `task:stop` / `task:state` | run control and task snapshot |
| `app:info` | version, settings, current tab, in-memory task |
| `fta:progress` (worker → popup) | live task updates |
| `fta:ping` / `fta:snapshot` / `fta:execute` / `fta:hud` | worker ↔ page agent |

All responses use `{ ok: true, data }` or `{ ok: false, error: { code, message, hint, field } }`.

### Provider compatibility

Providers differ in ways that break naive clients. The transport handles:

- **Error shapes** — OpenAI `{error:{...}}`, FastAPI `{detail}`, Mistral
  `{message}`, Ollama `{error:"…"}`, HTML proxy pages, and 200-with-error bodies.
- **Status classes** — 401/403 auth, 402/429 quota vs rate limit, 404 endpoint
  vs model, 400/422 invalid request, 413 payload, 5xx server, timeouts,
  non-JSON replies, empty completions, content filters.
- **Optional parameters** — if a model refuses `temperature`, `max_tokens`,
  `response_format`, `top_p` and friends, that field is dropped and the call is
  retried once; the popup notes what was skipped.
- **Retries** — one extra attempt for 429/5xx, honouring `Retry-After`.
- **Response shapes** — string content, multimodal content arrays, and legacy
  `choices[0].text`.
- **Conservative defaults** — no temperature, no token cap, no JSON mode unless
  configured.

---

## Development

The extension itself has **no runtime dependencies** and no build step — the
files in this repository are exactly what Chrome loads.

```bash
npm install          # dev-only: jsdom for the DOM tests
npm test             # 100+ unit + worker integration tests (node:test)
npm run test:dom     # popup + page-agent tests in jsdom
npm run test:all     # everything
npm run icons        # regenerate icons/ from tools/make-icons.mjs
npm run preview      # http://localhost:4173 — the real popup with mocked data
```

`npm run preview` serves the unmodified popup with a mock `chrome.*` runtime,
so the provider UI and a scripted agent run can be reviewed in any browser
without loading the extension. Nothing in `tools/` ships with the extension.

Test coverage includes URL/endpoint validation, provider normalisation and
storage (independence, migration, corruption, concurrency), request building,
error classification and redaction, adaptive parameter fallback, prompt/JSON
parsing, action validation, the agent loop (repair, cancellation, failures,
step limits), the worker's message API end-to-end, and the popup's real DOM
flow.

### Layout

```
manifest.json
icons/                     generated PNGs
src/
  background.js            service worker
  content/agent.js         page agent (classic script)
  popup/                   popup.html, popup.css, popup.js
  lib/                     shared, testable modules
tests/                     node:test suites (+ tests/dom for jsdom)
tools/make-icons.mjs       icon generator (no dependencies)
tools/preview/             dev-only UI preview server + mock chrome API
```

---

## Troubleshooting

| What you see | What to check |
| --- | --- |
| **Authentication failed** | Key typo, revoked key, or the key lacks access to the model |
| **Model unavailable** | Exact model id from the provider dashboard (case and slashes matter) |
| **Unsupported endpoint (404)** | Base URL path — most end with `/v1`; try the endpoint path override |
| **Connection failed** | Host reachable, TLS valid, local server running; private LAN HTTP needs the opt-in |
| **Rate limited / quota** | Provider-side limit or billing; wait or use another key/model |
| **Model did not return usable JSON** | Small or chat-tuned models sometimes ignore the schema; try a stronger model |
| **Agent cannot read this page** | `chrome://` pages, the Web Store and PDF viewers are off-limits to extensions |

**Ollama notes.** The preset points at `http://localhost:11434/v1`. If Ollama
rejects the browser's origin, start it with `OLLAMA_ORIGINS=*` (or your
extension's origin) and confirm the model is pulled (`ollama list`).

**Where things run.** A task keeps running when the popup closes — the worker
owns the loop and the page pill shows progress. Chrome may still suspend an
extension worker during very long idle periods; if that happens the run is
marked as interrupted rather than silently hanging, and you can start again.

**Key storage.** Keys are stored unencrypted in Chrome's extension storage,
protected by your OS profile. Anyone with access to your Chrome profile and
`chrome.storage.local` can read them — use scoped/rotatable keys.

---

## License

MIT © Sami Laman — see [LICENSE](LICENSE).
