// Starts the website (and, by default, the background worker in the same process).
import { bootstrap } from "./bootstrap.js";
import { createApp } from "./app.js";

const { config, prisma, deps, worker } = await bootstrap();
const app = createApp(deps);

if (config.AUTH_MODE === "dev") console.warn("⚠  AUTH_MODE=dev: anyone can log in as any email. Local testing only.");
if (!config.GEMINI_API_KEY) console.warn("⚠  GEMINI_API_KEY is empty: no AI follow-ups; answers show quoted passages instead of written answers.");
if (!config.VOYAGE_API_KEY) console.warn("⚠  VOYAGE_API_KEY is empty: search matches words, not meaning.");
if (config.MAIL_PROVIDER === "console") console.warn("⚠  MAIL_PROVIDER=console: invitation emails are printed here, not sent.");

if (config.WORKER_INLINE) worker.start();
const server = app.listen(config.PORT, () => console.log(`Handover running on port ${config.PORT} (${config.PUBLIC_BASE_URL})`));

const shutdown = async () => {
  worker.stop();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
