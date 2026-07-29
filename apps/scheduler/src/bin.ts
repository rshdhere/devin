import { main } from "./main.js";

await main().catch((error) => {
  console.error(error);
  process.exit(1);
});
