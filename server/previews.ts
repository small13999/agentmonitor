import type { IncomingMessage, ServerResponse } from "node:http";
import { hostRole } from "../shared/hosts.ts";
import { sendRefusal, type Auth } from "./auth.ts";
import type { GatewayConfig } from "./config.ts";

/**
 * Answers a task's preview host, `am-p-<task id>` (shared/hosts.ts), for a person of the store
 * (AUTH-1); false for every other host. Previews come with the Preview tab (PREVIEW-1, step 6):
 * until then each says it has none.
 */
export async function handlePreview(
  request: IncomingMessage,
  response: ServerResponse,
  deps: { config: Pick<GatewayConfig, "publicOrigin">; auth: Auth },
): Promise<boolean> {
  if (hostRole(request.headers.host, deps.config.publicOrigin)?.kind !== "preview") return false;
  const visitor = await deps.auth.identify(request);
  if (visitor.kind === "refused") {
    sendRefusal(response, visitor);
    return true;
  }
  response.writeHead(404, { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" });
  response.end("This task has no preview yet.");
  return true;
}
