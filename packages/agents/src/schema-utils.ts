import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AutoParseableOutputFormat } from "@anthropic-ai/sdk/lib/parser";

/**
 * Structured outputs cannot express string/array length limits, so the API only sees them as
 * description hints. Sending the exact core schema would make the SDK throw on a 1501-character
 * brief and lose the whole response. Instead: the API gets a `lenient` twin (same shape, no length
 * checks), the result is `conform`ed (strings clipped, arrays truncated to the strict maxima) and
 * then validated against the exact core schema, which is what every stage returns.
 */

type AnyZod = z.ZodType;

function checksOf(schema: AnyZod): Array<Record<string, unknown>> {
  const def = schema.def as unknown as { checks?: Array<{ _zod: { def: Record<string, unknown> } }> };
  return (def.checks ?? []).map((c) => c._zod.def);
}

function maxLengthOf(schema: AnyZod): number | null {
  for (const c of checksOf(schema)) {
    if (c["check"] === "max_length" && typeof c["maximum"] === "number") return c["maximum"];
  }
  return null;
}

/** Same shape as `schema`, without string/array length constraints. */
export function lenient<T extends AnyZod>(schema: T): AnyZod {
  const def = schema.def as Record<string, unknown> & { type: string };
  switch (def.type) {
    case "object": {
      const shape = def["shape"] as Record<string, AnyZod>;
      return z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, lenient(v)])));
    }
    case "array":
      return z.array(lenient(def["element"] as AnyZod));
    case "nullable":
      return lenient(def["innerType"] as AnyZod).nullable();
    case "optional":
      return lenient(def["innerType"] as AnyZod).optional();
    case "default":
      return lenient(def["innerType"] as AnyZod).optional();
    case "string":
      return z.string();
    case "record":
      return z.record(z.string(), lenient(def["valueType"] as AnyZod));
    default:
      return schema;
  }
}

/** Clip strings and truncate arrays so `value` fits the maxima declared in `schema`. Pure. */
export function conform(schema: AnyZod, value: unknown): unknown {
  const def = schema.def as Record<string, unknown> & { type: string };
  switch (def.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const shape = def["shape"] as Record<string, AnyZod>;
      const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
      for (const [k, sub] of Object.entries(shape)) {
        if (k in out) out[k] = conform(sub, out[k]);
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(value)) return value;
      const max = maxLengthOf(schema);
      const items = value.map((v) => conform(def["element"] as AnyZod, v));
      return max !== null && items.length > max ? items.slice(0, max) : items;
    }
    case "nullable":
    case "optional":
    case "default":
      return value === null || value === undefined ? value : conform(def["innerType"] as AnyZod, value);
    case "string": {
      if (typeof value !== "string") return value;
      const max = maxLengthOf(schema);
      return max !== null && value.length > max ? value.slice(0, max - 1).trimEnd() + "…" : value;
    }
    case "record": {
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          conform(def["valueType"] as AnyZod, v),
        ]),
      );
    }
    default:
      return value;
  }
}

/** Output format for the API: lenient twin of the strict schema. */
export function lenientFormat<T extends AnyZod>(schema: T): AutoParseableOutputFormat<z.infer<T>> {
  return zodOutputFormat(lenient(schema)) as AutoParseableOutputFormat<z.infer<T>>;
}

/** Conform then validate against the exact schema. Throws ZodError on real violations. */
export function finalize<T extends AnyZod>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(conform(schema, value)) as z.infer<T>;
}
