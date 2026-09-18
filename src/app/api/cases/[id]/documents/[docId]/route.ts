// src/app/api/cases/[id]/documents/[docId]/route.ts
// Phase 5 §17 — Document detail + pages.

import { NextRequest, NextResponse } from "next/server";
import { getDocument, getDocumentPages } from "@/lib/case-workspace/documents/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; docId: string }> },
) {
  try {
    const { id, docId } = await ctx.params;
    const doc = await getDocument(docId);
    if (!doc || doc.caseId !== id) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // §19 — prevent cross-case leakage: the doc must belong to the route's caseId.
    const url = new URL(req.url);
    const withPages = url.searchParams.get("pages") === "1";
    const pages = withPages ? await getDocumentPages(docId) : [];
    return NextResponse.json({ document: doc, pages });
  } catch (err) {
    return NextResponse.json(
      { error: "failed to get document", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
