import { app } from "@devin/api-v1";
import { ensureDBConnection } from "@devin/drizzle/health";
import { runMigrations } from "@devin/drizzle/migrate";
import { createServer } from "node:http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const schedulerBaseUrl = () =>
  (process.env.SCHEDULER_URL ?? "http://localhost:9091").replace(/\/$/, "");

function bridgeWebSockets(client: WebSocket, upstream: WebSocket): void {
  client.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary });
    }
  });
  client.on("close", () => upstream.close());
  upstream.on("close", () => client.close());
  client.on("error", () => upstream.close());
  upstream.on("error", () => client.close());
}

export const main = async () => {
  await ensureDBConnection();
  await runMigrations();

  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    const match = url.match(/^\/api\/v1\/tasks\/([^/]+)\/desktop-vnc\/ws\/?$/);
    if (!match?.[1]) {
      return;
    }
    const taskId = decodeURIComponent(match[1]);
    wss.handleUpgrade(req, socket, head, (clientWs: WebSocket) => {
      const upstream = new WebSocket(
        `${schedulerBaseUrl().replace(/^http/, "ws")}/api/v1/tasks/${encodeURIComponent(taskId)}/desktop-vnc/ws`,
      );
      upstream.on("open", () => bridgeWebSockets(clientWs, upstream));
      upstream.on("error", () =>
        clientWs.close(1011, "scheduler websocket failed"),
      );
    });
  });

  server.listen(PORT, () => {
    console.log(`server is live @ http://localhost:${PORT}`);
  });
};
