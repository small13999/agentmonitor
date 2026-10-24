import type { DraftAttachment } from "../../shared/chat.ts";

/** Images the model takes as images (CHAT-4); every other file goes to the folder. */
const PROMPT_IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
/** Images up to this size go as they are. */
const KEEP_BYTES = 1024 * 1024;
/** Larger ones are scaled to this longest edge and re-encoded. */
const MAX_EDGE = 2048;
const QUALITY = 0.85;

export function isPromptImage(attachment: { mimeType: string }): boolean {
  return PROMPT_IMAGES.has(attachment.mimeType);
}

async function base64Of(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onload = () => resolve(typeof reader.result === "string" ? reader.result.slice(reader.result.indexOf(",") + 1) : "");
  reader.onerror = () => reject(reader.error ?? new Error("The file could not be read."));
  reader.readAsDataURL(blob);
  return promise;
}

/** A large image scaled down and re-encoded as WebP, or JPEG where the browser cannot write WebP. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The browser cannot scale images.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const encode = async (type: string) => {
    const { promise, resolve } = Promise.withResolvers<Blob | null>();
    canvas.toBlob(resolve, type, QUALITY);
    return promise;
  };
  const webp = await encode("image/webp");
  if (webp !== null && webp.type === "image/webp") return webp;
  const jpeg = await encode("image/jpeg");
  if (jpeg === null) throw new Error("The browser cannot encode images.");
  return jpeg;
}

/** A pasted, dropped or chosen file as the draft keeps it. */
export async function attachmentOf(file: File): Promise<DraftAttachment> {
  const mimeType = file.type === "" ? "application/octet-stream" : file.type;
  // Pasted screenshots all come as "image.png"; a time tells them apart.
  const name = file.name === "" || file.name === "image.png" ? `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}${mimeType === "image/png" ? ".png" : ""}` : file.name;
  if (PROMPT_IMAGES.has(mimeType) && file.size > KEEP_BYTES) {
    const smaller = await shrink(file);
    return { name: `${name.replace(/\.[^.]*$/, "")}${smaller.type === "image/webp" ? ".webp" : ".jpg"}`, mimeType: smaller.type, data: await base64Of(smaller) };
  }
  return { name, mimeType, data: await base64Of(file) };
}

export function blobOf(attachment: DraftAttachment): Blob {
  return new Blob([Uint8Array.from(atob(attachment.data), (char) => char.charCodeAt(0))], { type: attachment.mimeType });
}

/** `chat/<yyyy-mm-dd-hhmmss>-<name>`: where a file a person sent goes in the folder (CHAT-4). */
export function folderPathOf(name: string, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `chat/${stamp}-${name.replace(/[/\\]/g, "-")}`;
}
