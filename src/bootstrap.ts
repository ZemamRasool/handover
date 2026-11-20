// Wires the real pieces together. Used by server.ts and worker.ts.
import { loadConfig } from "./config.js";
import { createPrisma } from "./lib/prisma.js";
import { createAuthBackend } from "./auth/verifyToken.js";
import { createVoyageEmbedder, hashEmbedder } from "./services/embeddings.js";
import { createGeminiAnswerer, createGeminiFollowUp } from "./services/ai.js";
import { createGoogleDrive } from "./services/drive.js";
import { createConsoleMailer, createPostmarkMailer, safeMailer } from "./services/mailer.js";
import { createHandlers } from "./jobs/handlers.js";
import { Worker } from "./jobs/queue.js";
import { createServices, type AppDeps } from "./app.js";

export async function bootstrap() {
  const config = loadConfig();
  const prisma = createPrisma(config.DATABASE_URL);
  const deps: AppDeps = {
    config,
    prisma,
    auth: createAuthBackend(config),
    embed: config.VOYAGE_API_KEY ? createVoyageEmbedder(config.VOYAGE_API_KEY, config.VOYAGE_MODEL) : hashEmbedder,
    answer: createGeminiAnswerer(config.GEMINI_API_KEY, config.GEMINI_MODEL),
    followUp: createGeminiFollowUp(config.GEMINI_API_KEY, config.GEMINI_MODEL),
    drive: createGoogleDrive(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET),
    mailer: config.MAIL_PROVIDER === "postmark" ? createPostmarkMailer(config.POSTMARK_SERVER_TOKEN, config.MAIL_FROM) : safeMailer(createConsoleMailer()),
  };
  const services = createServices(deps);
  const worker = new Worker(prisma, createHandlers({ ...deps, ...services }));
  return { config, prisma, deps, services, worker };
}
