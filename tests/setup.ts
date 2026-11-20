// Test settings: separate test database, dev login, temp upload folder, test keys.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.AUTH_MODE = "dev";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://handover:handover@127.0.0.1:5432/handover_test?schema=public";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), "ho-uploads-"));
process.env.GEMINI_API_KEY = "";
process.env.VOYAGE_API_KEY = "";
process.env.GOOGLE_CLIENT_ID = "test-google";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.MAIL_PROVIDER = "console";
process.env.PUBLIC_BASE_URL = "http://localhost:3000";
