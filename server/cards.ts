import { existsSync } from "node:fs";
import { z } from "zod";
import { git, uncommittedFiles, unpushedCommits } from "./git.ts";
import { openPullRequests } from "./github.ts";
import { ompRequest } from "./omp-channel.ts";
import type { WorkspaceDirs } from "./runtime/runtime.ts";
import type { Card, TurnLight } from "../shared/api.ts";
import type { Principal, Store } from "./store/store.ts";
import { newestTranscript, readTranscript } from "./transcript.ts";

// omp's messages as its transcript stores them; only what a card shows is checked.
const blocks = z.array(z.object({ type: z.string(), text: z.string().optional() }));
const userMessage = z.object({ role: z.literal("user"), content: z.union([z.string(), blocks]) });
const assistantMessage = z.object({ role: z.literal("assistant"), content: blocks });

function textOf(content: string | z.infer<typeof blocks>): string {
  return typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
}

/** The live session's turn state and chat file (as omp sees it); no answer means no live agent. */
async function liveState(runDir: string): Promise<{ turn: TurnLight; chat: string | null }> {
  const reply = await ompRequest(runDir, "state");
  const turn = reply?.ok === true ? reply.turn : undefined;
  const chat = reply?.ok === true && typeof reply.sessionFile === "string" ? reply.sessionFile : null;
  return { turn: turn === "blocked" || turn === "working" || turn === "done" ? turn : "stopped", chat };
}

/** Last user message and last assistant text; the transcript's last 1 MiB is plenty. */
function lastMessages(path: string): { user: string | null; reply: string | null } {
  let user: string | null = null;
  let reply: string | null = null;
  for (const message of readTranscript(path, 1024 * 1024)) {
    const asUser = userMessage.safeParse(message);
    if (asUser.success) user = textOf(asUser.data.content);
    const asAssistant = assistantMessage.safeParse(message);
    const text = asAssistant.success ? textOf(asAssistant.data.content) : "";
    if (text.trim() !== "") reply = text;
  }
  return { user, reply };
}

/** A worktree's uncommitted files, unpushed commits, and every file it changed since it left `baseRef`; null when git cannot read it. */
export async function gitState(worktree: string, baseRef: string): Promise<Card["git"]> {
  if (!existsSync(worktree)) return null;
  try {
    const uncommitted = await uncommittedFiles(worktree);
    const mergeBase = await git(worktree, ["merge-base", "HEAD", baseRef]);
    const unpushed = (await unpushedCommits(worktree, "HEAD", baseRef)).length;
    const changed = (await git(worktree, ["diff", "--name-only", mergeBase])).split("\n").filter(Boolean);
    return { uncommitted, unpushed, changedFiles: [...new Set([...changed, ...uncommitted])].sort() };
  } catch {
    return null;
  }
}

/** CARD-1, CARD-3, CARD-4: one card per running session of the project, oldest first. */
export async function projectCards(
  store: Store,
  dirsOf: (sessionId: string) => WorkspaceDirs,
  cloudflareOf: (sessionId: string) => Card["cloudflare"],
  principal: Principal,
  projectId: string,
): Promise<Card[]> {
  const { repoPath } = store.getProject(principal, projectId);
  const cards = await Promise.all(store.listSessions(principal, projectId).map(async (session) => {
    const dirs = dirsOf(session.id);
    const hasWorktree = session.branch !== null && session.baseRef !== null && existsSync(dirs.worktree);
    const [live, gitInfo, prs] = await Promise.all([
      liveState(dirs.run),
      hasWorktree ? gitState(dirs.worktree, session.baseRef ?? "") : null,
      hasWorktree ? openPullRequests(dirs.worktree, session.branch ?? "") : null,
    ]);
    // SESSION-7: the chat the session runs now: the one omp has open (a host session's path is
    // this machine's; omp writes it with the first message), else the newest; a checkout
    // session's sit among the user's (HOST-7).
    const transcript = session.runtime === "host" && live.chat !== null && existsSync(live.chat)
      ? live.chat
      : newestTranscript(dirs.ompHome, session.checkout ? repoPath : null);
    const messages = transcript === null ? { user: null, reply: null } : lastMessages(transcript);
    const card: Card = {
      session,
      // AUTO-10: a run waiting for review waits on a person while its agent is idle.
      turn: session.run?.outcome === "review" && live.turn === "done" ? "blocked" : live.turn,
      lastUserMessage: messages.user,
      lastReply: messages.reply,
      git: gitInfo,
      pullRequests: prs,
      overlaps: [],
      cloudflare: cloudflareOf(session.id),
    };
    return card;
  }));
  for (const card of cards) {
    const mine = new Set(card.git?.changedFiles ?? []);
    for (const other of cards) {
      if (other === card) continue;
      const files = (other.git?.changedFiles ?? []).filter((file) => mine.has(file));
      if (files.length > 0) card.overlaps.push({ sessionId: other.session.id, name: other.session.name, files });
    }
  }
  return cards;
}
