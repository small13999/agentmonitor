import { connect } from "node:net";
import { join } from "node:path";

export type ChannelReply = Record<string, unknown> & { ok: boolean; error?: string };

/**
 * One request on a workspace's omp extension socket (container/omp-extension.ts).
 * Resolves null when no live omp answers within the timeout: the session is stopped.
 */
export async function ompRequest(
  runDir: string,
  op: string,
  fields: Record<string, unknown> = {},
  timeoutMs = 1500,
): Promise<ChannelReply | null> {
  const socket = connect(join(runDir, "omp.sock"));
  const { promise, resolve } = Promise.withResolvers<ChannelReply | null>();
  const timer = setTimeout(() => resolve(null), timeoutMs);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => resolve(null));
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line) as ChannelReply & { id?: number };
      if (message.id === 1) resolve(message);
    }
  });
  socket.write(`${JSON.stringify({ ...fields, id: 1, op })}\n`);
  return promise.finally(() => {
    clearTimeout(timer);
    socket.destroy();
  });
}
