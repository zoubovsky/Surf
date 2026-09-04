import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { TranscriptSegment } from "./types.js";

/**
 * Parsers for YouTube caption payloads: the `json3` format (used by the timedtext endpoint
 * with `&fmt=json3` and by yt-dlp `--sub-format json3`) and the legacy `<transcript><text>` XML.
 */

const Json3 = z.object({
  events: z
    .array(
      z
        .object({
          tStartMs: z.number().optional(),
          dDurationMs: z.number().optional(),
          segs: z.array(z.object({ utf8: z.string().optional() }).passthrough()).optional(),
        })
        .passthrough(),
    )
    .default([]),
});

export function parseJson3(body: string | unknown): TranscriptSegment[] {
  const raw = typeof body === "string" ? JSON.parse(body) : body;
  const parsed = Json3.safeParse(raw);
  if (!parsed.success) throw new Error("timedtext: not a json3 caption document");
  const out: TranscriptSegment[] = [];
  for (const ev of parsed.data.events) {
    if (!ev.segs || ev.tStartMs === undefined) continue;
    const text = ev.segs
      .map((s) => s.utf8 ?? "")
      .join("")
      .replace(/\n/g, " ")
      .trim();
    if (!text) continue;
    out.push({ start: ev.tStartMs / 1000, duration: (ev.dDurationMs ?? 0) / 1000, text });
  }
  return out;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, jpath) => jpath === "transcript.text" || jpath === "timedtext.body.p",
  // Some tracks wrap words in <s> tags (srv3); flatten them.
  stopNodes: ["transcript.text", "timedtext.body.p"],
});

const XmlCue = z
  .object({
    "@_start": z.string().optional(),
    "@_t": z.string().optional(),
    "@_dur": z.string().optional(),
    "@_d": z.string().optional(),
    "#text": z.string().optional(),
  })
  .passthrough();
const XmlDoc = z.object({
  transcript: z
    .object({ text: z.array(XmlCue).optional() })
    .passthrough()
    .optional(),
  timedtext: z
    .object({
      body: z
        .object({ p: z.array(XmlCue).optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

export function parseTimedTextXml(body: string): TranscriptSegment[] {
  const parsed = XmlDoc.safeParse(xmlParser.parse(body));
  if (!parsed.success) throw new Error("timedtext: not a caption XML document");
  const legacy = parsed.data.transcript?.text;
  if (legacy) {
    return legacy.flatMap((c) => {
      const start = Number(c["@_start"]);
      const text = stripTags(c["#text"] ?? "").trim();
      return Number.isFinite(start) && text ? [{ start, duration: Number(c["@_dur"] ?? 0) || 0, text }] : [];
    });
  }
  const srv3 = parsed.data.timedtext?.body?.p;
  if (srv3) {
    return srv3.flatMap((c) => {
      const startMs = Number(c["@_t"]);
      const text = stripTags(c["#text"] ?? "").trim();
      return Number.isFinite(startMs) && text
        ? [{ start: startMs / 1000, duration: (Number(c["@_d"] ?? 0) || 0) / 1000, text }]
        : [];
    });
  }
  return [];
}

/** Detect format and parse. */
export function parseTimedText(body: string): TranscriptSegment[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) return parseJson3(trimmed);
  if (trimmed.startsWith("<")) return parseTimedTextXml(trimmed);
  throw new Error("timedtext: unrecognised caption payload");
}
