import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

export async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Authentication required" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) return res.status(401).json({ error: "Account unavailable" });

    req.user = { id: user.id, name: user.name, email: user.email, role: user.role, storeId: user.storeId };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "SUPER_ADMIN") return res.status(403).json({ error: "Super Admin access required" });
  next();
}
