// Background worker on its own (npm run worker): reads documents, makes embeddings, sends email.
import { bootstrap } from "./bootstrap.js";

const { prisma, worker } = await bootstrap();
worker.start(1000);
console.log("Handover worker started");

const shutdown = async () => {
  worker.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
