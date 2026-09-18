// src/app/api/cases/[id]/drafts/[draftId]/export/route.ts
// Phase 6 §28, §29 — Export draft (DOCX/PDF/TXT).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/case-workspace/db";
import { exportDraft } from "@/lib/legal-drafting/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; draftId: string }> },
) {
  const { id, draftId } = await ctx.params;
  try {
    const draft = await db.legalDraft.findUnique({ where: { id: draftId } });
    if (!draft || draft.caseId !== id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const format = (url.searchParams.get("format") ?? "txt") as "docx" | "pdf" | "txt";

    // §28 — PDF only from reviewed/verified state
    if (format === "pdf" && draft.status !== "VERIFIED" && draft.status !== "EXPORT_READY") {
      return NextResponse.json(
        { error: "PDF export requires VERIFIED or EXPORT_READY status" },
        { status: 400 },
      );
    }

    const version = await db.draftVersion.findFirst({
      where: { draftId },
      orderBy: { version: "desc" },
    });
    if (!version) {
      return NextResponse.json({ error: "no version found" }, { status: 400 });
    }

    const exported = await exportDraft(draftId, version.id, format);

    // §30 — Sanitize export filename (no path traversal)
    const safeTitle = (draft.title.replace(/[^a-zA-Z0-9\-_ ]/g, "").trim() || "draft").slice(0, 100);

    if (format === "txt") {
      return new NextResponse(exported as string, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": `attachment; filename="${safeTitle}.txt"`,
        },
      });
    }

    // DOCX / PDF — return binary
    const bytes = exported as Uint8Array;
    const buffer = Buffer.from(bytes);
    const contentType = format === "docx"
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : "application/pdf";

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${safeTitle}.${format}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to export", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
