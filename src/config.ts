// Reads settings from environment variables (.env) and checks them once at startup.
import "dotenv/config";
import { z } from "zod";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3000),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    // Encrypts uploaded files on disk and Google tokens. 64 hex characters.
    ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 random bytes)"),

    GEMINI_API_KEY: z.string().default(""),
    GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
    // Embeddings ("meaning fingerprints") from Voyage AI. Without a key, a built-in keyword
    // fingerprint is used: it works, but finds related wording less well.
    VOYAGE_API_KEY: z.string().default(""),
    VOYAGE_MODEL: z.string().default("voyage-3.5"),

    AUTH_MODE: z.enum(["firebase", "dev"]).default("firebase"),
    FIREBASE_PROJECT_ID: z.string().default(""),
    FIREBASE_CLIENT_EMAIL: z.string().default(""),
    FIREBASE_PRIVATE_KEY: z.string().default(""),
    FIREBASE_WEB_API_KEY: z.string().default(""),
    FIREBASE_WEB_AUTH_DOMAIN: z.string().default(""),

    // Google Drive import (Google Cloud console → OAuth client, "Web application").
    GOOGLE_CLIENT_ID: z.string().default(""),
    GOOGLE_CLIENT_SECRET: z.string().default(""),

    MAIL_PROVIDER: z.enum(["console", "postmark"]).default("console"),
    POSTMARK_SERVER_TOKEN: z.string().default(""),
    MAIL_FROM: z.string().default("Handover <hello@handover.example>"),

    // Wording people agree to. Changing it = bump CONSENT_VERSION so people sign again.
    CONSENT_VERSION: z.string().default("2026-11-06"),
    // Answers need sources at least this close in meaning (0–1). Below it: "I don't know".
    MIN_RELEVANCE: z.coerce.number().min(0).max(1).default(0.2),
    UPLOAD_DIR: z.string().default("./uploads"),
    MAX_UPLOAD_MB: z.coerce.number().positive().max(50).default(15),
    WORKER_INLINE: z
      .string()
      .default("true")
      .transform((v) => v !== "false"),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (env.AUTH_MODE === "dev" && env.NODE_ENV === "production") issue("AUTH_MODE", "AUTH_MODE=dev is not allowed in production");
    if (env.AUTH_MODE === "firebase" && env.NODE_ENV !== "test") {
      for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const) {
        if (!env[key]) issue(key, `${key} is required when AUTH_MODE=firebase`);
      }
    }
    if (env.NODE_ENV === "production") {
      if (!env.PUBLIC_BASE_URL.startsWith("https://")) issue("PUBLIC_BASE_URL", "Must be https:// in production");
      if (!env.GEMINI_API_KEY) issue("GEMINI_API_KEY", "Required in production (interview and answers)");
      if (!env.VOYAGE_API_KEY) issue("VOYAGE_API_KEY", "Required in production for good search quality");
      if (env.MAIL_PROVIDER === "console") issue("MAIL_PROVIDER", "Use postmark in production so invitations arrive");
    }
    if (env.MAIL_PROVIDER === "postmark" && !env.POSTMARK_SERVER_TOKEN) issue("POSTMARK_SERVER_TOKEN", "Required when MAIL_PROVIDER=postmark");
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
