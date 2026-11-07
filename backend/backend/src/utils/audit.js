import { prisma } from "../db.js";

export async function audit({ actorId, action, entityType, entityId, before = undefined, after = undefined, documentId = undefined }) {
  return prisma.auditLog.create({
    data: { actorId, action, entityType, entityId, before, after, documentId }
  });
}
