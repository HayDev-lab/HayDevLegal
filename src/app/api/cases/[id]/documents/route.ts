// src/app/api/cases/[id]/documents/route.ts
// Phase 5 §6, §17 — Document upload (multipart) + list.

import { NextRequest, NextResponse } from "next/server";
import { ingestDocument } from "@/lib/case-workspace/documents/ingestion";
import { listDocuments } from "@/lib/case-workspace/documents/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// §6 — upload is multipart/form-data. Each file becomes its own CaseDocument.
// Supports multiple files in one request (per §7 incremental/resumable batch).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const formData = await req.formData();
    const volumeIdRaw = formData.get("volumeId");
    const volumeId = typeof volumeIdRaw === "string" && volumeIdRaw.length > 0 ? volumeIdRaw : null;
    const files = formData.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: "no files provided" }, { status: 400 });
    }
    const results: Array<{ filename: string; documentId: string; status: string; duplicate: boolean; pageCount: number; requiresOcr: boolean; errorDetail?: string }> = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await ingestDocument(id, volumeId, file.name, file.type || "application/octet-stream", bytes);
      results.push({ filename: file.name, ...result });
    }
    return NextResponse.json({ results }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to upload", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const url = new URL(req.url);
    const volumeId = url.searchParams.get("volumeId") ?? undefined;
    const processingStatus = (url.searchParams.get("status") ?? undefined) as
      | import("@/lib/case-workspace/types").ProcessingStatus
      | undefined;
    const documentType = (url.searchParams.get("documentType") ?? undefined) as
      | import("@/lib/case-workspace/types").DocumentType
      | undefined;
    const documents = await listDocuments(id, { volumeId, processingStatus, documentType });
    return NextResponse.json({ documents });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to list documents", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
