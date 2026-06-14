import { app } from "@devin/api-v1";
import { ensureDBConnection } from "@devin/drizzle/health";

const PORT = process.env.PORT || 8080;

export const main = () => {
  ensureDBConnection();
  app.listen(PORT, () => {
    console.log(`server is live @ http://localhost:${PORT}`);
  });
};
