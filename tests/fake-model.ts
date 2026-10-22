import { writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

interface ChatMessage {
  role: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
}

/**
 * An OpenAI-compatible chat model scripted by the last user message, so workspace tests
 * run real omp turns without a real model. Markers:
 *   say:WORD      reply WORD
 *   hold:WORD     reply WORD once `release()` is called; the turn stays working until then
 *   stream:A-B    think "pondering A", reply A, then hold until `release()`, then append " B"
 *   ask:WORD      call the ask tool with question WORD; the turn blocks on the user
 *   bash:COMMAND  call the bash tool with the rest of the message as the command
 *   glob:PATTERN  call the glob tool with PATTERN
 * After a tool result the model replies "answered: " and the result's first line (omp ends
 * results with a "Wall time" line under ACP).
 */
export class FakeModel {
  private readonly server: Server;
  private held: Array<() => void> = [];
  private holdWaiters: Array<() => void> = [];
  // Providers give every tool call its own id; the chat matches results and output by it.
  private calls = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakeModel> {
    const server = createServer();
    const model = new FakeModel(server);
    server.on("request", (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => void model.answer(JSON.parse(body || "{}") as { messages?: ChatMessage[] }, response));
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    // Containers reach the host through host.containers.internal, not loopback.
    server.listen(0, "0.0.0.0", () => resolve());
    await promise;
    return model;
  }

  get port(): number {
    const address = this.server.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  /** An omp agent directory whose only model is this one, for AGENTMONITOR_OMP_AGENT_DIR. */
  writeAgentDir(dir: string, host = "host.containers.internal"): void {
    writeFileSync(join(dir, "models.yml"), [
      "providers:",
      "  fake:",
      `    baseUrl: http://${host}:${this.port}/v1`,
      "    auth: none",
      "    api: openai-completions",
      "    models:",
      "      - id: scripted",
      "        name: Scripted",
      "        contextWindow: 128000",
      "        maxTokens: 4096",
      "",
    ].join("\n"));
  }

  /** Resolves once a `hold:` request has arrived and is being held; release only after this. */
  holding(): Promise<void> {
    if (this.held.length > 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.holdWaiters.push(resolve);
    return promise;
  }

  /** Let every held reply finish. */
  release(): void {
    for (const resolve of this.held) resolve();
    this.held = [];
  }

  async stop(): Promise<void> {
    this.release();
    this.server.closeAllConnections();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => resolve());
    await promise;
  }

  private async answer(body: { messages?: ChatMessage[] }, response: ServerResponse): Promise<void> {
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const text = typeof last?.content === "string"
      ? last.content
      : (last?.content ?? []).map((part) => part.text ?? "").join("");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (delta: Record<string, unknown>, finish: string | null) => {
      response.write(`data: ${JSON.stringify({
        id: "fake",
        object: "chat.completion.chunk",
        created: 0,
        model: "scripted",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      })}\n\n`);
    };
    const user = last?.role === "user" ? text : "";
    const toolCall = (name: string, args: unknown) => {
      const id = `call_${name}_${++this.calls}`;
      chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null);
      chunk({}, "tool_calls");
    };
    const ask = /ask:(\S+)/.exec(user);
    const bash = /bash:(.+)$/s.exec(user);
    const glob = /glob:(\S+)/.exec(user);
    const stream = /stream:([^-\s]+)-(\S+)/.exec(user);
    if (ask !== null) {
      toolCall("ask", { questions: [{ id: "q", question: ask[1], options: [{ label: "Yes" }, { label: "No" }] }] });
    } else if (bash !== null) {
      toolCall("bash", { command: bash[1].trim() });
    } else if (glob !== null) {
      toolCall("glob", { path: glob[1] });
    } else if (stream !== null) {
      chunk({ role: "assistant", reasoning_content: `pondering ${stream[1]}` }, null);
      chunk({ content: stream[1] }, null);
      await this.hold();
      chunk({ content: ` ${stream[2]}` }, null);
      chunk({}, "stop");
    } else {
      if (/hold:\S+/.test(user)) await this.hold();
      const say = /(?:say|hold):(\S+)/.exec(user);
      const firstLine = text.split("\n").map((line) => line.trim()).find((line) => line !== "");
      const reply = last?.role === "tool" ? `answered: ${firstLine ?? ""}` : say?.[1] ?? "ok";
      chunk({ role: "assistant", content: reply }, null);
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  }

  private async hold(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.held.push(resolve);
    for (const waiter of this.holdWaiters) waiter();
    this.holdWaiters = [];
    await promise;
  }
}
