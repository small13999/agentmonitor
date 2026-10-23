import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright";
import type { FolderFile, HistoryEntry, Person, Project, Session, Task } from "../shared/api.ts";
import { buildApp, Gateway } from "./harness.ts";
import { spec } from "./spec.ts";

let gateway: Gateway;
let chrome: Browser;
let page: Page;
let project: Project;
let owner: Person;
let scratch: string;

before(async () => {
  buildApp();
  [gateway, chrome] = await Promise.all([Gateway.start(), chromium.launch()]);
  page = await chrome.newPage();
  page.setDefaultTimeout(10_000);
  project = await gateway.data<Project>("POST", "/projects", { name: "draftcoach" });
  owner = (await gateway.data<{ person: Person }>("GET", "/me")).person;
  scratch = mkdtempSync(join(tmpdir(), "am-folder-"));
});
after(async () => {
  await chrome?.close();
  await gateway?.stop();
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

function task(title: string): Promise<Task> {
  return gateway.data<Task>("POST", `/projects/${project.id}/tasks`, { title });
}

/** Drops files on the task page's folder as a person dragging them from their desktop would. */
async function drop(files: Array<{ name: string; type: string; bytes: Buffer }>): Promise<void> {
  const dataTransfer = await page.evaluateHandle((dropped) => {
    const transfer = new DataTransfer();
    for (const file of dropped) {
      transfer.items.add(new File([Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))], file.name, { type: file.type }));
    }
    return transfer;
  }, files.map((file) => ({ name: file.name, type: file.type, base64: file.bytes.toString("base64") })));
  const folder = page.getByRole("region", { name: "Folder" });
  await folder.dispatchEvent("dragover", { dataTransfer });
  await folder.dispatchEvent("drop", { dataTransfer });
}

function row(path: string) {
  return page.getByRole("region", { name: "Folder" }).getByRole("row").filter({ has: page.getByRole("button", { name: path, exact: true }) });
}

/** A 2×1 PNG: a red pixel and a blue one. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A one-page PDF. */
function pdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj ${object} endobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A short WebM video, recorded in the page from a canvas whose colour changes each frame. */
async function webm(): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d canvas");
    const recorder = new MediaRecorder(canvas.captureStream(0), { mimeType: "video/webm" });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = Promise.withResolvers<unknown>();
    recorder.onstop = stopped.resolve;
    recorder.start();
    const track = recorder.stream.getVideoTracks()[0];
    for (const colour of ["red", "blue", "green", "white"]) {
      context.fillStyle = colour;
      context.fillRect(0, 0, 64, 48);
      if ("requestFrame" in track && typeof track.requestFrame === "function") track.requestFrame();
      const painted = Promise.withResolvers<unknown>();
      requestAnimationFrame(painted.resolve);
      await painted.promise;
    }
    recorder.stop();
    await stopped.promise;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  return Buffer.from(base64, "base64");
}

spec("FOLDER-1", "people drop files on the task's page and agents add them with am folder, into the task's folder in the store", async () => {
  const target = await task("Patch notes 26.22");
  const session = await gateway.data<Session>("POST", `/tasks/${target.id}/sessions`, {});
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  await page.getByRole("region", { name: "Folder" }).getByText("No files yet.").waitFor();

  // A person drops a brief; its row names them.
  const brief = "# Brief\n\nTranslate the JP notes 3f1a.\n";
  await drop([{ name: "brief.md", type: "text/markdown", bytes: Buffer.from(brief) }]);
  await row("brief.md").getByText(owner.name).waitFor();

  // The agent adds its output, larger than any JSON body the store takes, under a folder of its own.
  const data = Buffer.alloc(300 * 1024, "notes 26.22 ");
  writeFileSync(join(scratch, "data.txt"), data);
  const added = gateway.am(session.id, ["folder", "add", join(scratch, "data.txt"), "out/data.txt"]);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.stdout, `added out/data.txt (${data.length} bytes)\n`);
  await row("out/data.txt").getByText("Agent").waitFor();

  // The agent sees the person's file and gets it back as dropped.
  const listed = gateway.am(session.id, ["folder"]).stdout.split("\n").filter(Boolean).map((line) => line.split("\t").slice(0, 3));
  assert.deepEqual(listed, [
    ["brief.md", `${Buffer.byteLength(brief)} bytes`, `added by ${owner.name}`],
    ["out/data.txt", `${data.length} bytes`, "added by this session's agent"],
  ]);
  assert.equal(gateway.am(session.id, ["folder", "get", "brief.md"]).stdout, brief);
  assert.equal(gateway.am(session.id, ["folder", "get", "out/data.txt", join(scratch, "back.txt")]).code, 0);
  assert.ok(readFileSync(join(scratch, "back.txt")).equals(data));

  // Both additions are the task's history, each with who added the file.
  const history = await gateway.data<HistoryEntry[]>("GET", `/tasks/${target.id}/history`);
  assert.deepEqual(history.filter((entry) => entry.kind === "file").map((entry) => [entry.kind === "file" ? entry.path : null, entry.actor]), [
    ["brief.md", { kind: "person", personId: owner.id }],
    ["out/data.txt", { kind: "agent", sessionId: session.id }],
  ]);

  // The agent's delete leaves the page too.
  assert.equal(gateway.am(session.id, ["folder", "rm", "out/data.txt"]).code, 0);
  await row("out/data.txt").waitFor({ state: "detached" });
  assert.deepEqual((await gateway.data<FolderFile[]>("GET", `/tasks/${target.id}/folder`)).map((file) => file.path), ["brief.md"]);
});

spec("FOLDER-2", "a folder's files show inline by kind with who added them and when, and download one by one or as a zip", async () => {
  const target = await task("Release review");
  await page.goto(`${gateway.url}/#/t/${target.id}`);
  await page.getByRole("region", { name: "Folder" }).getByText("No files yet.").waitFor();
  const files = {
    "shot.png": { type: "image/png", bytes: png() },
    "clip.webm": { type: "video/webm", bytes: await webm() },
    "spec.pdf": { type: "application/pdf", bytes: pdf() },
    "notes.md": { type: "text/markdown", bytes: Buffer.from("# Review 7d2e\n\n- **bold** point\n") },
    "run.log": { type: "text/plain", bytes: Buffer.from("step 1 ok\nstep 2 ok 9a4c\n") },
  };
  await drop(Object.entries(files).map(([name, file]) => ({ name, ...file })));
  for (const name of Object.keys(files)) await row(name).waitFor();

  // Each row says who added the file and when.
  const stored = await gateway.data<FolderFile[]>("GET", `/tasks/${target.id}/folder`);
  for (const file of stored) {
    await row(file.path).getByText(owner.name).waitFor();
    assert.equal(await row(file.path).locator("time").getAttribute("datetime"), new Date(file.addedAt).toISOString());
  }

  const show = async (name: string) => {
    await row(name).getByRole("button", { name, exact: true }).click();
    return page.getByRole("figure", { name: `Preview of ${name}` });
  };
  const image = (await show("shot.png")).getByRole("img", { name: "shot.png" });
  await image.waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>("figure img")?.naturalWidth === 2);

  await (await show("clip.webm")).locator("video").waitFor();
  // The video decodes: its frames have the recorded size.
  await page.waitForFunction(() => document.querySelector("video")?.videoWidth === 64);

  const pdfFrame = (await show("spec.pdf")).locator("iframe");
  const pdfResponse = await page.request.get(new URL(String(await pdfFrame.getAttribute("src")), gateway.url).href);
  assert.equal(pdfResponse.headers()["content-type"], "application/pdf");
  assert.match(pdfResponse.headers()["content-disposition"], /^inline/);
  assert.ok((await pdfResponse.body()).equals(files["spec.pdf"].bytes));

  const markdown = await show("notes.md");
  await markdown.getByRole("heading", { name: "Review 7d2e" }).waitFor();
  await markdown.locator("strong", { hasText: "bold" }).waitFor();

  await (await show("run.log")).locator("pre", { hasText: "step 2 ok 9a4c" }).waitFor();

  // One file downloads as it is.
  const single = page.waitForEvent("download");
  await row("notes.md").getByRole("link", { name: "Download notes.md" }).click();
  const downloaded = await single;
  assert.equal(downloaded.suggestedFilename(), "notes.md");
  assert.ok(readFileSync(await downloaded.path()).equals(files["notes.md"].bytes));

  // The whole folder downloads as a zip holding every file intact.
  const whole = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download all (.zip)" }).click();
  const zip = await whole;
  assert.equal(zip.suggestedFilename(), "Release-review.zip");
  const zipPath = join(scratch, "folder.zip");
  await zip.saveAs(zipPath);
  execFileSync("unzip", ["-tq", zipPath]);
  assert.deepEqual(execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).split("\n").filter(Boolean), Object.keys(files).sort());
  for (const [name, file] of Object.entries(files)) {
    assert.ok(execFileSync("unzip", ["-p", zipPath, name]).equals(file.bytes), `${name} is intact in the zip`);
  }
});
