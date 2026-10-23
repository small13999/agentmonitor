import type { IncomingMessage, ServerResponse } from "node:http";
import { hostRole } from "../shared/hosts.ts";
import type { GatewayConfig } from "./config.ts";

/**
 * Answers a task's preview host, `am-p-<task id>` (shared/hosts.ts); false for every other
 * host. Previews come with the Preview tab (PREVIEW-1, step 6): until then each says it has none.
 */
export function handlePreview(request: IncomingMessage, response: ServerResponse, config: Pick<GatewayConfig, "publicOrigin">): boolean {
  if (hostRole(request.headers.host, config.publicOrigin)?.kind !== "preview") return false;
  response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
  response.end("This task has no preview yet.");
  return true;
}
