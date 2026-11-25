# Fast Tab Agent

Fast Tab Agent is a Manifest V3 Chrome extension that turns the tab you choose into a conversational AI workspace. Ask a question, request a summary, or give the agent a short multi-step task; it reads a bounded snapshot of the page, plans one action at a time, executes it, checks the result, and reports back in a chat interface.

AI requests and provider credentials stay in the extension service worker. The page agent receives a sanitized snapshot and validated actions — never provider records or API keys.

**Version 1.2** runs in Chrome's side panel, so it stays open while you click around the page it is working on. It adds real tab access, per-site permissions, live progress, reliable cancellation, light/dark themes and a persistent conversation.

## What it does

- **Chat with the page.** A conversation view with clear user/assistant messages, timestamps, live task status, action history and actionable errors. Conversations survive closing the panel and can be cleared from Settings.
- **Choose the tab.** A tab picker lists open tabs with title, domain, favicon/initial, active/selected state and a permission badge. Search, refresh, select another tab, or grant access to it. Restricted pages explain why they cannot be used.
- **Read the page.** Visible text, headings, links and interactive controls are extracted into a bounded snapshot. The agent can summarize, answer questions, find sections, forms and links.
- **Act on the page.** Click, type, select, press allowlisted keys, scroll, navigate, go back, wait, extract text or finish. Targets are rechecked before every action and the page is re-read afterwards.
- **Stay in control.** Live phases ("Reading the page", "Clicking an element"), current action, target tab, a stop button that settles the task, and a per-task action log. No hidden chain-of-thought is shown.
- **Bring your provider.** NVIDIA NIM, Groq, OpenAI, OpenRouter, Together AI, DeepSeek, Cerebras, Mistral, Ollama, or any OpenAI-compatible endpoint. Presets are editable templates, not separate clients.

The extension does not execute JavaScript returned by a model and never exposes arbitrary selectors to the model. It is not a general-purpose computer-use system: DOM actions can fail on sites that require trusted physical input, closed shadow roots, inaccessible frames, or complex app-specific behavior.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Select **Load unpacked** and choose the directory containing `manifest.json`.
4. Pin Fast Tab Agent to the toolbar. Clicking its icon opens the side panel, which stays open while you use the page. Drag the panel's inner edge to make it wider.

Chrome 116 or newer is required. There is no build step and no production dependencies.

### Reload after code changes

1. Edit the files.
2. Open `chrome://extensions`, find Fast Tab Agent, and press the reload icon.
3. Reopen the side panel. If a task was running, it is marked interrupted; start it again.
4. If you changed the content script, also reload the test page (press F5) so the new content script is injected.

## The interface

```
┌──────────────────────────────────────────────┐
│ Fast Tab Agent            ● Groq        ⚙︎  │  header: status, provider, settings
├──────────────────────────────────────────────┤
│ [R] Running shoes — demo store  ↻  Tabs 3   │  selected tab, access, refresh, picker
│     demo-store.example · Page access        │
├──────────────────────────────────────────────┤
│  You: Summarize this page…                  │
│  Fast Tab Agent  [Working] 12:48            │  live phase / action / answer
│  1. Reading the page…                       │  action log (collapsed when done)
│  Tab: Running shoes — demo store            │
│                                             │
├──────────────────────────────────────────────┤
│ Ask or describe a task…              [→]    │  Enter sends, Shift+Enter adds a line
│                              [Stop]         │  visible only while a task runs
│ Enter ↵ · Shift+Enter for a new line        │
└──────────────────────────────────────────────┘
```

- **Header:** product name, a status line (`Ready`, `Working on a tab`, `Needs setup`), the active provider and a settings button.
- **Tab bar:** the tab the agent will work on, its domain, a `Page access` or `Allow access` badge, a refresh action, and the tab count. Clicking the title opens the picker.
- **Chat:** empty-state guidance and four starter prompts until the first message; thereafter a scrollable history. Long answers wrap and the view stays pinned to the newest content unless you scroll up.
- **Composer:** multiline input with autosizing (capped), a send button that is disabled for empty input or when the agent is running, and a stop button while a task is active.
- **Settings:** two tabs. **AI provider** manages providers, models, keys, endpoints, connection tests and activation. **Behaviour** holds the theme (Auto/Light/Dark), maximum steps, in-page status pill, JSON mode, private-LAN HTTP preference, a list of granted website/endpoint hosts with **Revoke**, and **Clear conversation**.

Light and dark themes follow the operating system by default. Focus rings, labels, live status regions and reduced-motion handling are included; all controls are reachable by keyboard.

## Working with open tabs

### The selected tab

The panel follows the active tab, so switching tabs updates the tab bar without closing it. The agent works only on the **tab shown in the bar**, and only after you send a request. Nothing reads page content in the background, and switching the picker does not read the new tab until you run a task.

For the active tab, the extension relies on `activeTab` (temporary access granted when you open the extension) plus `scripting` for on-demand injection. If you select a different tab, Chrome asks for access to that tab's exact site. Denying the request leaves the previous selection in place.

### The tab picker

- Lists up to 120 tabs with the selected tab first, then the active tab, then most recently active.
- Shows title, host, favicon when available (otherwise a safe initial), and a permission badge: `Active`, `Ready`, `Allow`, `Restricted`, or `Needs permission`.
- Searches by title or domain. **Refresh** re-reads the list and permission state.
- Selecting a tab closes the picker and updates the tab bar. If the site has not been granted, the click itself requests access.
- If Chrome hides tab titles and URLs because the optional `tabs` permission is not granted, a banner offers to enable tab names. Until then, unnamed tabs are shown as `Tab N` and cannot be selected safely.
- Pages the extension cannot use are shown with a reason and cannot be selected.

### Permissions used

| Permission | When it is requested | Why |
| --- | --- | --- |
| `storage` | Install | Providers, settings and chat history |
| `scripting` | Install | Inject the page agent on demand |
| `activeTab` | When you open the extension | Temporary access to the tab you are on |
| `tabs` (optional) | When you ask to show tab names | Titles/URLs of non-active tabs for the picker |
| Host access (optional) | When you select a tab, run a task, test a provider, or fetch models | Read/act on that exact site, or call that exact AI endpoint |

There is no install-time access to all websites. A host grant covers the scheme and hostname (for example `https://example.com/*`), not individual paths. Chrome's permission model does not reliably distinguish ports, so a grant for a host can cover another port on the same host. Revoke access in **Settings → Behaviour → Website and endpoint access**, or in Chrome's extension settings.

### Restricted pages

The picker explains these instead of failing silently:

- `chrome://` pages, the New Tab page, and other browser-internal pages.
- The Chrome Web Store (Chrome blocks extensions there).
- `view-source:`, `chrome-extension://`, `file://` and PDF viewer pages.
- Tabs whose URL Chrome still hides and pages where injection is denied by policy.

If a page becomes unavailable after you select it (tab closed, navigated to a restricted page, or the grant was removed), the task stops with a clear message. The agent never claims it read a page it could not access.

## Talking to the agent

Examples that map to supported behavior:

- "Summarize this page."
- "Find the contact form and tell me what information it asks for."
- "Search this page for the refund policy."
- "Fill the search box with 'running shoes' and submit it."
- "Scroll down and find the pricing section."
- "Open the About page and read the first paragraph."

Each request is sent once. The model returns one action per turn from a fixed vocabulary; the content script validates the target, performs the action, returns a short observation, and the loop repeats until `done`, the step limit, an error, or **Stop**. Page content is treated as data, not instructions; it cannot change the system prompt, provider settings, or permissions.

### Progress and cancellation

Phases you may see: `Getting ready`, `Reading the page`, `Thinking`, `Clicking an element`, `Typing into a field`, `Scrolling`, `Waiting for the page`, `Finishing`, plus `Completed`, `Stopped`, `Failed`, `Interrupted` and `Step limit reached`. Only real events are shown; the interface never reports a successful action that failed.

**Stop** immediately marks the task stopping, prevents further actions, aborts the in-flight page action where possible, and settles the task as stopped when the worker acknowledges. A late model response cannot resume a stopped task or overwrite a newer one; starting a new task while another is active is rejected in the background, not just hidden in the UI.

## Browser actions

| Action | What it does | Verification |
| --- | --- | --- |
| `click` | Clicks a visible, enabled element by its snapshot id | Rechecks the element, scrolls it into view, then reports the resulting page state |
| `type` | Types into a supported text field, optionally pressing Enter | Rejects disabled/read-only/secret fields; reports whether the value was applied without echoing sensitive values |
| `select` | Chooses an option in a real `<select>` by label or value | Fails if the option does not exist |
| `key` | Presses an allowlisted key (Enter, Escape, Tab, arrows, etc.) | Re-checks focus and page state |
| `scroll` | Scrolls the page by a bounded amount | Returns the new position and visible content |
| `navigate` | Opens an HTTP/HTTPS URL in the selected tab | Waits for the page and re-injects the agent |
| `back` | Browser history back | Waits for the page and re-injects the agent |
| `wait` | Waits briefly for the page to settle | Then re-reads the page |
| `extract` | Returns text from the page or an element | Bounded, with explicit truncation notes |
| `done` | Ends the task with an answer | Marks the step complete and clears the running state |

The page agent re-validates every target and never receives raw HTML, scripts or selectors from the model. It works from stable element ids assigned during the snapshot, and the snapshot includes accessible names, roles, labels, visible text and DOM attributes as identification hints. Password fields are excluded; one-time-code, password, card and other secret fields are marked and cannot be typed into. Typing into ordinary fields (including email) is allowed, but the value is not echoed back in the observation.

### Consequential actions

Actions whose control or form text suggests a purchase, payment, delete, send, publish, transfer, booking or account change trigger a confirmation dialog in the page. Reading and low-risk navigation do not. This detection is heuristic: it can miss a risky control or flag a harmless one. Review the tab and the confirmation; do not leave the agent unattended on sensitive sites.

### Execution limits

- Maximum steps per request is configurable (1–20, default 8).
- Page snapshots and prompts are bounded; truncation is stated in the prompt and the answer rather than silently dropping content.
- Repeated identical failures end the task instead of looping.
- Timeouts apply to provider requests and page actions.
- A closed tab, denied permission, missing element, navigation, or page rewrite fails with an actionable message rather than a crash.

## Providers

1. Open **Settings → AI provider**.
2. Choose a preset (NVIDIA NIM, Groq, OpenAI, OpenRouter, Together AI, DeepSeek, Cerebras, Mistral, Ollama) or **Custom provider**.
3. Set the base URL, model ID and API key. Local Ollama can run without a key.
4. Optionally adjust auth header/scheme, extra headers, request parameters, endpoint path, temperature, max tokens and JSON mode under **Advanced**.
5. Use **Test connection** (Chrome asks for the endpoint host), then **Activate provider**.

A preset only suggests a starting URL and model. Any model ID the endpoint accepts can be used. **Fetch models** is optional and calls `GET /models`.

| Provider | Base URL | Suggested model |
| --- | --- | --- |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3.5-lightning-30b-a3b` |
| Groq | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| OpenRouter | `https://openrouter.ai/api/v1` | User-configured |
| Together AI | `https://api.together.xyz/v1` | User-configured |
| DeepSeek | `https://api.deepseek.com/v1` | User-configured |
| Cerebras | `https://api.cerebras.ai/v1` | User-configured |
| Mistral | `https://api.mistral.ai/v1` | User-configured |
| Ollama | `http://localhost:11434/v1` | User-configured |

All presets use the same OpenAI-compatible chat-completions transport. It accepts common compatible response shapes (standard message content, content-part arrays, legacy text, and compatible `output_text` responses), retries without rejected optional parameters, and reports redacted response-shape diagnostics when a 200 response contains no usable text. NVIDIA NIM's response variations are covered by this path. Provider-specific features beyond the compatible interface are not guaranteed.

Provider failures map to readable messages: missing key, invalid endpoint, authentication failure, model unavailable, rate limit/quota, timeout, network failure, empty response, content filter, and server error. Raw stack traces are not shown.

## Privacy and security

### Trust boundaries

- **Provider records and keys** live in `chrome.storage.local` and are read only by the background worker and the popup. The worker sets storage access to `TRUSTED_CONTEXTS` before reading or injecting the page agent.
- **The content script** receives the system prompt, a bounded page snapshot, and the current action. It never receives provider records, keys, auth headers or chat history.
- **The model** receives only what is needed for the task: the user request, a bounded page snapshot and action history. Only the selected tab is read, and only while a task runs.
- **Webpage text is untrusted.** It is wrapped in an explicit untrusted-content section. The system prompt rejects page instructions that conflict with the user's goal, and the model's output is constrained to a fixed JSON action schema with no code execution.

### Key handling

Keys are stored locally and used by the worker in auth headers. They are redacted from prompts, error strings and diagnostics, and never sent to the page or the model. They are not encrypted at rest: anyone with access to the Chrome profile and disk may be able to read extension storage. Use a scoped, low-privilege key and rotate it if the profile is shared. Keys are not committed to this repository.

### Rendering and injection

The popup builds every message and tab row with DOM nodes and `textContent`. Model answers support only inline `**bold**` and `` `code` `` formatting, constructed as elements — no HTML, links, images or raw Markdown. Tabs and messages cannot inject markup. The extension uses the default MV3 content security policy and does not load remote code.

### Network

- Remote endpoints require HTTPS. HTTP is accepted for loopback (`localhost`/`127.0.0.1`) and, only after enabling the preference, selected private-LAN addresses.
- Embedded credentials in endpoint URLs, link-local and cloud metadata addresses are rejected.
- Redirects are not followed; requests omit cookies and referrers.
- Host access is requested at use time and checked again in the worker before each request or injection.

### Conversations

Chat history is stored locally under `fta.chat`, capped at 60 messages. It holds your request, the final answer, and a bounded action log. It does not store page text, provider records, API keys or hidden reasoning. A message is sanitized on both write and read, so a corrupt or hand-edited record cannot add unknown fields. **Clear conversation** removes it immediately.

### What this is not

Prompt injection cannot be eliminated by prompts or schema validation alone, and DOM actions are not the same as trusted physical input. Confirmation detection is heuristic. Fast Tab Agent is not a security boundary for a website and is not certified for financial, medical, account-security or other high-impact automation.

## Performance

- The popup loads provider, settings, tab and chat state once at open, then listens for runtime events instead of polling.
- Page snapshots are bounded (interactive elements, text length, links) and truncation is reported. The prompt includes fewer elements than the content script retains, keeping requests small.
- Chat persistence is debounced and capped. Live task state is separate (`chrome.storage.session`) and is not re-read on every keystroke.
- Provider requests have timeouts and no retry storm; optional parameters rejected by a provider are removed once and retried.
- The tab list is capped at 120 entries with a visible notice instead of rendering an unbounded list.
- Repeated page actions are serialized; a new task cannot start while one is running.

## Known limitations

- **The agent does not switch or choose tabs on its own.** You choose the tab. This is deliberate: the agent never lists or transmits every open tab to the model. Tab-scoped work is fully supported; autonomous cross-tab workflows are not.
- **Cross-origin navigation can hit a permission wall.** If the agent navigates the selected tab to a site you have not granted, the next injection fails with a permission error. The task stops honestly; grant the new site (or select the tab there) and retry. Navigation within an already granted origin works.
- **MV3 worker suspension.** Chrome can suspend the service worker. A running task is marked interrupted when state is next read; tasks are not resumed automatically.
- **No streaming responses.** Each model turn is one request; progress reflects real steps, not token streaming.
- **One action per model turn.** Long workflows use more requests and can hit the step limit.
- **DOM-only interaction.** Closed shadow roots, cross-origin iframes, canvas-only UIs, native browser dialogs, trusted-event checks and sites that block synthetic events may not work.
- **Restricted pages.** Chrome internal pages, the Web Store, `file://`, extension pages and some PDF viewers cannot be automated.
- **Heuristics.** Sensitive-field detection and consequential-action confirmation are text/attribute heuristics, not guarantees.
- **Local key storage is not encrypted.** See Privacy and security.
- **Tab titles need the optional `tabs` permission.** Without it the picker cannot show or safely select other tabs.
- **The current conversation is in the popup's storage, not synced.** It stays on this Chrome profile.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| "Permission required" | Select the tab and approve the prompt, or grant the site in Settings → Behaviour. Chrome only asks in response to a click. |
| Tab titles are missing | Use the picker's banner to enable `tabs` access, then refresh. |
| "This page cannot be used" | Restricted page (Chrome internal, Web Store, file URL, PDF). Open a normal website. |
| Provider test fails with 401/403 | Check the key, its scope and the provider account. |
| Endpoint 404 | Check the base URL and endpoint-path override; most compatible endpoints use `/v1/chat/completions`. |
| Empty response | The endpoint returned 200 with no usable text. Check the redacted shape diagnostics, the model ID, and the token limit. |
| Ollama cannot connect | Pull the model, confirm Ollama is listening on `localhost:11434`, and allow the host when Chrome asks. |
| Agent cannot type | The field may be disabled, read-only, a secret field, a custom control, or inside an inaccessible frame. |
| Task stopped unexpectedly | Look for `Interrupted` (worker) or `Stopped` (you or the task's limit). Start it again; it does not resume. |
| Click did nothing | The page may require trusted input or re-render the target. Check the action log's observation; the task stops after repeated failures. |

## Manual testing in Chrome

Automated tests cannot load an extension into Chrome, inject scripts into real pages, or exercise Chrome's permission prompts. Run this checklist before shipping a change. Use a test profile and a low-privilege API key.

### 1. Load the unpacked extension

- [ ] Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, select this repository.
- [ ] The card shows Fast Tab Agent 1.2.1 with no errors. Click **Errors** if present.
- [ ] Pin the extension and click its icon: the side panel opens (no popup) with the header, tab bar and empty state, and no console errors in the panel's DevTools.
- [ ] Click on the page while the panel is open: the panel stays open. Switch tabs: the tab bar follows the new active tab.

### 2. Reload after code changes

- [ ] Change a visible string, press reload on the extension card, then reopen the side panel. The change appears.
- [ ] Press F5 on the test page after changing `src/content/agent.js`.
- [ ] A task that was running before reload shows as interrupted/stopped rather than staying "Working" forever.

### 3. Grant webpage access

- [ ] With a normal page active, the tab bar shows `Page access`.
- [ ] Select another tab in the picker; Chrome asks for that site. **Allow** → the tab bar updates and the badge becomes `Page access`.
- [ ] Select another tab and **Deny**. The previous selection remains, the panel explains that access is needed, and no task starts.
- [ ] Revoke the site in Settings → Behaviour → Website and endpoint access. The badge returns to `Allow access` and Chrome asks again next time.

### 4. Test the active tab

- [ ] Open a simple article page. Open the popup; title and domain are correct.
- [ ] Ask "Summarize this page." The status moves through reading/thinking/finishing and a relevant answer appears.
- [ ] The answer's tab label matches the page you were on, and no other tab is mentioned.

### 5. Test multiple tabs

- [ ] Open three normal tabs (for example a store, Wikipedia, and a news article).
- [ ] Open the picker; all three appear with titles, domains and states; the active one is first and marked.
- [ ] Search for part of a title and a domain; the list filters correctly.
- [ ] Select the second tab, ask a question specific to it, and confirm the answer uses that page.
- [ ] With the title permission denied, the picker offers to enable tab names; enabling it fills in the titles without a reload.
- [ ] Open 30+ tabs; the list still scrolls smoothly and the search filters.

### 6. Test reading a page

- [ ] Ask for the main links; they match links visible on the page.
- [ ] Ask about a section further down. If the agent scrolls, the page actually scrolls and the answer reflects the section.
- [ ] On a very long page, look for a truncation note and confirm the answer does not pretend to have read omitted content.
- [ ] Ask about the current page while on a restricted page (Chrome settings); you get an explanation, not a fabricated summary.

### 7. Test clicking

- [ ] On a safe page with a "Show more" or similar harmless control, ask the agent to click it. The control activates and the observation says what happened.
- [ ] Ask it to click something that no longer exists (remove it with DevTools first). The task reports a missing element and stops cleanly.
- [ ] If a click does nothing, confirm the popup does not claim success; it should report failure or an unchanged page.

### 8. Test typing

- [ ] On a search page, ask it to type a query and submit. The query appears and results load.
- [ ] Try a password/one-time-code field (a test form you control). The action is refused and the field is not filled.
- [ ] Try a disabled or read-only input. It is rejected with a clear message.
- [ ] Type into an email field: it fills, but the action log does not echo the address.

### 9. Test navigation

- [ ] Ask the agent to open a page on the same site. The tab navigates and the agent continues reading it.
- [ ] Ask it to go back. The previous page loads and the agent can continue.
- [ ] Navigate to a different site you have not granted. The task stops with a permission message rather than pretending to read the new page; grant the site and retry.

### 10. Test cancellation

- [ ] Start a multi-step task and press **Stop** immediately. The UI changes to Stopping/Stopped, the page stops changing, and the stop button disappears.
- [ ] Start a task, press Stop while the model is thinking, then wait 30 seconds. No late answer or action appears.
- [ ] Start a task, press Stop, then immediately start another. The new task runs and the old one cannot overwrite its messages.
- [ ] Close and reopen the side panel during a task. Reopening shows the current state consistently; Stop still works.

### 11. Test restricted pages

- [ ] `chrome://settings` → picker marks it Restricted and cannot select it.
- [ ] Chrome Web Store → restricted with an explanation.
- [ ] A PDF, a `file://` page if enabled, and `view-source:` → reasonable messages, no crash.
- [ ] Close the selected tab while a task is running → the task fails with "tab unavailable" and the UI recovers.

### 12. Test provider configuration

- [ ] Add a second provider, save, switch between providers, reopen the popup. Each keeps its own key, model and endpoint.
- [ ] **Test connection** succeeds; try a wrong key and an unknown model and confirm the messages are actionable.
- [ ] Test a reasoning model that hits the probe's token cap: it reports a successful connection with a token-limit note instead of hanging for 30 seconds.
- [ ] Select a background tab: starting a task brings that tab to the front so its actions are visible.
- [ ] Test with a 200 response that has empty content if you can simulate one; the error mentions the response shape and suggests a fix.
- [ ] NVIDIA NIM: test the preset (or a compatible endpoint) and confirm a normal answer.
- [ ] Ollama: test a local model with no key.
- [ ] Confirm no key appears in the panel's rendered text, console, task steps, or page DOM.

### 13. Test the UI

- [ ] Drag the panel wider and narrower, and zoom: text wraps, the composer stays usable, and nothing is cut off.
- [ ] Switch Auto/Light/Dark in Behaviour; both themes are legible and persist after reopening.
- [ ] Navigate the entire panel with Tab/Shift+Tab; every control has a visible focus ring and sensible order.
- [ ] Send a very long answer (paste or ask for detail); it scrolls, does not overflow, and the newest content remains reachable.
- [ ] With reduced motion enabled in the OS, animations are minimal.
- [ ] Clear conversation confirms, then empties the chat and survives reopening.
- [ ] Send a request with no provider configured; the empty/error state points to Settings instead of failing silently.

### 14. Report bugs

Include:

- Chrome version and OS.
- Extension version (Settings or `chrome://extensions`).
- Provider and model (never the API key).
- The exact request, the tab URL/domain, and whether access was granted.
- What you expected vs what happened.
- The popup's visible error text and the action log.
- Console errors from the popup (right-click → Inspect) and the service worker (`chrome://extensions` → service worker → Inspect), with keys and private page text removed.
- Whether the page was restricted, dynamic, or inside an iframe.

Redact keys, personal data and private page content before posting an issue.

## Automated tests

```bash
npm ci               # install the jsdom dev dependency
npm test             # unit tests + background-worker message integration
npm run test:dom     # jsdom page-agent and popup UI tests
npm run test:all     # both suites
```

Coverage includes:

- **Tabs:** URL classification, restricted pages, permission states, filtering, picker ordering, active/other tab metadata, hidden metadata, tab closure and messaging.
- **Agent:** snapshot extraction, secret-field blocking, clicking, typing, selecting, keys, scrolling, navigation, failures, cancellation, timeouts, stale events, phase events.
- **Providers:** normalization, validation, key redaction, headers, URL construction, response shapes (including NVIDIA-compatible variants), empty/malformed responses, connection tests, storage.
- **Background:** sender checks, task start/stop/state, tab scoping, permission enforcement, stale task handling, settings and provider messages.
- **Popup UI:** initial render, suggestions, sending, live progress, completion, errors, cancellation, tab picker (including grant/deny/restricted/hidden), settings, themes, provider add/test/activate/delete, long messages, keyboard behavior and persistence.
- **Chat:** clipping, sanitization, trimming, status patches, storage round-trips.

These suites run in Node/jsdom. They do **not** load the extension into Chrome, inject into real pages, or exercise Chrome's permission dialogs, so the manual checklist above is still required.

## Architecture

```text
src/popup/            Chat UI, tab picker, settings, provider editor
src/background.js     Provider storage, permissions, API transport, task orchestration
src/lib/api.js        OpenAI-compatible transport, errors, retries, model discovery
src/lib/providers.js  Provider normalization, validation, headers, redaction
src/lib/urls.js       Endpoint validation and URL construction
src/lib/prompt.js     System/user prompts, JSON parsing, action validation
src/lib/agent-runner.js  Plan → act → observe loop with cancellation
src/lib/tabs.js       Tab URL classification, permissions, filtering, ordering
src/lib/chat.js       Conversation model, sanitization and persistence
src/content/agent.js  Page snapshot, validated DOM actions, status HUD
```

The service worker owns task execution and stores the live task snapshot in `chrome.storage.session`. The popup is a view over that state plus its own local conversation. Chrome can suspend or restart MV3 workers; tasks are not resumed.

### Development

```bash
npm run preview      # local UI preview with mocked chrome.* APIs (port 4173)
npm run icons        # regenerate icon assets
```

The preview server serves the real popup HTML/CSS/JS with callback-based mocks and never calls a provider. It is for interface review only, not an extension runtime test.

## License

MIT. See [LICENSE](LICENSE).
