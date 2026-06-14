import { sql } from "drizzle-orm";
import { db } from "./index.js";

export const ensureDBConnection = async () => {
  try {
    await db.execute(sql`SELECT 1`);
    console.log("connected to database.");
  } catch (err) {
    console.error("database connection failed.");
    console.error(err);
  }
};
