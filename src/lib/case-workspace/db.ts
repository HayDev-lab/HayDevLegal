// src/lib/case-workspace/db.ts
// Re-export the shared Prisma client (single source of truth at @/lib/db).
// The case-workspace services import from this module so they remain
// decoupled from the global client path.

export { db } from "@/lib/db";
