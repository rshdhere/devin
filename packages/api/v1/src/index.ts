import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { applyCorsHeaders } from "./lib/cors.js";
import { router } from "./routes/index.js";

export const app = express();

app.set("trust proxy", true);

app.use((req, res, next) => {
  applyCorsHeaders(res, req.headers.origin, req.hostname);

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

const authHandler = toNodeHandler(auth);

app.all("/api/v1/auth/{*any}", (req, res, _next) => {
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (
    name: string,
    value: string | number | readonly string[],
  ) => {
    if (name.toLowerCase() === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [String(value)];
      const enhancedCookies: string[] = [];

      for (const cookie of cookies) {
        enhancedCookies.push(cookie);

        if (
          cookie.includes("Domain=.") &&
          cookie.includes("session_token=") &&
          !cookie.includes("Max-Age=0")
        ) {
          const cookieName = cookie.split("=")[0];
          if (cookieName) {
            enhancedCookies.push(
              `${cookieName}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None`,
            );
          }
        }
      }

      return originalSetHeader(name, enhancedCookies);
    }
    return originalSetHeader(name, value);
  };

  authHandler(req, res);
});

app.use(express.json());
app.use("/api/v1/", router);

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    applyCorsHeaders(res, req.headers.origin, req.hostname);
    const message =
      err instanceof Error ? err.message : "Internal server error";
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  },
);
