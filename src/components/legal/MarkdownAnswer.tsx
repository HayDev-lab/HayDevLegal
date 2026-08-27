"use client";

import { useMemo } from "react";
import type { CitationRef, LegalSource } from "@/lib/legal/types";

/**
 * Lightweight Armenian-aware markdown renderer for the AI legal answer.
 *
 * Supports:
 *  - # / ## / ### headings
 *  - - or * or • bullet lists
 *  - 1. 2. numbered lists
 *  - **bold** and *italic*
 *  - `inline code`
 *  - > blockquote
 *  - [Sn] inline citations (rendered as superscript links)
 *
 * We deliberately do NOT use a full markdown library to keep the bundle
 * small and to have full control over citation rendering + XSS safety
 * (we never inject raw HTML from the model).
 */

type Block =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "bullet"; items: string[] }
  | { type: "numbered"; items: string[] }
  | { type: "blockquote"; text: string }
  | { type: "spacer" };

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines (but track as spacer if between content)
    if (!trimmed) {
      i++;
      continue;
    }

    // Headings
    const h1 = trimmed.match(/^#{1}\s+(.*)/);
    const h2 = trimmed.match(/^#{2}\s+(.*)/);
    const h3 = trimmed.match(/^#{3,}\s+(.*)/);
    if (h3) {
      blocks.push({ type: "heading", level: 3, text: h3[1] });
      i++;
      continue;
    }
    if (h2) {
      blocks.push({ type: "heading", level: 2, text: h2[1] });
      i++;
      continue;
    }
    if (h1) {
      blocks.push({ type: "heading", level: 1, text: h1[1] });
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      blocks.push({ type: "blockquote", text: trimmed.slice(2) });
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*•]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i++;
      }
      blocks.push({ type: "bullet", items });
      continue;
    }

    // Numbered list
    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ type: "numbered", items });
      continue;
    }

    // Paragraph (may span multiple lines until blank line or block boundary)
    const paraLines: string[] = [trimmed];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,3}\s/.test(lines[i].trim()) &&
      !/^[-*•]\s/.test(lines[i].trim()) &&
      !/^\d+[.)]\s/.test(lines[i].trim()) &&
      !/^>\s/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: paraLines.join(" ") });
  }
  return blocks;
}

/** Escape all HTML-special characters. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type InlineSegment =
  | { type: "text"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "code"; value: string }
  | { type: "cite"; id: string };

/** Parse inline markdown: **bold**, *italic*, `code`, [Sn] citations. */
function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  // Tokenize: **...** | *...* | `...` | [S\d+]
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[S(\d+)\])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: "text", value: text.slice(last, m.index) });
    }
    if (m[2] !== undefined) {
      segments.push({ type: "bold", value: m[2] });
    } else if (m[3] !== undefined) {
      segments.push({ type: "italic", value: m[3] });
    } else if (m[4] !== undefined) {
      segments.push({ type: "code", value: m[4] });
    } else if (m[5] !== undefined) {
      segments.push({ type: "cite", id: `S${m[5]}` });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "text", value: text.slice(last) });
  }
  return segments;
}

function renderInline(
  segments: InlineSegment[],
  byId: Map<string, LegalSource>,
): React.ReactNode[] {
  return segments.map((seg, i) => {
    switch (seg.type) {
      case "text":
        return <span key={i}>{seg.value}</span>;
      case "bold":
        return (
          <strong key={i} className="font-semibold text-foreground">
            {seg.value}
          </strong>
        );
      case "italic":
        return (
          <em key={i} className="italic">
            {seg.value}
          </em>
        );
      case "code":
        return (
          <code key={i} className="rounded bg-muted px-1.5 py-0.5 text-[13px] font-mono">
            {seg.value}
          </code>
        );
      case "cite": {
        const src = byId.get(seg.id);
        if (!src || !src.canonicalUrl) {
          return (
            <span key={i} className="text-muted-foreground/50">
              [{seg.id}]
            </span>
          );
        }
        return (
          <a
            key={i}
            href={src.canonicalUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={src.title}
            className="mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary px-1 align-super text-[10px] font-bold leading-none text-primary-foreground no-underline hover:opacity-80 transition-opacity"
          >
            {seg.id}
          </a>
        );
      }
      default:
        return null;
    }
  });
}

export function MarkdownAnswer({
  text,
  citations,
  sources,
}: {
  text: string;
  citations: CitationRef[];
  sources: LegalSource[];
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  // Build a lookup of all known sources (from sources + citations).
  const byId = useMemo(() => {
    const m = new Map<string, LegalSource>();
    for (const s of sources) m.set(s.id, s);
    for (const c of citations) {
      if (!m.has(c.id)) {
        m.set(c.id, {
          id: c.id,
          source: "ARLIS",
          title: c.title,
          canonicalUrl: c.url,
          excerpt: "",
          retrievedAt: "",
          relevanceScore: 0,
        });
      }
    }
    return m;
  }, [sources, citations]);

  return (
    <div className="prose-legal max-w-none text-foreground">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "heading": {
            const Tag = (`h${block.level}` as "h1" | "h2" | "h3");
            return (
              <Tag key={i}>
                {renderInline(parseInline(block.text), byId)}
              </Tag>
            );
          }
          case "paragraph":
            return (
              <p key={i}>
                {renderInline(parseInline(block.text), byId)}
              </p>
            );
          case "bullet":
            return (
              <ul key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(parseInline(item), byId)}</li>
                ))}
              </ul>
            );
          case "numbered":
            return (
              <ol key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(parseInline(item), byId)}</li>
                ))}
              </ol>
            );
          case "blockquote":
            return (
              <blockquote key={i}>
                {renderInline(parseInline(block.text), byId)}
              </blockquote>
            );
          case "spacer":
            return <div key={i} className="h-2" />;
          default:
            return null;
        }
      })}
    </div>
  );
}
