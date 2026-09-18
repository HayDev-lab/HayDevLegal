// src/lib/case-workspace/volumes/service.ts
// Phase 5 — CaseVolume CRUD service.
//
// A volume is an ordered container within a case (e.g. "Volume 1:
// Indictment", "Volume 2: Search/Seizure protocols"). Documents may live
// without a volume (volumeId = null).
//
// Per the Prisma schema, deleting a volume sets documents.volumeId = null
// (onDelete: SetNull). Documents keep their caseId — they are NOT deleted.

import { db } from "../db";
import type {
  CaseVolume,
  CreateVolumeInput,
  UpdateVolumeInput,
} from "../types";

// ---------------------------------------------------------------------------
// Row → parsed interface mapper
// ---------------------------------------------------------------------------

type VolumeRow = Awaited<ReturnType<typeof db.caseVolume.findFirst>>;

function mapVolume(row: NonNullable<VolumeRow>): CaseVolume {
  return {
    id: row.id,
    caseId: row.caseId,
    number: row.number,
    title: row.title,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public CRUD
// ---------------------------------------------------------------------------

export async function createVolume(
  caseId: string,
  input: CreateVolumeInput,
): Promise<CaseVolume> {
  // If no order supplied, place at the end of the case's current list.
  let order = input.order;
  if (order === undefined) {
    const last = await db.caseVolume.findFirst({
      where: { caseId },
      orderBy: { order: "desc" },
      select: { order: true },
    });
    order = (last?.order ?? -1) + 1;
  }
  const row = await db.caseVolume.create({
    data: {
      caseId,
      number: input.number ?? null,
      title: input.title,
      order,
    },
  });
  return mapVolume(row);
}

export async function listVolumes(caseId: string): Promise<CaseVolume[]> {
  const rows = await db.caseVolume.findMany({
    where: { caseId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(mapVolume);
}

export async function updateVolume(
  id: string,
  patch: UpdateVolumeInput,
): Promise<CaseVolume> {
  const data: Record<string, unknown> = {};
  if (patch.number !== undefined) data.number = patch.number;
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.order !== undefined) data.order = patch.order;
  const row = await db.caseVolume.update({ where: { id }, data });
  return mapVolume(row);
}

/**
 * Delete a volume. Per the Prisma schema (onDelete: SetNull), documents
 * keep their caseId but their volumeId is set to null. Documents are NOT
 * deleted.
 */
export async function deleteVolume(id: string): Promise<void> {
  await db.caseVolume.delete({ where: { id } });
}

/**
 * Reorder volumes within a case. The `orderedIds` array gives the new
 * order; each volume's `order` field is set to its index in the array.
 * Volumes not in the array are left untouched (they keep their old order
 * — which may collide; caller should pass the full list).
 */
export async function reorderVolumes(
  caseId: string,
  orderedIds: string[],
): Promise<void> {
  await db.$transaction(
    orderedIds.map((id, index) =>
      db.caseVolume.update({
        where: { id, caseId },
        data: { order: index },
      }),
    ),
  );
}
