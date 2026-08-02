import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createConnection, createServer } from "node:net";

const slots = [
  { socketPath: "/state/service-port-1.sock", targetPort: 3000 },
  { socketPath: "/state/service-port-2.sock", targetPort: 3001 },
];

for (const slot of slots) {
  await mkdir(dirname(slot.socketPath), { recursive: true });
  await rm(slot.socketPath, { force: true });
  const relay = createServer((client) => {
    const upstream = createConnection({ host: "127.0.0.1", port: slot.targetPort });
    upstream.on("connect", () => {
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => {
      if (!client.destroyed) {
        client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nWorkspace service is unavailable.");
      }
    });
    client.on("error", () => upstream.destroy());
  });
  relay.listen(slot.socketPath, () => console.log(`${slot.socketPath} -> 127.0.0.1:${slot.targetPort}`));
}
