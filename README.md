# Fast Tab Agent

Fast Tab Agent is a Manifest V3 Chrome extension that lets you ask an AI model to work with the currently active web page. It reads a bounded page snapshot, asks an OpenAI-compatible endpoint for one action at a time, validates that action, executes it in the tab, and replans from the result.

AI requests and provider credentials are handled by the extension service worker. The page agent does not receive provider records or API keys.

## What it does

- Reads visible page text, headings, links and interactive controls; can click, type, select, press an allowlisted key, scroll, navigate, go back, wait, and extract text.
- Uses a bounded plan → act → observe loop with a configurable maximum of 1–20 steps, cancellation, failure handling, and a popup timeline.
- Supports provider configurations for NVIDIA NIM, Groq, OpenAI, OpenRouter, Together AI, DeepSeek, Cerebras, Mistral, Ollama, and any compatible custom endpoint. Presets are editable templates, not provider-specific clients.
- Supports arbitrary model IDs, custom endpoint paths, auth header and scheme, extra headers, request parameters, optional JSON mode, optional model discovery, temperature, and token limits.
- Stores providers independently so switching or editing one does not overwrite another.

The extension does not execute JavaScript returned by a model and does not expose arbitrary selectors to the model. It is not a general-purpose computer-use system: interactions are DOM actions and can fail on sites that require trusted physical input, closed shadow roots, inaccessible frames, or complex application-specific behavior.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the directory containing `manifest.json`.
4. Open Fast Tab Agent from the Chrome toolbar.

Chrome 116 or newer is required. There is no build step and the extension has no production dependencies.

## Configure a provider

1. Open the provider picker, then add a preset or choose **Custom provider**.
2. Set the base URL and model ID. Add an API key for remote providers; a local Ollama endpoint can be used without one.
3. Optionally adjust auth, headers, parameters, or the endpoint path in **Advanced**.
4. Use **Test connection**. Chrome asks for host access when the endpoint is first used. Then activate the provider.

A preset suggests a starting URL/model only. You can use any model ID your endpoint accepts; **Fetch models** is optional and calls `GET /models` when supported.

For a custom OpenAI-compatible endpoint, configure the following as needed:

| Field | Behaviour |
| --- | --- |
| Base URL and endpoint path | Standard chat-completions URL construction or an explicit path override |
| Model | Free-form model ID; never replaced automatically |
| API key, auth header and scheme | Optional key for local endpoints; default is `Authorization: Bearer …` |
| Extra headers and request parameters | JSON objects merged into the outgoing request; reserved protocol fields (`messages`, `model`, `stream`) cannot be overridden |
| Temperature, max tokens and JSON mode | Optional settings; transport can remove rejected optional parameters and retry |

Custom headers and parameters are sent to the endpoint you configure. Treat custom endpoints as trusted destinations: prompts and relevant page content will be sent there for inference. The editor shows a warning for non-preset hosts and displays the resolved endpoint.

### Current presets

| Provider | Base URL | Suggested model |
| --- | --- | --- |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `meta/llama-3.3-70b-instruct` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | User-configured |
| Together AI | `https://api.together.xyz/v1` | User-configured |
| DeepSeek | `https://api.deepseek.com/v1` | User-configured |
| Cerebras | `https://api.cerebras.ai/v1` | User-configured |
| Mistral | `https://api.mistral.ai/v1` | User-configured |
| Ollama | `http://localhost:11434/v1` | User-configured |

All presets use the same OpenAI-compatible chat-completions transport. The transport accepts common compatible response shapes (standard message content, content-part arrays, legacy text, and compatible `output_text` responses) and reports redacted response-shape diagnostics when a 200 response contains no usable message text. Provider-specific features beyond that interface are not guaranteed.

## Permissions

The required manifest permissions are `storage`, `scripting`, and `activeTab`:

- `activeTab` gives temporary access to the tab when the user opens the extension; `scripting` injects the page agent on demand. The extension does not request persistent access to every website.
- `storage` stores provider settings, preferences, and a session task snapshot.
- `optional_host_permissions` declares HTTP and HTTPS hosts as requestable, but no host-wide permission is granted at installation. When you explicitly test a provider, fetch models, or start a task, the popup requests access to that provider's exact scheme and hostname. The service worker checks the grant again before making the request. Access can be forgotten from the provider editor or removed in Chrome settings.

Chrome host permissions are host-based and do not reliably isolate a port; a grant for a host can cover other ports on that host. Local model servers, including Ollama, use the same explicit permission flow. If access is denied, no API request is made.

## Security and privacy

- Provider keys are stored in `chrome.storage.local`, which is not encrypted by the extension. The background worker sets storage access to `TRUSTED_CONTEXTS` before reading provider records or injecting the page agent. Anyone with access to the local Chrome profile may still be able to access extension data.
- Keys are used by the background worker in authentication headers. The request transport redacts the configured key from prompt messages and error strings; keys are not intentionally sent in model prompts, logs, page messages, or task progress. A user can still intentionally include unrelated secrets in a task or page content.
- The agent excludes password fields from snapshots and withholds values for fields that look sensitive based on their type, autocomplete, name, label, or placeholder. This is heuristic: it cannot identify every sensitive value embedded in ordinary page text.
- Page text and model output are untrusted. The system prompt explicitly rejects webpage instructions that conflict with the user's goal, and model actions are constrained to a fixed schema and checked against current page elements. These measures reduce risk; prompt injection cannot be eliminated by prompts or schema validation alone.
- Actions that look consequential (for example, purchase, delete, send, publish, transfer, or booking actions) use a browser confirmation dialog based on the control/form text. This detection is heuristic and can miss or misclassify an action. Review the tab and confirmation prompt before approving. The agent must not be left unattended on sensitive sites.
- AI action events are DOM events, not guaranteed trusted physical input. Pages can respond differently, and the extension cannot guarantee that a site performed or did not perform a side effect.
- HTTPS is required for remote hosts. HTTP is accepted for loopback development endpoints and, only after enabling the preference, selected private-LAN addresses. Link-local and known metadata endpoints are rejected. These URL checks do not prevent DNS rebinding or every network-routing attack.
- API redirects are not followed. Model discovery uses the same redirect restriction as chat requests. Requests omit cookies and referrers.
- No telemetry or analytics are included. Provider requests go to the configured endpoint; the provider's own data handling policy applies.

Fast Tab Agent is not a security boundary for a website and is not certified for financial, medical, account-security, or other high-impact automation.

## Supported actions

`click`, `type`, `select`, allowlisted `key`, `scroll`, `navigate` (HTTP/HTTPS only), `back`, `wait`, `extract`, and `done`.

At execution time the page agent rechecks that targets still exist, are visible, and are not disabled; typing is limited to supported text fields and password fields are unavailable. Select operations require a real `<select>`. The model receives bounded snapshots and action history, not arbitrary page scripts or DOM selectors. A task stops at its step limit, on explicit cancellation, or after repeated action failures. Consequential-action confirmations are a heuristic extra check, not a guarantee that every risky operation will be caught.

## Architecture

```text
src/popup/            Provider editor, preferences, run controls and timeline
src/background.js     Provider storage, permission checks, API transport and task orchestration
src/lib/api.js        OpenAI-compatible transport, errors, retries and model discovery
src/lib/providers.js  Provider normalization, validation and headers
src/lib/urls.js       Endpoint validation and URL construction
src/lib/prompt.js     System/user prompts, JSON parsing and action validation
src/lib/agent-runner.js  Plan → act → observe loop
src/content/agent.js  Page snapshot, validated DOM actions and status HUD
```

The service worker owns task execution and stores progress in `chrome.storage.session`. Chrome can suspend or restart MV3 workers; tasks are **not resumed** after interruption. A stale running task is marked interrupted/stopped when the popup or a new task next queries state. The popup can close and reopen while the worker remains active, but this is not a guarantee of uninterrupted execution.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Chrome denies endpoint access | Retry from the popup and approve the requested host. The extension asks only at use time; grants can be forgotten or removed in Chrome settings. |
| Authentication or model error | Verify the key, exact model ID, provider access, and billing status. |
| Endpoint 404 | Check the base URL and optional endpoint-path override. Most compatible endpoints use `/v1/chat/completions`. |
| Empty or unexpected response | The endpoint returned HTTP 200 but no usable message text. Check the redacted response-shape diagnostics in the test result, confirm the model ID and endpoint, and increase max tokens if the model exhausted its output budget before producing message content. |
| Ollama cannot connect | Confirm the model is pulled and Ollama is listening on `localhost:11434`. Ollama may need a browser origin policy that permits the extension. |
| Private-network HTTP is refused | Only loopback is allowed by default. The optional private-LAN HTTP preference is insecure and should be used only on a trusted network. |
| Agent cannot read the page | Chrome internal pages, the Chrome Web Store, some PDF viewers, and pages without extension access are unavailable. |
| Click or typing did not work | The page may use a closed shadow root, cross-origin frame, custom control, or trusted-event checks. Inspect the page and complete the step manually. |
| Task stops unexpectedly | Check the popup for an interrupted task; MV3 worker suspension can stop a run. Start it again rather than assuming it resumed. |

## Development and tests

```bash
npm install
npm test             # unit tests and background-worker message integration
npm run test:dom     # jsdom page-agent and popup tests
npm run test:all     # both suites
npm run preview      # local popup preview with mocked Chrome APIs
npm run icons        # regenerate icon assets
```

`jsdom` is a development dependency for DOM tests only. The preview is a UI mock and is not a Chrome extension runtime test. Tests exercise endpoint validation, storage, request/error handling, prompt parsing, action safety, cancellation, worker messaging, popup behavior, and DOM actions. Automated tests do not replace testing the unpacked extension in Chrome against real providers and real websites.

## License

MIT. See [LICENSE](LICENSE).
