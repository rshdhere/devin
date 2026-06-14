import { Request, Response, Router } from "express";

export const healthRouter = Router();

export const healthHandler = (_req: Request, res: Response) => {
  return res.status(200).json({
    status: "ok",
  });
};

healthRouter.get("/", healthHandler);
