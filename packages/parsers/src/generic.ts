// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unknown-format handling.
 *
 * When no carrier parser matches, the system does NOT guess. It profiles every
 * column and proposes a mapping, which an analyst must approve before any
 * evidence is incorporated. The proposal carries a per-column confidence and
 * the reasoning behind it, so approving it is an informed act rather than
 * clicking through a wizard.
 *
 * This is the controlled mapping workflow: suggestions are cheap, silent
 * acceptance is not allowed.
 */

import { inferIdentifierType, normalizeTimestamp, isNullToken, type IdentifierType } from '@cmurk/cellular-schema';
import { readTabular, type TabularDocument } from './tabular';
import type { FieldMap, ParserDefinition, SourceField } from './types';

export type CanonicalField =
  | 'timestamp'
  | 'msisdn'
  | 'imsi'
  | 'imei'
  | 'iccid'
  | 'rawCellId'
  | 'siteId'
  | 'sectorId'
  | 'lac'
  | 'tac'
  | 'technology'
  | 'eventKind'
  | 'direction'
  | 'durationSec'
  | 'otherParty'
  | 'timingAdvance'
  | 'reportedLat'
  | 'reportedLon'
  | 'azimuthDegrees'
  | 'beamWidthDegrees';

export interface ColumnProfile {
  readonly column: string;
  readonly index: number;
  readonly sampleValues: readonly string[];
  readonly populatedRatio: number;
  readonly distinctRatio: number;
  readonly inferredKind: 'IDENTIFIER' | 'TIMESTAMP' | 'NUMERIC' | 'COORDINATE' | 'CODE' | 'TEXT' | 'EMPTY';
  readonly inferredIdentifierType?: IdentifierType;
}

export interface MappingSuggestion {
  readonly field: CanonicalField;
  readonly column: string;
  readonly confidence: number;
  /** Plain-language reason, shown next to the suggestion in the review UI. */
  readonly rationale: string;
  /** True when the analyst must confirm before the import may proceed. */
  readonly requiresApproval: boolean;
}

export interface GenericProfile {
  readonly delimiter: string;
  readonly headers: readonly string[];
  readonly rowCount: number;
  readonly columns: readonly ColumnProfile[];
  readonly suggestions: readonly MappingSuggestion[];
  readonly unmappedColumns: readonly string[];
  /** Blocking problems that prevent even a mapped import. */
  readonly blockers: readonly string[];
}

/** Confidence below which a suggested mapping always needs sign-off. */
export const MAPPING_APPROVAL_THRESHOLD = 0.85;

const HEADER_HINTS: { field: CanonicalField; patterns: RegExp[]; weight: number }[] = [
  { field: 'timestamp', patterns: [/date.*time/i, /timestamp/i, /^date$/i, /event.*d(t|tm|ate)/i, /call.*date/i], weight: 0.45 },
  { field: 'msisdn', patterns: [/msisdn/i, /mdn/i, /^min$/i, /subscriber.*n(br|um)/i, /target.*num/i, /phone/i, /mobile.*num/i], weight: 0.45 },
  { field: 'imsi', patterns: [/imsi/i], weight: 0.5 },
  { field: 'imei', patterns: [/imei/i, /equipment.*id/i, /esn/i, /meid/i], weight: 0.5 },
  { field: 'iccid', patterns: [/iccid/i, /sim.*(id|serial)/i], weight: 0.5 },
  { field: 'rawCellId', patterns: [/cell.*id/i, /cgi/i, /cell.*identity/i, /^cell$/i], weight: 0.45 },
  { field: 'siteId', patterns: [/site/i, /enodeb/i, /^enb$/i, /cell.*site/i, /tower/i], weight: 0.4 },
  { field: 'sectorId', patterns: [/sector/i, /^sect/i, /face/i], weight: 0.4 },
  { field: 'lac', patterns: [/^lac$/i, /location.*area/i], weight: 0.5 },
  { field: 'tac', patterns: [/^tac$/i, /tracking.*area/i], weight: 0.5 },
  { field: 'technology', patterns: [/^rat$/i, /technology/i, /network.*type/i, /air.*interface/i], weight: 0.45 },
  { field: 'eventKind', patterns: [/call.*type/i, /event.*type/i, /seizure/i, /^type$/i, /event.*cd/i], weight: 0.4 },
  { field: 'direction', patterns: [/direction/i, /^dir/i, /in.*out/i, /orig.*term/i], weight: 0.45 },
  { field: 'durationSec', patterns: [/duration/i, /^dur/i, /elapsed/i, /call.*length/i], weight: 0.45 },
  { field: 'otherParty', patterns: [/other.*(party|num)/i, /dialed/i, /called.*num/i, /calling.*num/i, /correspondent/i], weight: 0.4 },
  { field: 'timingAdvance', patterns: [/timing.*advance/i, /^ta$/i, /ta.*val/i, /^ta_/i], weight: 0.5 },
  { field: 'reportedLat', patterns: [/lat(itude)?/i, /lat.*dec/i], weight: 0.5 },
  { field: 'reportedLon', patterns: [/lon(gitude)?/i, /^lng$/i, /lon.*dec/i], weight: 0.5 },
  { field: 'azimuthDegrees', patterns: [/azimuth/i, /bearing/i, /orientation/i], weight: 0.5 },
  { field: 'beamWidthDegrees', patterns: [/beam.*width/i, /^bw$/i, /horiz.*beam/i], weight: 0.5 },
];

export function profileColumns(document: TabularDocument): ColumnProfile[] {
  const sampleRows = document.rows.slice(0, 200);

  return document.headers.map((column, index) => {
    const values = sampleRows
      .map((row) => row.fields[index]?.trim() ?? '')
      .filter((v) => v.length > 0 && !isNullToken(v));

    const populatedRatio = sampleRows.length === 0 ? 0 : values.length / sampleRows.length;
    const distinctRatio = values.length === 0 ? 0 : new Set(values).size / values.length;
    const sampleValues = [...new Set(values)].slice(0, 5);

    if (values.length === 0) {
      return { column, index, sampleValues, populatedRatio, distinctRatio, inferredKind: 'EMPTY' as const };
    }

    // Identifier detection by value shape.
    const identifierVotes = new Map<IdentifierType, number>();
    for (const value of values.slice(0, 50)) {
      const guess = inferIdentifierType(value);
      if (guess) identifierVotes.set(guess.type, (identifierVotes.get(guess.type) ?? 0) + 1);
    }
    const topIdentifier = [...identifierVotes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topIdentifier && topIdentifier[1] / Math.min(50, values.length) >= 0.7) {
      return {
        column,
        index,
        sampleValues,
        populatedRatio,
        distinctRatio,
        inferredKind: 'IDENTIFIER' as const,
        inferredIdentifierType: topIdentifier[0],
      };
    }

    // Timestamp detection.
    const parsed = values.slice(0, 30).filter((v) => normalizeTimestamp(v, { packageZone: 'UTC' }).utc);
    if (parsed.length / Math.min(30, values.length) >= 0.8) {
      return { column, index, sampleValues, populatedRatio, distinctRatio, inferredKind: 'TIMESTAMP' as const };
    }

    // Coordinate detection — numeric and within lat/lon bounds with decimals.
    const numbers = values.slice(0, 50).map((v) => Number.parseFloat(v)).filter((n) => Number.isFinite(n));
    if (numbers.length / Math.min(50, values.length) >= 0.9) {
      const allInLatLonRange = numbers.every((n) => Math.abs(n) <= 180);
      const hasDecimals = values.slice(0, 50).some((v) => /\.\d{3,}/.test(v));
      if (allInLatLonRange && hasDecimals) {
        return { column, index, sampleValues, populatedRatio, distinctRatio, inferredKind: 'COORDINATE' as const };
      }
      return { column, index, sampleValues, populatedRatio, distinctRatio, inferredKind: 'NUMERIC' as const };
    }

    // Low-cardinality short strings look like coded enumerations.
    const distinctCount = new Set(values).size;
    if (distinctCount <= 12 && values.every((v) => v.length <= 20)) {
      return { column, index, sampleValues, populatedRatio, distinctRatio, inferredKind: 'CODE' as const };
    }

    return { column, index, sampleValues, populatedRatio, distinctRatio, inferredKind: 'TEXT' as const };
  });
}

/**
 * Propose a mapping for an unrecognised file.
 *
 * Confidence combines a header-name signal with a value-shape signal. Both
 * agreeing produces high confidence; a header that looks right but holds the
 * wrong kind of data does not, which is the case that silently corrupts
 * evidence in tools that map on column names alone.
 */
export function suggestMapping(content: string, filename = ''): GenericProfile {
  const document = readTabular(content, { limit: 200 });
  const columns = profileColumns(document);
  const suggestions: MappingSuggestion[] = [];
  const claimed = new Set<string>();
  const blockers: string[] = [];

  const candidates: { field: CanonicalField; column: string; confidence: number; rationale: string }[] = [];

  for (const profile of columns) {
    if (profile.inferredKind === 'EMPTY') continue;

    for (const hint of HEADER_HINTS) {
      const headerMatches = hint.patterns.some((p) => p.test(profile.column));
      const valueScore = valueAgreement(hint.field, profile);
      if (!headerMatches && valueScore < 0.9) continue;

      const headerScore = headerMatches ? hint.weight : 0;
      const confidence = Math.min(1, headerScore + valueScore * 0.55);

      candidates.push({
        field: hint.field,
        column: profile.column,
        confidence,
        rationale: buildRationale(profile, headerMatches, valueScore, hint.field),
      });
    }
  }

  // Greedily assign the highest-confidence pairing, one column per field.
  candidates.sort((a, b) => b.confidence - a.confidence);
  const assignedFields = new Set<CanonicalField>();
  for (const candidate of candidates) {
    if (assignedFields.has(candidate.field) || claimed.has(candidate.column)) continue;
    assignedFields.add(candidate.field);
    claimed.add(candidate.column);
    suggestions.push({
      field: candidate.field,
      column: candidate.column,
      confidence: candidate.confidence,
      rationale: candidate.rationale,
      requiresApproval: candidate.confidence < MAPPING_APPROVAL_THRESHOLD,
    });
  }

  if (!assignedFields.has('timestamp')) {
    blockers.push(
      'No column could be identified as a timestamp. Cellular records without a time reference ' +
        'cannot be analysed; map the timestamp column manually or confirm this file is not an event file.',
    );
  }
  const hasIdentifier = ['msisdn', 'imsi', 'imei', 'iccid'].some((f) => assignedFields.has(f as CanonicalField));
  if (!hasIdentifier) {
    blockers.push(
      'No column could be identified as a device or subscriber identifier. Without one, records ' +
        'cannot be attributed to a device.',
    );
  }

  return {
    delimiter: document.delimiter,
    headers: document.headers,
    rowCount: document.rows.length,
    columns,
    suggestions,
    unmappedColumns: document.headers.filter((h) => !claimed.has(h) && h.trim().length > 0),
    blockers,
  };
}

function valueAgreement(field: CanonicalField, profile: ColumnProfile): number {
  switch (field) {
    case 'timestamp':
      return profile.inferredKind === 'TIMESTAMP' ? 1 : 0;
    case 'msisdn':
    case 'otherParty':
      return profile.inferredIdentifierType === 'MSISDN' ? 1 : 0;
    case 'imsi':
      return profile.inferredIdentifierType === 'IMSI' ? 1 : 0;
    case 'imei':
      return profile.inferredIdentifierType === 'IMEI' ? 1 : 0;
    case 'iccid':
      return profile.inferredIdentifierType === 'ICCID' ? 1 : 0;
    case 'reportedLat':
    case 'reportedLon':
      return profile.inferredKind === 'COORDINATE' ? 1 : 0;
    case 'durationSec':
    case 'timingAdvance':
    case 'azimuthDegrees':
    case 'beamWidthDegrees':
      return profile.inferredKind === 'NUMERIC' ? 0.7 : 0;
    case 'direction':
    case 'eventKind':
    case 'technology':
      return profile.inferredKind === 'CODE' ? 0.7 : 0;
    default:
      return 0;
  }
}

function buildRationale(
  profile: ColumnProfile,
  headerMatches: boolean,
  valueScore: number,
  field: CanonicalField,
): string {
  const parts: string[] = [];
  if (headerMatches) parts.push(`the column name "${profile.column}" matches the usual naming for ${field}`);
  if (valueScore >= 0.9) {
    parts.push(
      profile.inferredIdentifierType
        ? `its values have the structure of ${profile.inferredIdentifierType} data`
        : `its values have the structure of ${profile.inferredKind.toLowerCase()} data`,
    );
  } else if (valueScore > 0) {
    parts.push(`its values are ${profile.inferredKind.toLowerCase()}, which is consistent with ${field}`);
  } else {
    parts.push(`its values could not be confirmed as ${field} data, so this rests on the column name alone`);
  }
  const examples = profile.sampleValues.slice(0, 3).join(', ');
  return `Suggested because ${parts.join(' and ')}. Example values: ${examples || '(none)'}.`;
}

/** Turn an analyst-approved mapping into a runnable parser definition. */
export function definitionFromMapping(
  mapping: Readonly<Record<string, string>>,
  opts: {
    id: string;
    carrier: string;
    carrierDisplayName?: string;
    recordType?: ParserDefinition['recordType'];
    delimiter?: ParserDefinition['delimiter'];
    approvedByUserId: string;
    approvedAtUtc: string;
  },
): ParserDefinition {
  const field = (name: string): SourceField | undefined =>
    mapping[name] ? { columns: [mapping[name]!] } : undefined;

  const timestampColumn = mapping.timestamp;
  if (!timestampColumn) {
    throw new Error('An approved mapping must include a timestamp column.');
  }

  const fields: FieldMap = {
    timestamp: { kind: 'SINGLE', field: { columns: [timestampColumn], required: true } },
    ...(field('msisdn') ? { msisdn: field('msisdn') } : {}),
    ...(field('imsi') ? { imsi: field('imsi') } : {}),
    ...(field('imei') ? { imei: field('imei') } : {}),
    ...(field('iccid') ? { iccid: field('iccid') } : {}),
    ...(field('rawCellId') ? { rawCellId: field('rawCellId') } : {}),
    ...(field('siteId') ? { siteId: field('siteId') } : {}),
    ...(field('sectorId') ? { sectorId: field('sectorId') } : {}),
    ...(field('lac') ? { lac: field('lac') } : {}),
    ...(field('tac') ? { tac: field('tac') } : {}),
    ...(field('technology') ? { technology: field('technology') } : {}),
    ...(field('eventKind') ? { eventKind: field('eventKind') } : {}),
    ...(field('direction') ? { direction: field('direction') } : {}),
    ...(field('durationSec') ? { durationSec: field('durationSec') } : {}),
    ...(field('otherParty') ? { otherParty: field('otherParty') } : {}),
    ...(field('timingAdvance') ? { timingAdvance: field('timingAdvance') } : {}),
    ...(field('reportedLat') ? { reportedLat: field('reportedLat') } : {}),
    ...(field('reportedLon') ? { reportedLon: field('reportedLon') } : {}),
    ...(field('azimuthDegrees') ? { azimuthDegrees: field('azimuthDegrees') } : {}),
    ...(field('beamWidthDegrees') ? { beamWidthDegrees: field('beamWidthDegrees') } : {}),
  };

  return {
    id: opts.id,
    version: '1.0.0',
    carrier: opts.carrier,
    carrierDisplayName: opts.carrierDisplayName ?? opts.carrier,
    recordType: opts.recordType ?? 'UNKNOWN',
    description: `Analyst-defined mapping approved by ${opts.approvedByUserId} at ${opts.approvedAtUtc}.`,
    calibration: 'SAMPLE_CALIBRATED',
    calibrationNote:
      `Column mapping was defined and approved by ${opts.approvedByUserId} at ${opts.approvedAtUtc} ` +
      `for this specific production. It has not been validated against other productions from this source.`,
    ...(opts.delimiter ? { delimiter: opts.delimiter } : {}),
    fingerprint: {
      required: [timestampColumn],
    },
    timezoneNote:
      'This is an analyst-defined mapping. The production timezone must be declared on the ' +
      'evidence package; no carrier default applies.',
    fields,
  };
}
