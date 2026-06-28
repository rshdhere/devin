import { app } from "@devin/api-v1";
import { ensureDBConnection } from "@devin/drizzle/health";
import { runMigrations } from "@devin/drizzle/migrate";

const PORT = process.env.PORT || 8080;

export const main = async () => {
  await ensureDBConnection();
  await runMigrations();
  app.listen(PORT, () => {
    console.log(`server is live @ http://localhost:${PORT}`);
  });
};
