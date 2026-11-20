// Signed, expiring values (used for the Google OAuth "state", so it can't be forged or replayed).
import { createHmac, timingSafeEqual } from "node:crypto";

/** Sign a value with an expiry time. */
export function sign(value: string, secret: string, ttlSeconds: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ v: value, exp })).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySigned(token: string, secret: string, now = Date.now()): string | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { v, exp } = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof v !== "string" || typeof exp !== "number" || exp * 1000 < now) return null;
    return v;
  } catch {
    return null;
  }
}
