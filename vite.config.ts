import { watch } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { handleApi } from "./server/api.ts";
import { Auth, sendRefusal } from "./server/auth.ts";
import { loadConfig } from "./server/config.ts";
import { Hubs, loadHubs } from "./server/hubs.ts";
import { StoreService } from "./server/store/service.ts";
import { TernProxy } from "./server/tern-proxy.ts";

// Local development gateway. Production uses server/index.ts; both share the server/*
// modules so behavior cannot drift.

declare global {
  /** The store the last config load started; Vite evaluates this file afresh on every config reload. */
  var agentmonitorStore: StoreService | undefined;
}

function gateway(): Plugin {
  // The store opens only when a server starts, never during `vite build`: the tests build the
  // app, and a build must not open, let alone migrate, the user's live store.
  const attach = async (server: ViteDevServer | PreviewServer) => {
    // A config reload starts the new server before closing the old one, and closing a socket
    // server unlinks its path: the previous store closes first, so its sockets and database
    // do not pile up and its close does not delete the new store's sockets.
    globalThis.agentmonitorStore?.close();
    const config = loadConfig();
    const hubs = new Hubs(loadHubs(config.configDir));
    const store = new StoreService(config.stateDir, config);
    const auth = new Auth(config, store.store);
    const tern = new TernProxy({ auth, store });
    globalThis.agentmonitorStore = store;
    await store.start();
    server.middlewares.use(async (request, response, next) => {
      // Tern hosts first: Vite would answer them with the monitor's own pages.
      if (await tern.handleRequest(request, response)) return;
      if (await handleApi(request, response, { config, auth, store, hubs })) return;
      // AUTH-1: the app's pages and modules too.
      const visitor = await auth.identify(request);
      if (visitor.kind === "refused") sendRefusal(response, visitor);
      else next();
    });
    // Upgrades Tern does not take are Vite's own (HMR), so they are left alone; in access mode
    // Vite has no socket, so nothing would answer them.
    server.httpServer?.on("upgrade", (request, socket, head) => {
      tern.handleUpgrade(request, socket, head).then(
        (handled) => { if (!handled && config.authMode === "access") socket.destroy(); },
        (cause: unknown) => {
          console.error("upgrade handling failed", cause);
          socket.destroy();
        },
      );
    });
  };
  return {
    name: "agentmonitor-gateway",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

/**
 * Restarts the dev server when an `npm install` finishes. Vite does not watch node_modules and
 * keeps a failed import's resolution cached, so a merge that adds a package leaves the app
 * broken until a restart even once the package is installed. npm writes
 * `node_modules/.package-lock.json` last in every install.
 */
function restartOnInstall(): Plugin {
  return {
    name: "agentmonitor-restart-on-install",
    configureServer(server) {
      const watcher = watch("node_modules", (_event, file) => {
        if (file !== ".package-lock.json") return;
        server.config.logger.info("packages changed: restarting", { timestamp: true });
        watcher.close();
        void server.restart(true);
      });
      server.httpServer?.once("close", () => watcher.close());
    },
  };
}

export default defineConfig({
  plugins: [gateway(), restartOnInstall(), react()],
  server: {
    allowedHosts: [".localhost"],
    port: 5173,
    strictPort: true,
    // AUTH-1: Vite's own socket (HMR) would take upgrades the gateway never checks.
    ws: process.env.AGENTMONITOR_AUTH_MODE === "access" ? false : undefined,
  },
  preview: {
    allowedHosts: [".localhost"],
    port: 4173,
    strictPort: true,
  },
});
