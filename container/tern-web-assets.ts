// Stores Tern's web client for `tern web serve --assets`, so a browser loads nothing from
// outside the gateway: at image build in /opt/agentmonitor/tern-web, and for host sessions
// where the host runtime asks (usage: node tern-web-assets.ts [OUT]).
// A release tern embeds the page, script, icons and manifest, and points the page at the
// release's wasm on build.stencil.so, pinned by a sha384 integrity hash. The wasm is
// downloaded here, checked against that pin, and the page is pointed at the local copy.
// The page names its script and wasm with a content version (?v=…), so the gateway can let
// browsers keep them, and it starts Tern dark: the web client keeps its settings in the
// page's localStorage, not in the container's settings.json.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = process.argv[2] ?? "/opt/agentmonitor/tern-web";
const WASM = "pkg/stencil_tern_web_bg.wasm";
const SCRIPT = "pkg/stencil_tern_web.js";
const DEFAULT_SETTINGS = JSON.stringify({ theme: "Dark" });
// A free loopback port for Tern's own server: host sessions may already use any fixed one.
const probe = createServer();
const listening = Promise.withResolvers<void>();
probe.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const probeAddress = probe.address();
if (probeAddress === null || typeof probeAddress === "string") throw new Error("no free loopback port");
probe.close();
const origin = `http://127.0.0.1:${probeAddress.port}`;
const tokenFile = join(mkdtempSync(join(tmpdir(), "tern-web-assets-")), "token");
writeFileSync(tokenFile, "0".repeat(32), { mode: 0o600 });
const server = spawn("tern", ["web", "serve", "--listen", `127.0.0.1:${probeAddress.port}`, "--token", tokenFile], { stdio: "ignore" });

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

function save(path: string, body: Uint8Array | string): void {
  mkdirSync(dirname(join(OUT, path)), { recursive: true });
  writeFileSync(join(OUT, path), body);
}

function version(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function replaceOnce(page: string, find: string, replacement: string): string {
  if (!page.includes(find)) throw new Error(`Tern's page no longer contains ${find}`);
  return page.replace(find, replacement);
}

try {
  let page = "";
  for (let attempt = 0; page === ""; attempt++) {
    try {
      page = await (await fetchOk(`${origin}/`)).text();
    } catch (error) {
      if (attempt === 50) throw error;
      await sleep(100);
    }
  }

  const link = /<link id="wasm"[^>]*href="(https:[^"]+)"[^>]*integrity="sha384-([^"]+)"/.exec(page);
  if (link === null) throw new Error("the page names no pinned wasm; this tern serves a development build");
  const [pinned, url, digest] = link;
  const wasm = new Uint8Array(await (await fetchOk(url)).arrayBuffer());
  const actual = createHash("sha384").update(wasm).digest("base64");
  if (actual !== digest) throw new Error(`${url} has sha384 ${actual}, the page pins ${digest}`);
  save(WASM, wasm);
  const script = new Uint8Array(await (await fetchOk(`${origin}/${SCRIPT}`)).arrayBuffer());
  save(SCRIPT, script);
  page = replaceOnce(page, pinned, pinned.replace(url, `${WASM}?v=${version(wasm)}`));
  page = replaceOnce(page, `from "./${SCRIPT}"`, `from "./${SCRIPT}?v=${version(script)}"`);
  page = replaceOnce(page, `<script type="module">`, `<script>if (localStorage.getItem("settings.json") === null) localStorage.setItem("settings.json", ${JSON.stringify(DEFAULT_SETTINGS)});</script>\n\t<script type="module">`);
  save("index.html", page);

  const manifest: unknown = await (await fetchOk(`${origin}/manifest.webmanifest`)).json();
  const icons = typeof manifest === "object" && manifest !== null && "icons" in manifest && Array.isArray(manifest.icons)
    ? manifest.icons.flatMap((icon: unknown) => typeof icon === "object" && icon !== null && "src" in icon && typeof icon.src === "string" ? [icon.src] : [])
    : [];
  const files = new Set(["manifest.webmanifest", "favicon.svg", "favicon-32.png", "apple-touch-icon.png", ...icons]);
  for (const file of files) save(file, new Uint8Array(await (await fetchOk(`${origin}/${file}`)).arrayBuffer()));
} finally {
  server.kill();
}
