// Login and permission checks.
//   requireAuth  — valid login; finds (or creates) the user. An invited person is claimed by email.
//   requireOrg   — the user belongs to an organisation (every data query then filters by req.user.orgId)
//   requireRole  — e.g. only admins can add people or delete knowledge
import type { NextFunction, Request, Response } from "express";
import type { AuthBackend } from "../auth/verifyToken.js";
import type { Db } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import type { Role, User } from "../generated/prisma/client.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
  }
}

export function requireAuth(prisma: Db, auth: AuthBackend) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!token) return res.status(401).json({ error: "Log in to continue." });
    const identity = await auth.verify(token);
    if (!identity) return res.status(401).json({ error: "Your session has expired. Log in again." });

    let user = await prisma.user.findUnique({ where: { firebaseUid: identity.uid } });
    if (!user) {
      user = await prisma.user.upsert({
        where: { email: identity.email },
        update: { firebaseUid: identity.uid },
        create: { firebaseUid: identity.uid, email: identity.email },
      });
      await audit(prisma, { user, ip: req.ip }, { action: "user.login_first", targetType: "user", targetId: user.id });
    }
    if (user.disabled) return res.status(403).json({ error: "Your access has been turned off by your company's admin." });
    req.user = user;
    next();
  };
}

export function requireOrg(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.orgId) return res.status(403).json({ error: "Create or join an organisation first." });
  next();
}

export function requireRole(prisma: Db, ...roles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      await audit(prisma, req, { action: "access.denied", meta: { path: req.originalUrl, role: req.user?.role } });
      return res.status(403).json({ error: "You don't have access to this." });
    }
    next();
  };
}
