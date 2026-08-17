// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Time normalization.
 *
 * Timezone mistakes destroy investigations. Carrier returns arrive in local
 * time, UTC, GMT-with-a-note-in-the-cover-letter, and occasionally in a zone
 * that is simply not stated anywhere. Some carriers change format between
 * productions.
 *
 * Rules enforced here:
 *   1. The original timestamp text is preserved verbatim, always.
 *   2. The normalized UTC value records HOW it was converted and from WHAT zone.
 *   3. A zone that was assumed rather than stated is flagged as assumed.
 *   4. Local times that fall in a DST gap or repeat are flagged, never guessed
 *      silently.
 *   5. Nothing is ever "corrected" — problems are surfaced to the analyst.
 */

import { DateTime, IANAZone, FixedOffsetZone } from 'luxon';

export const TIME_CONVERSION_METHODS = [
  /** Timestamp text itself carried an explicit offset, e.g. 2024-03-15T22:31:42-05:00. */
  'SOURCE_EXPLICIT_OFFSET',
  /** Timestamp text carried a zone abbreviation or the row had a zone column. */
  'SOURCE_DECLARED_ZONE',
  /** Zone declared for the evidence package by the analyst, from the cover letter. */
  'PACKAGE_DECLARED_ZONE',
  /** Parser's documented default for this carrier and record type. */
  'CARRIER_DOCUMENTED_DEFAULT',
  /** Value was already UTC by format (epoch, trailing Z). */
  'NATIVE_UTC',
  /** Nothing indicated a zone; UTC assumed as a last resort. */
  'ASSUMED_UTC',
  /** Could not be converted at all. */
  'UNRESOLVED',
] as const;
export type TimeConversionMethod = (typeof TIME_CONVERSION_METHODS)[number];

export const TIME_CONFIDENCE = [
  /** Offset was unambiguous in the source. */
  'EXACT',
  /** Zone was stated by the carrier or declared by the analyst; conversion unambiguous. */
  'ZONE_DECLARED',
  /** Zone was assumed by parser default or fallback. */
  'ZONE_ASSUMED',
  /** Local time occurs twice on this date (DST fall-back). Two UTC values are possible. */
  'DST_AMBIGUOUS',
  /** Local time does not exist on this date (DST spring-forward gap). */
  'DST_NONEXISTENT',
  /** Could not parse or convert. */
  'UNRESOLVED',
] as const;
export type TimeConfidence = (typeof TIME_CONFIDENCE)[number];

export interface NormalizedTimestamp {
  /** Exactly as it appeared in the source. Never altered. */
  readonly original: string;
  /** ISO 8601 UTC, or undefined when unresolved. */
  readonly utc?: string;
  /** Epoch milliseconds, for the analytical store. */
  readonly epochMs?: number;
  /** IANA zone name, fixed offset ('UTC-05:00'), or 'UNKNOWN'. */
  readonly sourceZone: string;
  readonly method: TimeConversionMethod;
  readonly confidence: TimeConfidence;
  /** The format pattern that matched, recorded so parsing is auditable. */
  readonly matchedFormat?: string;
  /**
   * For DST_AMBIGUOUS: both possible UTC interpretations. The system does not
   * choose between them; the analyst is shown both.
   */
  readonly alternatives?: readonly string[];
  /** Human-readable problem statement when confidence is not EXACT/ZONE_DECLARED. */
  readonly warning?: string;
}

export interface TimeParseContext {
  /** Zone the analyst declared for this evidence package, from the cover letter. */
  readonly packageZone?: string;
  /** Parser's documented default zone for this carrier/record type. */
  readonly carrierDefaultZone?: string;
  /** Zone taken from a per-row column, when the format has one. */
  readonly rowZone?: string;
  /** Prefer DD/MM over MM/DD for ambiguous numeric dates (non-US productions). */
  readonly dayFirst?: boolean;
}

/** Ordered candidate formats. First match wins; the winner is recorded. */
const FORMATS: readonly { pattern: string; luxon: string; hasOffset?: boolean; hasZone?: boolean }[] = [
  { pattern: 'ISO-8601 with offset', luxon: "yyyy-MM-dd'T'HH:mm:ss.SSSZZ", hasOffset: true },
  { pattern: 'ISO-8601 with offset', luxon: "yyyy-MM-dd'T'HH:mm:ssZZ", hasOffset: true },
  { pattern: 'ISO-8601 space with offset', luxon: 'yyyy-MM-dd HH:mm:ssZZ', hasOffset: true },
  { pattern: 'ISO-8601 fractional', luxon: "yyyy-MM-dd'T'HH:mm:ss.SSS" },
  { pattern: 'ISO-8601 basic', luxon: "yyyy-MM-dd'T'HH:mm:ss" },
  { pattern: 'SQL datetime', luxon: 'yyyy-MM-dd HH:mm:ss.SSS' },
  { pattern: 'SQL datetime', luxon: 'yyyy-MM-dd HH:mm:ss' },
  { pattern: 'SQL datetime, minute precision', luxon: 'yyyy-MM-dd HH:mm' },
  { pattern: 'US 12-hour', luxon: 'MM/dd/yyyy hh:mm:ss a' },
  { pattern: 'US 12-hour, minute precision', luxon: 'MM/dd/yyyy hh:mm a' },
  { pattern: 'US 24-hour', luxon: 'MM/dd/yyyy HH:mm:ss' },
  { pattern: 'US 24-hour, minute precision', luxon: 'MM/dd/yyyy HH:mm' },
  { pattern: 'US 2-digit year 12-hour', luxon: 'MM/dd/yy hh:mm:ss a' },
  { pattern: 'US 2-digit year 24-hour', luxon: 'MM/dd/yy HH:mm:ss' },
  { pattern: 'Oracle default', luxon: 'dd-MMM-yy hh.mm.ss.SSS a' },
  { pattern: 'Oracle default', luxon: 'dd-MMM-yy hh.mm.ss a' },
  { pattern: 'Oracle 24-hour', luxon: 'dd-MMM-yy HH.mm.ss.SSS' },
  { pattern: 'Oracle 24-hour', luxon: 'dd-MMM-yy HH.mm.ss' },
  { pattern: 'Oracle 4-digit year', luxon: 'dd-MMM-yyyy HH:mm:ss' },
  { pattern: 'Compact numeric', luxon: 'yyyyMMddHHmmss' },
  { pattern: 'Compact numeric with millis', luxon: 'yyyyMMddHHmmssSSS' },
  { pattern: 'Dotted European', luxon: 'dd.MM.yyyy HH:mm:ss' },
  { pattern: 'Dashed US', luxon: 'MM-dd-yyyy HH:mm:ss' },
];

const DAY_FIRST_FORMATS: readonly { pattern: string; luxon: string; hasOffset?: boolean }[] = [
  { pattern: 'Day-first 24-hour', luxon: 'dd/MM/yyyy HH:mm:ss' },
  { pattern: 'Day-first 12-hour', luxon: 'dd/MM/yyyy hh:mm:ss a' },
  { pattern: 'Day-first minute precision', luxon: 'dd/MM/yyyy HH:mm' },
];

/** Zone abbreviations carriers actually emit, mapped to IANA zones. */
const ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  UTC: 'UTC',
  GMT: 'UTC',
  Z: 'UTC',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  ET: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  CT: 'America/Chicago',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  MT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  PT: 'America/Los_Angeles',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  AST: 'America/Puerto_Rico',
};

const UNRESOLVED = (original: string, warning: string): NormalizedTimestamp => ({
  original,
  sourceZone: 'UNKNOWN',
  method: 'UNRESOLVED',
  confidence: 'UNRESOLVED',
  warning,
});

/**
 * Normalize a carrier timestamp to UTC while preserving everything needed to
 * defend or re-examine the conversion.
 */
export function normalizeTimestamp(
  raw: string | number | null | undefined,
  ctx: TimeParseContext = {},
): NormalizedTimestamp {
  if (raw === null || raw === undefined) {
    return UNRESOLVED('', 'Timestamp was absent from the source record.');
  }

  const original = String(raw).trim();
  if (!original) return UNRESOLVED(String(raw ?? ''), 'Timestamp field was empty in the source record.');

  // Epoch values arrive as bare integers. Treat 10-digit as seconds and
  // 13-digit as milliseconds; anything else is not confidently an epoch.
  if (/^\d{10}$/.test(original) || /^\d{13}$/.test(original)) {
    const isSeconds = original.length === 10;
    const ms = isSeconds ? Number(original) * 1000 : Number(original);
    const dt = DateTime.fromMillis(ms, { zone: 'UTC' });
    if (dt.isValid) {
      return {
        original,
        utc: dt.toISO({ suppressMilliseconds: false }) ?? undefined,
        epochMs: ms,
        sourceZone: 'UTC',
        method: 'NATIVE_UTC',
        confidence: 'EXACT',
        matchedFormat: isSeconds ? 'Unix epoch seconds' : 'Unix epoch milliseconds',
      };
    }
  }

  // Strip and capture a trailing zone abbreviation, e.g. "2024-03-15 22:31:42 CST".
  let text = original;
  let declaredZoneFromText: string | undefined;

  // Database exports routinely carry microsecond or nanosecond precision that no
  // cellular record actually measures. Truncate to milliseconds for parsing —
  // `original` keeps the full text, so nothing is lost from the evidence.
  let truncatedSubsecond = false;
  const subsecond = text.replace(/([.,]\d{3})\d+(?=\D|$)/, (_m, keep: string) => {
    truncatedSubsecond = true;
    return keep;
  });
  if (truncatedSubsecond) text = subsecond;
  const abbrevMatch = text.match(/\s+\(?([A-Z]{1,4})\)?$/);
  if (abbrevMatch?.[1] && ZONE_ABBREVIATIONS[abbrevMatch[1]]) {
    declaredZoneFromText = ZONE_ABBREVIATIONS[abbrevMatch[1]];
    text = text.slice(0, abbrevMatch.index).trim();
  }
  // Trailing Z means UTC.
  let nativeUtc = false;
  if (/(\d)[Zz]$/.test(text)) {
    text = text.replace(/[Zz]$/, '');
    nativeUtc = true;
  }

  const candidates = ctx.dayFirst ? [...DAY_FIRST_FORMATS, ...FORMATS] : [...FORMATS, ...DAY_FIRST_FORMATS];

  // Resolve which zone the local time should be interpreted in, and how we know.
  const resolution = resolveZone(ctx, declaredZoneFromText, nativeUtc);

  for (const fmt of candidates) {
    const withOffset = fmt.hasOffset === true;
    const attempt = DateTime.fromFormat(text, fmt.luxon, {
      zone: withOffset ? undefined : resolution.zone,
      setZone: withOffset,
    });
    if (!attempt.isValid) continue;

    if (withOffset) {
      const offsetZone = attempt.zone.name;
      return {
        original,
        utc: attempt.toUTC().toISO() ?? undefined,
        epochMs: attempt.toMillis(),
        sourceZone: offsetZone,
        method: 'SOURCE_EXPLICIT_OFFSET',
        confidence: 'EXACT',
        matchedFormat: fmt.pattern,
      };
    }

    // Local time interpreted in a zone — check for DST hazards before trusting it.
    const dst = checkDstHazard(text, fmt.luxon, resolution.zone);
    if (dst.kind === 'AMBIGUOUS') {
      return {
        original,
        utc: attempt.toUTC().toISO() ?? undefined,
        epochMs: attempt.toMillis(),
        sourceZone: resolution.zone,
        method: resolution.method,
        confidence: 'DST_AMBIGUOUS',
        matchedFormat: fmt.pattern,
        alternatives: dst.alternatives,
        warning:
          `This local time occurs twice in ${resolution.zone} on this date because of the ` +
          `daylight-saving transition. Both interpretations are shown; the system has not chosen ` +
          `between them.`,
      };
    }
    if (dst.kind === 'NONEXISTENT') {
      return {
        original,
        utc: attempt.toUTC().toISO() ?? undefined,
        epochMs: attempt.toMillis(),
        sourceZone: resolution.zone,
        method: resolution.method,
        confidence: 'DST_NONEXISTENT',
        matchedFormat: fmt.pattern,
        warning:
          `This local time does not exist in ${resolution.zone} on this date — the clock skipped ` +
          `it at the daylight-saving transition. The source zone declaration may be wrong.`,
      };
    }

    return {
      original,
      utc: attempt.toUTC().toISO() ?? undefined,
      epochMs: attempt.toMillis(),
      sourceZone: resolution.zone,
      method: resolution.method,
      confidence: resolution.confidence,
      matchedFormat: fmt.pattern,
      ...(resolution.warning ? { warning: resolution.warning } : {}),
    };
  }

  // Last resort: Luxon's own ISO/RFC2822/HTTP parsers.
  for (const [label, parse] of [
    ['ISO-8601 (permissive)', () => DateTime.fromISO(original, { setZone: true })],
    ['RFC 2822', () => DateTime.fromRFC2822(original, { setZone: true })],
    ['HTTP date', () => DateTime.fromHTTP(original, { setZone: true })],
  ] as const) {
    const dt = parse();
    if (dt.isValid) {
      const carriedZone = /[+-]\d{2}:?\d{2}$|[Zz]$|GMT|UTC/.test(original);
      return {
        original,
        utc: dt.toUTC().toISO() ?? undefined,
        epochMs: dt.toMillis(),
        sourceZone: carriedZone ? dt.zone.name : resolution.zone,
        method: carriedZone ? 'SOURCE_EXPLICIT_OFFSET' : resolution.method,
        confidence: carriedZone ? 'EXACT' : resolution.confidence,
        matchedFormat: label,
        ...(carriedZone ? {} : resolution.warning ? { warning: resolution.warning } : {}),
      };
    }
  }

  return UNRESOLVED(
    original,
    `Timestamp "${original}" did not match any known carrier format. It has been retained ` +
      `verbatim and excluded from time-based analysis until an analyst maps its format.`,
  );
}

interface ZoneResolution {
  zone: string;
  method: TimeConversionMethod;
  confidence: TimeConfidence;
  warning?: string;
}

function resolveZone(
  ctx: TimeParseContext,
  declaredZoneFromText: string | undefined,
  nativeUtc: boolean,
): ZoneResolution {
  if (nativeUtc) {
    return { zone: 'UTC', method: 'NATIVE_UTC', confidence: 'EXACT' };
  }
  if (declaredZoneFromText) {
    return { zone: declaredZoneFromText, method: 'SOURCE_DECLARED_ZONE', confidence: 'ZONE_DECLARED' };
  }
  if (ctx.rowZone) {
    const zone = canonicalZone(ctx.rowZone);
    if (zone) return { zone, method: 'SOURCE_DECLARED_ZONE', confidence: 'ZONE_DECLARED' };
  }
  if (ctx.packageZone) {
    const zone = canonicalZone(ctx.packageZone);
    if (zone) return { zone, method: 'PACKAGE_DECLARED_ZONE', confidence: 'ZONE_DECLARED' };
  }
  if (ctx.carrierDefaultZone) {
    const zone = canonicalZone(ctx.carrierDefaultZone);
    if (zone) {
      return {
        zone,
        method: 'CARRIER_DOCUMENTED_DEFAULT',
        confidence: 'ZONE_ASSUMED',
        warning:
          `No timezone was stated in the record. The parser's documented default for this ` +
          `carrier (${zone}) was applied. Confirm against the production cover letter.`,
      };
    }
  }
  return {
    zone: 'UTC',
    method: 'ASSUMED_UTC',
    confidence: 'ZONE_ASSUMED',
    warning:
      'No timezone was stated anywhere in the record, the package, or the parser defaults. ' +
      'UTC was assumed. Declare the production timezone before relying on time-based analysis.',
  };
}

/** Accepts IANA names, abbreviations, and fixed offsets like "UTC-5" or "-05:00". */
export function canonicalZone(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  const upper = trimmed.toUpperCase();
  if (ZONE_ABBREVIATIONS[upper]) return ZONE_ABBREVIATIONS[upper];

  // Offsets must be resolved before the IANA check: recent Node/ICU accepts
  // offset strings like "-05:00" as valid time zone identifiers, which would
  // otherwise pass them through in an inconsistent notation.
  const offsetMatch = upper.match(/^(?:UTC|GMT)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (offsetMatch) {
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    const hours = Number.parseInt(offsetMatch[2] ?? '0', 10);
    const minutes = Number.parseInt(offsetMatch[3] ?? '0', 10);
    return FixedOffsetZone.instance(sign * (hours * 60 + minutes)).name;
  }

  if (IANAZone.isValidZone(trimmed)) return trimmed;
  return undefined;
}

type DstHazard =
  | { kind: 'NONE' }
  | { kind: 'AMBIGUOUS'; alternatives: string[] }
  | { kind: 'NONEXISTENT' };

/**
 * Detect DST hazards for a local wall-clock time.
 *
 * Luxon silently resolves both cases; we detect them by round-tripping. If
 * formatting the parsed value back yields different text, the wall-clock time
 * did not exist. If shifting by the zone's DST delta produces the same local
 * text, the wall-clock time occurred twice.
 */
function checkDstHazard(text: string, luxonFormat: string, zone: string): DstHazard {
  const dt = DateTime.fromFormat(text, luxonFormat, { zone });
  if (!dt.isValid) return { kind: 'NONE' };

  // Formats without a date component or without hours cannot exhibit the hazard.
  if (!luxonFormat.includes('H') && !luxonFormat.includes('h')) return { kind: 'NONE' };

  const roundTrip = dt.toFormat(luxonFormat);
  if (roundTrip !== text) {
    // Luxon shifted the value forward: the requested wall-clock time is in a gap.
    return { kind: 'NONEXISTENT' };
  }

  // Fall-back detection: the hour before and the hour after have differing
  // offsets, and the same local text maps to two distinct instants.
  const earlier = dt.minus({ hours: 1 });
  const later = dt.plus({ hours: 1 });
  if (earlier.offset !== dt.offset || dt.offset !== later.offset) {
    const offsetDeltaMinutes = earlier.offset - later.offset;
    if (offsetDeltaMinutes > 0) {
      // Clocks went back somewhere in this window. Check whether this exact
      // local time is repeated by testing the alternate offset.
      const alternate = dt.setZone(FixedOffsetZone.instance(earlier.offset), {
        keepLocalTime: true,
      });
      const primary = dt.setZone(FixedOffsetZone.instance(later.offset), { keepLocalTime: true });
      if (alternate.toMillis() !== primary.toMillis()) {
        const a = alternate.toUTC().toISO();
        const b = primary.toUTC().toISO();
        if (a && b) return { kind: 'AMBIGUOUS', alternatives: [a, b] };
      }
    }
  }

  return { kind: 'NONE' };
}

/** Render a UTC instant in a display zone, for the UI and reports. */
export function displayInZone(utcIso: string, zone: string, format = 'yyyy-MM-dd HH:mm:ss ZZZZ'): string {
  const dt = DateTime.fromISO(utcIso, { zone: 'UTC' }).setZone(zone);
  return dt.isValid ? dt.toFormat(format) : utcIso;
}

/** Inclusive time window. */
export interface TimeWindow {
  readonly startUtc: string;
  readonly endUtc: string;
  readonly label?: string;
}

export function windowContains(window: TimeWindow, utcIso: string): boolean {
  return utcIso >= window.startUtc && utcIso <= window.endUtc;
}

export function windowDurationMs(window: TimeWindow): number {
  return Date.parse(window.endUtc) - Date.parse(window.startUtc);
}

export function makeWindow(startUtc: string, endUtc: string, label?: string): TimeWindow {
  if (Date.parse(startUtc) > Date.parse(endUtc)) {
    throw new Error(`Time window start ${startUtc} is after its end ${endUtc}`);
  }
  return { startUtc, endUtc, ...(label ? { label } : {}) };
}

/** Expand an incident instant into a relevant analysis window. */
export function windowAround(
  instantUtc: string,
  beforeMinutes: number,
  afterMinutes: number,
  label?: string,
): TimeWindow {
  const t = Date.parse(instantUtc);
  return makeWindow(
    new Date(t - beforeMinutes * 60_000).toISOString(),
    new Date(t + afterMinutes * 60_000).toISOString(),
    label,
  );
}
