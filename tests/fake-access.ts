import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";

/** The Access application's audience tag a hub under test checks. */
export const AUDIENCE = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid: randomBytes(16).toString("hex"), privateKey, publicKey };
}

/** A Cloudflare Access team domain: its keys at /cdn-cgi/access/certs, and tokens signed with them. */
export class FakeAccess {
  readonly url: string;
  private readonly server: Server;
  /** The keys the team domain publishes. */
  readonly keys: SigningKey[];

  private constructor(url: string, server: Server, keys: SigningKey[]) {
    this.url = url;
    this.server = server;
    this.keys = keys;
  }

  static async start(): Promise<FakeAccess> {
    const keys = [signingKey()];
    const server = createServer((req, res) => {
      if (req.url !== "/cdn-cgi/access/certs") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: keys.map((key) => ({ ...key.publicKey.export({ format: "jwk" }), kid: key.kid, alg: "RS256", use: "sig" })) }));
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    return new FakeAccess(`http://127.0.0.1:${port}`, server, keys);
  }

  /** A token as Cloudflare Access issues one for `email`; `claims` and `key` change it. */
  token(email: string, claims: Record<string, unknown> = {}, key: SigningKey = this.keys[0]): string {
    const now = Math.floor(Date.now() / 1_000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = encode({ alg: "RS256", kid: key.kid, typ: "JWT" });
    const body = encode({ aud: [AUDIENCE], email, exp: now + 3_600, iat: now, nbf: now, iss: this.url, type: "app", sub: email, ...claims });
    return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
  }

  stop(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => resolve());
    return promise;
  }
}
