import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { handleApi } from "./server/api.ts";
import { AuthStore } from "./server/auth.ts";
import { loadConfig } from "./server/config.ts";
import { StoreService } from "./server/store/service.ts";
import { TernProxy } from "./server/tern-proxy.ts";

// Local development gateway. Production uses server/index.ts; both share the server/*
// modules so behavior cannot drift.
const config = loadConfig();
const auth = new AuthStore(config);
const store = new StoreService(config.stateDir, config);
const tern = new TernProxy({ config, auth, store });

declare global {
  /** The store the last config load started; Vite evaluates this file afresh on every config reload. */
  var agentmonitorStore: StoreService | undefined;
}

function gateway(): Plugin {
  // Agent sockets keep the process alive, so they open only when a server starts, never during `vite build`.
  const attach = async (server: ViteDevServer | PreviewServer) => {
    // A config reload starts the new server before closing the old one, and closing a socket
    // server unlinks its path: the previous store closes first, so its sockets and database
    // do not pile up and its close does not delete the new store's sockets.
    globalThis.agentmonitorStore?.close();
    globalThis.agentmonitorStore = store;
    await store.start();
    server.middlewares.use(async (request, response, next) => {
      // Tern hosts first: Vite would answer them with the monitor's own pages.
      if (await tern.handleRequest(request, response)) return;
      if (await handleApi(request, response, { config, auth, store })) return;
      next();
    });
    // Upgrades Tern does not take are Vite's own (HMR), so they are left alone.
    server.httpServer?.on("upgrade", (request, socket, head) => {
      tern.handleUpgrade(request, socket, head).catch((cause: unknown) => {
        console.error("upgrade handling failed", cause);
        socket.destroy();
      });
    });
  };
  return {
    name: "agentmonitor-gateway",
    configureServer: attach,
    configurePreviewServer: attach,
  };
}

export default defineConfig({
  plugins: [gateway(), react()],
  server: {
    allowedHosts: [".localhost"],
    port: 5173,
    strictPort: true,
  },
  preview: {
    allowedHosts: [".localhost"],
    port: 4173,
    strictPort: true,
  },
});
