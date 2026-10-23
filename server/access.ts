import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import type { AccessConfig } from "./config.ts";

/** The team domain's signing keys; other kinds of key are ignored. */
const certs = z.object({
  keys: z.array(z.object({ kid: z.string(), kty: z.string(), n: z.string().optional(), e: z.string().optional() })),
});
const header = z.object({ alg: z.literal("RS256"), kid: z.string() });
const claims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.number().optional(),
  // Service tokens carry no email: they are no person.
  email: z.string().optional(),
});

/** After a fetch that did not have a token's key, unknown keys wait this long for the next. */
const UNKNOWN_KEY_COOLDOWN_MS = 10_000;
const FETCH_TIMEOUT_MS = 5_000;
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export type Verified = { ok: true; email: string } | { ok: false; status: 401 | 503; reason: string };

/**
 * AUTH-1: checks a Cloudflare Access token: RS256 signed by one of the team domain's keys,
 * issued by the team domain for this application's audience, and not expired. Keys are
 * cached by id and fetched again when a token names one the cache lacks (Cloudflare rotates them).
 */
export class AccessVerifier {
  private readonly config: AccessConfig;
  private keys = new Map<string, KeyObject>();
  private loading: Promise<void> | null = null;
  /** Unknown keys trigger no fetch before this time: a token with a made-up key id must not hammer the team domain. */
  private quietUntil = 0;

  constructor(config: AccessConfig) {
    this.config = config;
  }

  async verify(token: string): Promise<Verified> {
    const refused = (reason: string): Verified => ({ ok: false, status: 401, reason });
    const parts = token.split(".");
    if (parts.length !== 3 || !parts.every((part) => SEGMENT.test(part))) return refused("the Access token is malformed");
    const [encodedHeader, encodedClaims, signature] = parts;
    let head: z.infer<typeof header>;
    let body: z.infer<typeof claims>;
    try {
      const parsedHeader = header.safeParse(JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")));
      const parsedClaims = claims.safeParse(JSON.parse(Buffer.from(encodedClaims, "base64url").toString("utf8")));
      if (!parsedHeader.success || !parsedClaims.success) return refused("the Access token is malformed");
      head = parsedHeader.data;
      body = parsedClaims.data;
    } catch {
      return refused("the Access token is malformed");
    }
    let key: KeyObject | null;
    try {
      key = await this.key(head.kid);
    } catch (cause) {
      return { ok: false, status: 503, reason: `could not fetch the Access keys: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    if (key === null) return refused("the Access token is signed by an unknown key");
    if (!verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), key, Buffer.from(signature, "base64url"))) {
      return refused("the Access token's signature is invalid");
    }
    if (body.iss !== this.config.teamDomain) return refused("the Access token is from another team");
    const audiences = typeof body.aud === "string" ? [body.aud] : body.aud;
    if (!audiences.includes(this.config.audience)) return refused("the Access token is for another application");
    const now = Date.now() / 1_000;
    if (body.exp <= now) return refused("the Access token has expired");
    if (body.nbf !== undefined && body.nbf > now) return refused("the Access token is not valid yet");
    if (body.email === undefined) return refused("the Access token names no email");
    return { ok: true, email: body.email };
  }

  private async key(kid: string): Promise<KeyObject | null> {
    const known = this.keys.get(kid);
    if (known !== undefined) return known;
    if (this.loading === null && Date.now() < this.quietUntil) return null;
    this.loading ??= this.load().finally(() => { this.loading = null; });
    await this.loading;
    const found = this.keys.get(kid) ?? null;
    if (found === null) this.quietUntil = Date.now() + UNKNOWN_KEY_COOLDOWN_MS;
    return found;
  }

  private async load(): Promise<void> {
    const response = await fetch(`${this.config.teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      this.quietUntil = Date.now() + UNKNOWN_KEY_COOLDOWN_MS;
      throw new Error(`${response.status} from the team domain`);
    }
    const keys = new Map<string, KeyObject>();
    for (const { kid, kty, n, e } of certs.parse(await response.json()).keys) {
      if (kty === "RSA" && n !== undefined && e !== undefined) keys.set(kid, createPublicKey({ key: { kty, n, e }, format: "jwk" }));
    }
    this.keys = keys;
  }
}
