// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Carrier and schema detection.
 *
 * The confidence figure shown on the import screen is not a vibe. It is a
 * weighted combination of named signals, and every signal is returned alongside
 * it so the analyst can see WHY the system believes this is a T-Mobile tower
 * dump. A number with no breakdown behind it is exactly the kind of opaque
 * output this product exists to avoid.
 *
 * Detection never commits evidence on its own. Below the acceptance threshold
 * the import stops and asks.
 */

import { inferIdentifierType, normalizeTimestamp, isNullToken } from '@cmurk/cellular-schema';
import { readTabular, detectDelimiter, type TabularDocument } from './tabular';
import type { DetectionResult, ParserDefinition, SourceField } from './types';

/** Confidence at or above which an import may proceed without column review. */
export const AUTO_ACCEPT_CONFIDENCE = 0.9;
/** Below this, the parser is not offered as a candidate at all. */
export const MINIMUM_CANDIDATE_CONFIDENCE = 0.35;

const normalizeHeader = (header: string): string =>
  header.trim().toLowerCase().replace(/[\s_\-.]+/g, '');

/** Does a source field resolve against these headers? Returns the matched header. */
export function resolveColumn(
  field: SourceField | undefined,
  headers: readonly string[],
): string | undefined {
  if (!field) return undefined;
  const normalized = headers.map(normalizeHeader);
  for (const alias of field.columns) {
    const index = normalized.indexOf(normalizeHeader(alias));
    if (index >= 0) return headers[index];
  }
  return undefined;
}

/** Every header this parser definition knows how to consume. */
export function mappedColumns(definition: ParserDefinition, headers: readonly string[]): Set<string> {
  const mapped = new Set<string>();
  const consider = (field: SourceField | undefined) => {
    const match = resolveColumn(field, headers);
    if (match) mapped.add(match);
  };

  const { timestamp, timestampEnd, ...rest } = definition.fields;
  if (timestamp.kind === 'SINGLE') consider(timestamp.field);
  else {
    consider(timestamp.date);
    consider(timestamp.time);
    consider(timestamp.zone);
  }
  if (timestampEnd) {
    if (timestampEnd.kind === 'SINGLE') consider(timestampEnd.field);
    else {
      consider(timestampEnd.date);
      consider(timestampEnd.time);
    }
  }
  for (const field of Object.values(rest)) consider(field as SourceField | undefined);
  return mapped;
}

export interface DetectionInput {
  readonly filename: string;
  /** First portion of the decoded file. A few hundred rows is ample. */
  readonly sample?: string;
  /**
   * A pre-built table, for sources that are not delimited text.
   *
   * A spreadsheet has no delimiter — its cells are structured, not separated by
   * a character. Re-serialising a sheet to text just to re-split it would make
   * detection depend on a delimiter the source never had, and a comma-delimited
   * parser would then fail on a perfectly valid workbook. When a document is
   * supplied it is used directly and the delimiter signal is skipped.
   */
  readonly document?: TabularDocument;
}

/**
 * Score one parser definition against a file sample.
 * Returns undefined when a required column is missing or a forbidden one is
 * present — those are disqualifications, not low scores.
 */
export function scoreParser(
  definition: ParserDefinition,
  input: DetectionInput,
): DetectionResult | undefined {
  let document: TabularDocument;
  if (input.document) {
    document = input.document;
  } else if (input.sample !== undefined) {
    try {
      document = readTabular(input.sample, {
        ...(definition.delimiter ? { delimiter: definition.delimiter } : {}),
        ...(definition.skipLines ? { skipLines: definition.skipLines } : {}),
        limit: 200,
      });
    } catch {
      return undefined;
    }
  } else {
    throw new Error('Detection requires either a text sample or a pre-built document.');
  }

  const headers = document.headers;
  const normalizedHeaders = headers.map(normalizeHeader);

  // --- disqualifiers -------------------------------------------------------
  for (const forbidden of definition.fingerprint.forbidden ?? []) {
    if (normalizedHeaders.includes(normalizeHeader(forbidden))) return undefined;
  }

  const matchedRequired: string[] = [];
  const missingRequired: string[] = [];
  for (const required of definition.fingerprint.required) {
    const index = normalizedHeaders.indexOf(normalizeHeader(required));
    if (index >= 0) matchedRequired.push(headers[index]!);
    else missingRequired.push(required);
  }
  if (missingRequired.length > 0) return undefined;

  const matchedOptional: string[] = [];
  for (const optional of definition.fingerprint.optional ?? []) {
    const index = normalizedHeaders.indexOf(normalizeHeader(optional));
    if (index >= 0) matchedOptional.push(headers[index]!);
  }

  // --- signals -------------------------------------------------------------
  const signals: { name: string; weight: number; score: number; detail: string }[] = [];
  const notes: string[] = [];

  signals.push({
    name: 'Required columns',
    weight: 0.35,
    score: 1,
    detail: `All ${definition.fingerprint.required.length} required columns are present.`,
  });

  const optionalTotal = definition.fingerprint.optional?.length ?? 0;
  const optionalScore = optionalTotal === 0 ? 1 : matchedOptional.length / optionalTotal;
  signals.push({
    name: 'Optional columns',
    weight: 0.15,
    score: optionalScore,
    detail:
      optionalTotal === 0
        ? 'This format defines no optional columns.'
        : `${matchedOptional.length} of ${optionalTotal} optional columns present.`,
  });

  // Delimiter agreement — a T-Mobile TSV read as CSV would produce one column.
  // It does not apply to structured sources, where there is no delimiter to agree with.
  if (document.origin === 'SPREADSHEET') {
    signals.push({
      name: 'Delimiter',
      weight: 0.1,
      score: 1,
      detail:
        `The source is a spreadsheet${document.sheetName ? ` (sheet "${document.sheetName}")` : ''}, ` +
        `so its cells are structured rather than delimited and this format's delimiter does not apply.`,
    });
  } else {
    const detectedDelimiter = detectDelimiter(input.sample ?? '');
    const delimiterExpected = definition.delimiter ?? ',';
    const delimiterScore = detectedDelimiter === delimiterExpected ? 1 : 0.2;
    signals.push({
      name: 'Delimiter',
      weight: 0.1,
      score: delimiterScore,
      detail:
        delimiterScore === 1
          ? `File delimiter matches the expected ${describeDelimiter(delimiterExpected)}.`
          : `File appears ${describeDelimiter(detectedDelimiter)}-delimited but this format expects ${describeDelimiter(delimiterExpected)}.`,
    });
  }

  // Value shape — do the mapped identifier columns actually hold identifiers?
  const valueCheck = checkValueShapes(definition, document);
  signals.push({
    name: 'Column contents',
    weight: 0.25,
    score: valueCheck.score,
    detail: valueCheck.detail,
  });

  // Timestamp parseability.
  const timeCheck = checkTimestamps(definition, document);
  signals.push({
    name: 'Timestamp format',
    weight: 0.1,
    score: timeCheck.score,
    detail: timeCheck.detail,
  });

  // Filename hint.
  const filenameMatch = definition.fingerprint.filenamePattern?.test(input.filename) ?? undefined;
  if (filenameMatch !== undefined) {
    signals.push({
      name: 'Filename',
      weight: 0.05,
      score: filenameMatch ? 1 : 0.5,
      detail: filenameMatch
        ? `Filename "${input.filename}" matches this carrier's naming convention.`
        : `Filename "${input.filename}" does not match this carrier's usual naming, which is common and not disqualifying.`,
    });
  }

  const unmapped = mappedColumns(definition, headers);
  const unmappedColumns = headers.filter((h) => !unmapped.has(h) && h.trim().length > 0);
  if (unmappedColumns.length > 0) {
    notes.push(
      `${unmappedColumns.length} column(s) in this file are not mapped by the parser and will be ` +
        `retained unmodified against each record: ${unmappedColumns.slice(0, 8).join(', ')}` +
        `${unmappedColumns.length > 8 ? ', …' : ''}.`,
    );
  }
  if (document.raggedRows.length > 0) {
    notes.push(
      `${document.raggedRows.length} row(s) in the sample have a different number of fields than ` +
        `the header. They are retained and flagged, not discarded.`,
    );
  }

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const confidence = signals.reduce((sum, s) => sum + s.weight * s.score, 0) / totalWeight;

  return {
    parserId: definition.id,
    parserVersion: definition.version,
    carrier: definition.carrier,
    carrierDisplayName: definition.carrierDisplayName,
    recordType: definition.recordType,
    calibration: definition.calibration,
    confidence,
    matchedRequired,
    missingRequired,
    matchedOptional,
    unmappedColumns,
    signals,
    notes,
  };
}

function describeDelimiter(delimiter: string): string {
  switch (delimiter) {
    case ',': return 'comma';
    case '\t': return 'tab';
    case '|': return 'pipe';
    case ';': return 'semicolon';
    default: return delimiter;
  }
}

/**
 * Check that identifier columns contain values of the expected type.
 *
 * This is what separates a genuine match from a coincidental header match. A
 * file with an "IMSI" column full of phone numbers is not the format it claims.
 */
function checkValueShapes(
  definition: ParserDefinition,
  document: TabularDocument,
): { score: number; detail: string } {
  const checks: { field: string; expected: string; column: string | undefined }[] = [
    { field: 'imsi', expected: 'IMSI', column: resolveColumn(definition.fields.imsi, document.headers) },
    { field: 'imei', expected: 'IMEI', column: resolveColumn(definition.fields.imei, document.headers) },
    { field: 'msisdn', expected: 'MSISDN', column: resolveColumn(definition.fields.msisdn, document.headers) },
  ].filter((c) => c.column !== undefined);

  if (checks.length === 0) {
    return { score: 0.6, detail: 'No identifier columns are mapped, so contents could not be verified.' };
  }

  const sampleRows = document.rows.slice(0, 50);
  let passed = 0;
  const failures: string[] = [];

  for (const check of checks) {
    const index = document.headers.indexOf(check.column!);
    let matches = 0;
    let considered = 0;
    for (const row of sampleRows) {
      const value = row.fields[index]?.trim();
      if (!value || isNullToken(value)) continue;
      considered += 1;
      const guess = inferIdentifierType(value);
      if (guess?.type === check.expected) matches += 1;
    }
    if (considered === 0) {
      failures.push(`${check.column} contained no values to check`);
      continue;
    }
    const ratio = matches / considered;
    if (ratio >= 0.8) passed += 1;
    else failures.push(`${check.column} does not look like ${check.expected} data (${Math.round(ratio * 100)}% match)`);
  }

  const score = passed / checks.length;
  return {
    score,
    detail:
      failures.length === 0
        ? `Sampled values in ${checks.map((c) => c.column).join(', ')} match their declared identifier types.`
        : failures.join('; ') + '.',
  };
}

function checkTimestamps(
  definition: ParserDefinition,
  document: TabularDocument,
): { score: number; detail: string } {
  const { timestamp } = definition.fields;
  const column =
    timestamp.kind === 'SINGLE'
      ? resolveColumn(timestamp.field, document.headers)
      : resolveColumn(timestamp.date, document.headers);
  if (!column) return { score: 0, detail: 'The timestamp column could not be located.' };

  const index = document.headers.indexOf(column);
  const timeColumn = timestamp.kind === 'SPLIT' ? resolveColumn(timestamp.time, document.headers) : undefined;
  const timeIndex = timeColumn ? document.headers.indexOf(timeColumn) : -1;

  const sampleRows = document.rows.slice(0, 50);
  let parsed = 0;
  let considered = 0;

  for (const row of sampleRows) {
    let value = row.fields[index]?.trim() ?? '';
    if (timeIndex >= 0) value = `${value} ${row.fields[timeIndex]?.trim() ?? ''}`.trim();
    if (!value) continue;
    considered += 1;
    const result = normalizeTimestamp(value, { packageZone: 'UTC' });
    if (result.utc) parsed += 1;
  }

  if (considered === 0) return { score: 0, detail: 'The timestamp column contained no values.' };
  const ratio = parsed / considered;
  return {
    score: ratio,
    detail:
      ratio === 1
        ? `All ${considered} sampled timestamps parsed successfully.`
        : `${parsed} of ${considered} sampled timestamps parsed; ${considered - parsed} did not match a known format.`,
  };
}

/** Rank every registered parser against a file, best first. */
export function detectFormat(
  definitions: readonly ParserDefinition[],
  input: DetectionInput,
): DetectionResult[] {
  return definitions
    .map((definition) => scoreParser(definition, input))
    .filter((result): result is DetectionResult => result !== undefined)
    .filter((result) => result.confidence >= MINIMUM_CANDIDATE_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);
}
