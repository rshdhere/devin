import { Router } from "express";
import { healthRouter } from "../handlers/health.js";

export const router = Router();

router.use(healthRouter);
