import type { auth } from "../lib/auth.js";

declare global {
  namespace Express {
    interface Request {
      auth?: Awaited<ReturnType<typeof auth.api.getSession>>;
    }
  }
}

export {};
