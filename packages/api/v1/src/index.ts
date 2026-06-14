import express from "express";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.js";
import { router } from "./routes/index.js";

export const app = express();

app.all("/api/v1/auth/{*any}", toNodeHandler(auth));

app.use(express.json());
app.use("/api/v1/", router);
