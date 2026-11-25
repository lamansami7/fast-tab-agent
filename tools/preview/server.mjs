#!/usr/bin/env node
/**
 * UI preview server (development only — never shipped in the extension).
 *
 * Serves the real popup from src/popup with tools/preview/mock-chrome.js
 * injected, so the interface can be reviewed in a normal browser tab without
 * loading the unpacked extension. All provider calls are simulated.
 *
 *   node tools/preview/server.mjs        # http://localhost:4173
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Fast Tab Agent — popup preview</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 18px; padding: 32px 20px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: #eceef4;
    background:
      radial-gradient(60% 50% at 50% 0%, rgba(139,123,255,.16), transparent 70%),
      radial-gradient(50% 40% at 80% 100%, rgba(91,140,255,.12), transparent 70%),
      #07080c;
  }
  .head { text-align: center; max-width: 560px; }
  .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 6px; }
  .logo {
    display: grid; place-items: center; width: 32px; height: 32px; border-radius: 10px;
    background: linear-gradient(140deg, #8b7bff, #5b8cff 60%, #37c2ff);
    box-shadow: 0 8px 24px rgba(91,140,255,.35);
  }
  h1 { font-size: 18px; margin: 0; letter-spacing: -0.01em; }
  .head p { margin: 4px 0 0; color: #8b93a7; font-size: 12.5px; }
  .frame {
    width: 420px; height: 600px; border-radius: 16px; overflow: hidden;
    border: 1px solid rgba(255,255,255,.10);
    box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(0,0,0,.4);
    background: #0a0b10; position: relative;
  }
  iframe { width: 420px; height: 600px; border: 0; display: block; }
  .notes {
    max-width: 420px; font-size: 11.5px; color: #6f7891; text-align: center;
  }
  .notes code { color: #a8b0c4; background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 5px; font-size: 11px; }
  .actions { display: flex; gap: 8px; }
  button {
    font: inherit; font-size: 12px; color: #c7cbd8; cursor: pointer;
    background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
    padding: 7px 13px; border-radius: 9px;
  }
  button:hover { background: rgba(255,255,255,.11); color: #fff; }
</style>
</head>
<body>
  <div class="head">
    <div class="brand">
      <span class="logo" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M13.4 2.5 5 13.2h5.1l-1.5 8.3 8.6-11H12l1.4-8Z" fill="#fff"/></svg>
      </span>
      <h1>Fast Tab Agent</h1>
    </div>
    <p>Live preview of the extension popup — canned tabs, providers and a scripted task.</p>
  </div>
  <div class="frame"><iframe src="/popup.html" title="Fast Tab Agent popup"></iframe></div>
  <div class="actions">
    <button type="button" onclick="document.querySelector('iframe').contentWindow.location.reload()">Reset preview</button>
  </div>
  <p class="notes">
    Everything here is mocked: tabs, permissions, providers and task progress never leave this page.
    Try the tab picker, send a request, stop it, and switch theme in Settings → Behaviour.
  </p>
</body>
</html>`;

function safeJoin(base, pathname) {
  const decoded = decodeURIComponent(pathname);
  const target = normalize(join(base, decoded));
  return target.startsWith(base) ? target : null;
}

async function sendFile(response, filePath) {
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      'content-type': MIME[extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    response.end(LANDING);
    return;
  }

  if (pathname === '/popup.html') {
    try {
      let html = await readFile(join(ROOT, 'src', 'popup', 'popup.html'), 'utf8');
      html = html.replace('href="popup.css"', 'href="/src/popup/popup.css"');
      html = html.replace(
        '<script type="module" src="popup.js"></script>',
        '<script src="/mock-chrome.js"></script>\n    <script type="module" src="/src/popup/popup.js"></script>',
      );
      response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      response.end(html);
    } catch {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Could not read the popup');
    }
    return;
  }

  if (pathname === '/mock-chrome.js') {
    await sendFile(response, join(HERE, 'mock-chrome.js'));
    return;
  }

  const allowed =
    pathname.startsWith('/src/') || pathname.startsWith('/icons/') || pathname.startsWith('/tools/preview/');
  if (!allowed) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('Not found');
    return;
  }

  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('Forbidden');
    return;
  }
  await sendFile(response, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`Fast Tab Agent preview → http://localhost:${PORT}`);
});
