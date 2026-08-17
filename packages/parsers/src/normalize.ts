// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Row → canonical event normalization.
 *
 * One engine executes every parser definition. It is responsible for the
 * guarantees that make the output defensible:
 *
 *   • the original row text and row number are preserved and hashed
 *   • timestamps record their source zone and conversion method
 *   • identifiers are normalized without discarding their raw form
 *   • nothing is silently repaired — every anomaly becomes a quality flag
 *   • unmapped columns are retained, not dropped
 */

import {
  normalizeTimestamp,
  normalizeMsisdn,
  normalizeImsi,
  normalizeImei,
  normalizeIccid,
  normalizeEsnMeid,
  hashSourceRow,
  deterministicRecordId,
  cellSiteKey,
  cellSectorKey,
  isNullToken,
  QUALITY_FLAGS,
  type CellularEvent,
  type EventKind,
  type EventDirection,
  type RadioTechnology,
  type QualityFlag,
} from '@cmurk/cellular-schema';
import { readTabular, headerIndex, type TabularRow, type TabularDocument } from './tabular';
import { resolveColumn, mappedColumns } from './detect';
import type { ParserDefinition, SourceField, ImportWarning } from './types';

export interface NormalizeContext {
  readonly caseId: string;
  readonly packageId: string;
  readonly sourceFileId: string;
  readonly sourceSheet?: string;
  /** Timezone declared for this package by the analyst, from the cover letter. */
  readonly declaredTimezone?: string;
  /** Interpret ambiguous numeric dates as day-first. */
  readonly dayFirst?: boolean;
  /** Clock used for "timestamp in the future" checks. */
  readonly importedAtUtc?: string;
}

export interface NormalizeResult {
  readonly events: readonly CellularEvent[];
  readonly warnings: readonly ImportWarning[];
  readonly rowsRead: number;
  readonly rowsRejected: number;
  /** Rows that produced no usable event, with the reason. */
  readonly rejections: readonly { row: number; reason: string; raw: string }[];
  readonly unmappedColumns: readonly string[];
}

/** Cell site / sector rows, produced by CELL_SITE_LIST parsers. */
export interface ParsedSector {
  readonly sectorKey: string;
  readonly siteKey: string;
  readonly carrier: string;
  readonly siteId: string;
  readonly sectorId: string;
  readonly rawCellId?: string;
  readonly lat: number;
  readonly lon: number;
  readonly azimuthDegrees?: number;
  readonly beamWidthDegrees?: number;
  readonly technology?: RadioTechnology;
  readonly band?: string;
  readonly siteName?: string;
  readonly siteAddress?: string;
  readonly sourceRow: number;
  readonly rowHash: string;
  readonly qualityFlags: readonly QualityFlag[];
}

class WarningCollector {
  private readonly map = new Map<string, { severity: 'INFO' | 'WARNING' | 'ERROR'; message: string; count: number; rows: number[] }>();

  add(code: string, severity: 'INFO' | 'WARNING' | 'ERROR', message: string, row: number): void {
    const existing = this.map.get(code);
    if (existing) {
      existing.count += 1;
      if (existing.rows.length < 10) existing.rows.push(row);
    } else {
      this.map.set(code, { severity, message, count: 1, rows: [row] });
    }
  }

  toWarnings(): ImportWarning[] {
    return [...this.map.entries()]
      .map(([code, v]) => ({
        code,
        severity: v.severity,
        message: v.message,
        count: v.count,
        sampleRows: v.rows,
      }))
      .sort((a, b) => {
        const order = { ERROR: 0, WARNING: 1, INFO: 2 };
        return order[a.severity] - order[b.severity] || b.count - a.count;
      });
  }
}

/** Read a mapped field from a row. */
function read(
  field: SourceField | undefined,
  row: TabularRow,
  headers: readonly string[],
  index: Map<string, number>,
): string | undefined {
  if (!field) return undefined;
  for (const alias of field.columns) {
    const position = index.get(alias.trim().toLowerCase());
    if (position === undefined) continue;
    const value = row.fields[position];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    return field.transform ? field.transform(trimmed, row, headers) : trimmed;
  }
  return undefined;
}

const numeric = (value: string | undefined): number | undefined => {
  if (value === undefined || isNullToken(value)) return undefined;
  const parsed = Number.parseFloat(value.replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const codeLookup = <T extends string>(
  value: string | undefined,
  map: Readonly<Record<string, T>> | undefined,
  fallback: T,
): T => {
  if (!value || !map) return fallback;
  const key = value.trim().toUpperCase().replace(/[\s_\-.]+/g, '');
  return map[key] ?? map[value.trim().toUpperCase()] ?? fallback;
};

/**
 * Normalize a whole tabular document into canonical events.
 *
 * Rows that cannot yield a usable event are REJECTED with a reason, never
 * silently dropped: the rejection list is shown to the analyst and the counts
 * appear in the import report.
 */
export function normalizeEvents(
  definition: ParserDefinition,
  /**
   * Delimited text, or an already-built table.
   *
   * Spreadsheets arrive as a document because their cells are structured, not
   * separated by a character — see DetectionInput for why round-tripping them
   * through text would be wrong.
   */
  source: string | TabularDocument,
  ctx: NormalizeContext,
): NormalizeResult {
  const document =
    typeof source === 'string'
      ? readTabular(source, {
          ...(definition.delimiter ? { delimiter: definition.delimiter } : {}),
          ...(definition.skipLines ? { skipLines: definition.skipLines } : {}),
        })
      : source;

  const { headers } = document;
  const index = headerIndex(headers);
  const warnings = new WarningCollector();
  const events: CellularEvent[] = [];
  const rejections: { row: number; reason: string; raw: string }[] = [];

  const mapped = mappedColumns(definition, headers);
  const unmappedColumns = headers.filter((h) => !mapped.has(h) && h.trim().length > 0);
  const unmappedIndices = unmappedColumns.map((h) => ({ header: h, position: headers.indexOf(h) }));

  const importedAt = ctx.importedAtUtc ?? new Date().toISOString();
  const seenRowHashes = new Map<string, number>();

  for (const row of document.rows) {
    const flags = new Set<QualityFlag>();
    const rowHash = hashSourceRow(row.raw);

    // Exact duplicate rows are flagged, not removed — a carrier legitimately
    // producing the same row twice is itself a fact about the evidence.
    const firstSeen = seenRowHashes.get(rowHash);
    if (firstSeen !== undefined) {
      flags.add(QUALITY_FLAGS.DUPLICATE_ROW);
      warnings.add(
        QUALITY_FLAGS.DUPLICATE_ROW,
        'INFO',
        'Rows identical to an earlier row in this file were found. They are retained and flagged, not removed.',
        row.row,
      );
    } else {
      seenRowHashes.set(rowHash, row.row);
    }

    if (row.fields.length !== headers.length) {
      warnings.add(
        'RAGGED_ROW',
        'WARNING',
        `Rows have a different number of fields than the header, which usually means an unescaped ` +
          `delimiter inside a value. These rows are parsed positionally and flagged.`,
        row.row,
      );
    }

    // --- time ------------------------------------------------------------
    const { timestamp } = definition.fields;
    let rawTimestamp: string | undefined;
    let rowZone: string | undefined;

    if (timestamp.kind === 'SINGLE') {
      rawTimestamp = read(timestamp.field, row, headers, index);
    } else {
      const date = read(timestamp.date, row, headers, index);
      const time = read(timestamp.time, row, headers, index);
      rowZone = read(timestamp.zone, row, headers, index);
      rawTimestamp = date && time ? `${date} ${time}` : (date ?? time);
    }

    if (!rawTimestamp) {
      flags.add(QUALITY_FLAGS.MISSING_TIMESTAMP);
      warnings.add(
        QUALITY_FLAGS.MISSING_TIMESTAMP,
        'ERROR',
        'Records with no timestamp cannot take part in any time-based analysis.',
        row.row,
      );
    }

    const time = normalizeTimestamp(rawTimestamp ?? '', {
      ...(rowZone ? { rowZone } : {}),
      ...(ctx.declaredTimezone ? { packageZone: ctx.declaredTimezone } : {}),
      ...(definition.defaultTimezone ? { carrierDefaultZone: definition.defaultTimezone } : {}),
      ...(ctx.dayFirst ? { dayFirst: ctx.dayFirst } : {}),
    });

    if (rawTimestamp && !time.utc) {
      flags.add(QUALITY_FLAGS.UNPARSEABLE_TIMESTAMP);
      warnings.add(
        QUALITY_FLAGS.UNPARSEABLE_TIMESTAMP,
        'ERROR',
        `Timestamps did not match any known format. Example: "${rawTimestamp}". These records are ` +
          `retained verbatim but excluded from time-based analysis.`,
        row.row,
      );
    }
    if (time.confidence === 'ZONE_ASSUMED') {
      flags.add(QUALITY_FLAGS.ASSUMED_TIMEZONE);
      warnings.add(
        QUALITY_FLAGS.ASSUMED_TIMEZONE,
        'WARNING',
        time.warning ??
          'No timezone was stated in these records; one was assumed. Declare the production ' +
            'timezone on the evidence package before relying on time-based analysis.',
        row.row,
      );
    }
    if (time.confidence === 'DST_AMBIGUOUS') {
      flags.add(QUALITY_FLAGS.DST_AMBIGUOUS);
      warnings.add(
        QUALITY_FLAGS.DST_AMBIGUOUS,
        'WARNING',
        'Some local times occur twice on their date because of the daylight-saving transition. ' +
          'Both interpretations are recorded; the system has not chosen between them.',
        row.row,
      );
    }
    if (time.confidence === 'DST_NONEXISTENT') {
      flags.add(QUALITY_FLAGS.DST_NONEXISTENT);
      warnings.add(
        QUALITY_FLAGS.DST_NONEXISTENT,
        'WARNING',
        'Some local times do not exist on their date because the clock skipped them at the ' +
          'daylight-saving transition. The declared source timezone may be wrong.',
        row.row,
      );
    }
    if (time.utc) {
      if (time.utc > importedAt) {
        flags.add(QUALITY_FLAGS.TIMESTAMP_IN_FUTURE);
        warnings.add(QUALITY_FLAGS.TIMESTAMP_IN_FUTURE, 'WARNING', 'Some records are timestamped later than the import time.', row.row);
      }
      if (time.utc < '1990-01-01T00:00:00.000Z') {
        flags.add(QUALITY_FLAGS.TIMESTAMP_IMPLAUSIBLY_OLD);
        warnings.add(QUALITY_FLAGS.TIMESTAMP_IMPLAUSIBLY_OLD, 'WARNING', 'Some records predate commercial cellular service.', row.row);
      }
    }

    // --- identifiers -----------------------------------------------------
    const rawMsisdn = read(definition.fields.msisdn, row, headers, index);
    const rawImsi = read(definition.fields.imsi, row, headers, index);
    const rawImei = read(definition.fields.imei, row, headers, index);
    const rawIccid = read(definition.fields.iccid, row, headers, index);
    const rawEsn = read(definition.fields.esn, row, headers, index);
    const rawMeid = read(definition.fields.meid, row, headers, index);

    const msisdn = rawMsisdn ? normalizeMsisdn(rawMsisdn) : undefined;
    const imsi = rawImsi ? normalizeImsi(rawImsi) : undefined;
    const imei = rawImei ? normalizeImei(rawImei) : undefined;
    const iccid = rawIccid ? normalizeIccid(rawIccid) : undefined;
    const esn = rawEsn ? normalizeEsnMeid(rawEsn, 'ESN') : undefined;
    const meid = rawMeid ? normalizeEsnMeid(rawMeid, 'MEID') : undefined;

    if (msisdn && !msisdn.valid && msisdn.normalized === undefined) flags.add(QUALITY_FLAGS.MALFORMED_MSISDN);
    if (msisdn?.issues.some((i) => /assumed/i.test(i))) flags.add(QUALITY_FLAGS.ASSUMED_COUNTRY_CODE);
    if (imsi && !imsi.valid) {
      flags.add(QUALITY_FLAGS.MALFORMED_IMSI);
      warnings.add(QUALITY_FLAGS.MALFORMED_IMSI, 'WARNING', `IMSI values failed validation. Example issue: ${imsi.issues[0] ?? 'unknown'}.`, row.row);
    }
    if (imei && !imei.valid) {
      const checksumFailed = imei.issues.some((i) => /check digit/i.test(i));
      flags.add(checksumFailed ? QUALITY_FLAGS.IMEI_CHECKSUM_FAILED : QUALITY_FLAGS.MALFORMED_IMEI);
      warnings.add(
        checksumFailed ? QUALITY_FLAGS.IMEI_CHECKSUM_FAILED : QUALITY_FLAGS.MALFORMED_IMEI,
        'WARNING',
        `IMEI values failed validation. Example issue: ${imei.issues[0] ?? 'unknown'}.`,
        row.row,
      );
    }

    const hasIdentifier = Boolean(
      msisdn?.normalized || imsi?.normalized || imei?.normalized || iccid?.normalized || esn?.normalized || meid?.normalized,
    );
    if (!hasIdentifier) {
      flags.add(QUALITY_FLAGS.MISSING_IDENTIFIERS);
      rejections.push({
        row: row.row,
        reason: 'The row contained no usable device or subscriber identifier, so it cannot be attributed to any device.',
        raw: row.raw,
      });
      warnings.add(
        QUALITY_FLAGS.MISSING_IDENTIFIERS,
        'ERROR',
        'Rows with no usable identifier cannot be attributed to a device and were not imported as events.',
        row.row,
      );
      continue;
    }

    // --- network ---------------------------------------------------------
    const rawCellId = read(definition.fields.rawCellId, row, headers, index);
    const siteId = read(definition.fields.siteId, row, headers, index);
    const sectorId = read(definition.fields.sectorId, row, headers, index);

    if (!rawCellId && !siteId) {
      flags.add(QUALITY_FLAGS.MISSING_CELL_REFERENCE);
      warnings.add(
        QUALITY_FLAGS.MISSING_CELL_REFERENCE,
        'ERROR',
        'Rows with no cell or site reference cannot be placed on the map.',
        row.row,
      );
    }

    const siteKey = siteId ? cellSiteKey(definition.carrier, siteId) : undefined;
    const sectorKey = siteKey && sectorId ? cellSectorKey(siteKey, sectorId) : undefined;
    if (!sectorKey && (rawCellId || siteId)) {
      flags.add(QUALITY_FLAGS.UNRESOLVED_CELL_ID);
    }

    // --- event semantics -------------------------------------------------
    const eventKind = codeLookup<EventKind>(
      read(definition.fields.eventKind, row, headers, index),
      definition.eventKindMap,
      'UNKNOWN',
    );
    const direction = codeLookup<EventDirection>(
      read(definition.fields.direction, row, headers, index),
      definition.directionMap,
      'UNKNOWN',
    );
    const technology = codeLookup<RadioTechnology>(
      read(definition.fields.technology, row, headers, index),
      definition.technologyMap,
      'UNKNOWN',
    );

    const durationSec = numeric(read(definition.fields.durationSec, row, headers, index));
    if (durationSec !== undefined && durationSec < 0) {
      flags.add(QUALITY_FLAGS.NEGATIVE_DURATION);
      warnings.add(QUALITY_FLAGS.NEGATIVE_DURATION, 'WARNING', 'Some records have a negative duration.', row.row);
    }

    const rawOtherParty = read(definition.fields.otherParty, row, headers, index);
    const otherParty = rawOtherParty ? normalizeMsisdn(rawOtherParty) : undefined;

    // --- radio measurements ----------------------------------------------
    const timingAdvance = numeric(read(definition.fields.timingAdvance, row, headers, index));
    if (timingAdvance !== undefined) {
      const max = technology === 'GSM' ? 63 : technology === 'LTE' ? 1282 : technology === 'NR' ? 3846 : undefined;
      if (timingAdvance < 0 || (max !== undefined && timingAdvance > max)) {
        flags.add(QUALITY_FLAGS.TIMING_ADVANCE_OUT_OF_RANGE);
        warnings.add(
          QUALITY_FLAGS.TIMING_ADVANCE_OUT_OF_RANGE,
          'WARNING',
          `Timing advance values fall outside the valid range for the stated technology ` +
            `(${technology}). They are retained but excluded from distance calculation.`,
          row.row,
        );
      }
    }

    // --- unmapped columns are retained ------------------------------------
    let unmappedFields: Record<string, string> | undefined;
    for (const { header, position } of unmappedIndices) {
      const value = row.fields[position]?.trim();
      if (value) {
        unmappedFields ??= {};
        unmappedFields[header] = value;
      }
    }
    if (unmappedFields) flags.add(QUALITY_FLAGS.UNMAPPED_COLUMNS);

    const eventId = deterministicRecordId([
      ctx.sourceFileId,
      row.row,
      rowHash,
    ]);

    events.push({
      eventId,
      caseId: ctx.caseId,
      packageId: ctx.packageId,
      sourceFileId: ctx.sourceFileId,
      sourceRow: row.row,
      ...(ctx.sourceSheet ? { sourceSheet: ctx.sourceSheet } : {}),
      rowHash,
      parserId: definition.id,
      parserVersion: definition.version,
      carrier: definition.carrier,
      recordType: definition.recordType,

      ...(time.utc ? { tsUtc: time.utc } : {}),
      ...(time.epochMs !== undefined ? { tsEpochMs: time.epochMs } : {}),
      tsOriginal: time.original,
      tsSourceZone: time.sourceZone,
      tsMethod: time.method,
      tsConfidence: time.confidence,

      ...(msisdn?.normalized ? { msisdn: msisdn.normalized } : {}),
      ...(imsi?.normalized ? { imsi: imsi.normalized } : {}),
      ...(imei?.normalized ? { imei: imei.normalized } : {}),
      ...(iccid?.normalized ? { iccid: iccid.normalized } : {}),
      ...(esn?.normalized ? { esn: esn.normalized } : {}),
      ...(meid?.normalized ? { meid: meid.normalized } : {}),

      ...(siteKey ? { cellSiteKey: siteKey } : {}),
      ...(sectorKey ? { sectorKey } : {}),
      ...(rawCellId ? { rawCellId } : {}),
      ...(sectorId ? { sectorId } : {}),
      ...(read(definition.fields.lac, row, headers, index) ? { lac: read(definition.fields.lac, row, headers, index)! } : {}),
      ...(read(definition.fields.tac, row, headers, index) ? { tac: read(definition.fields.tac, row, headers, index)! } : {}),
      ...(read(definition.fields.enodebId, row, headers, index) ? { enodebId: read(definition.fields.enodebId, row, headers, index)! } : {}),
      technology,
      ...(read(definition.fields.band, row, headers, index) ? { band: read(definition.fields.band, row, headers, index)! } : {}),

      eventKind,
      direction,
      ...(durationSec !== undefined ? { durationSec } : {}),
      ...(otherParty?.normalized ? { otherParty: otherParty.normalized } : {}),
      ...(rawOtherParty ? { otherPartyRaw: rawOtherParty } : {}),

      ...(timingAdvance !== undefined ? { timingAdvance } : {}),
      ...(numeric(read(definition.fields.rttRaw, row, headers, index)) !== undefined
        ? { rttRaw: numeric(read(definition.fields.rttRaw, row, headers, index))! }
        : {}),
      ...(numeric(read(definition.fields.rsrp, row, headers, index)) !== undefined
        ? { rsrp: numeric(read(definition.fields.rsrp, row, headers, index))! }
        : {}),

      qualityFlags: [...flags],
      ...(unmappedFields ? { unmappedFields } : {}),
    });
  }

  if (unmappedColumns.length > 0) {
    warnings.add(
      QUALITY_FLAGS.UNMAPPED_COLUMNS,
      'INFO',
      `${unmappedColumns.length} column(s) were not recognised by this parser and have been retained ` +
        `against each record without interpretation: ${unmappedColumns.join(', ')}.`,
      document.headerRow.row,
    );
  }

  return {
    events,
    warnings: warnings.toWarnings(),
    rowsRead: document.rows.length,
    rowsRejected: rejections.length,
    rejections,
    unmappedColumns,
  };
}

/** Normalize a cell site list into sector records. */
export function normalizeSectors(
  definition: ParserDefinition,
  source: string | TabularDocument,
): { sectors: ParsedSector[]; warnings: ImportWarning[]; rowsRead: number } {
  const document: TabularDocument =
    typeof source === 'string'
      ? readTabular(source, { ...(definition.delimiter ? { delimiter: definition.delimiter } : {}) })
      : source;
  const { headers } = document;
  const index = headerIndex(headers);
  const warnings = new WarningCollector();
  const sectors: ParsedSector[] = [];
  const seenPositions = new Map<string, string>();

  for (const row of document.rows) {
    const flags = new Set<QualityFlag>();
    const lat = numeric(read(definition.fields.reportedLat, row, headers, index));
    const lon = numeric(read(definition.fields.reportedLon, row, headers, index));
    const siteId = read(definition.fields.siteId, row, headers, index);
    const sectorId = read(definition.fields.sectorId, row, headers, index);

    if (lat === undefined || lon === undefined) {
      warnings.add('MISSING_COORDINATES', 'ERROR', 'Cell site rows without coordinates cannot be mapped.', row.row);
      continue;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      flags.add(QUALITY_FLAGS.COORDINATE_OUT_OF_RANGE);
      warnings.add(QUALITY_FLAGS.COORDINATE_OUT_OF_RANGE, 'ERROR', 'Cell site coordinates fall outside valid latitude/longitude bounds.', row.row);
      continue;
    }
    if (lat === 0 && lon === 0) {
      flags.add(QUALITY_FLAGS.NULL_ISLAND_COORDINATE);
      warnings.add(QUALITY_FLAGS.NULL_ISLAND_COORDINATE, 'WARNING', 'Cell sites are located at exactly 0,0, which is a missing-value placeholder rather than a real position.', row.row);
    }
    if (!siteId || !sectorId) {
      warnings.add('MISSING_SITE_OR_SECTOR', 'ERROR', 'Cell site rows must identify both a site and a sector to be usable.', row.row);
      continue;
    }

    const siteKey = cellSiteKey(definition.carrier, siteId);
    const sectorKey = cellSectorKey(siteKey, sectorId);

    const positionKey = `${lat.toFixed(6)},${lon.toFixed(6)}`;
    const existing = seenPositions.get(positionKey);
    if (existing && existing !== siteKey) {
      warnings.add(
        'DUPLICATE_SITE_COORDINATES',
        'WARNING',
        `Two different sites share identical coordinates (${existing} and ${siteKey}). This is ` +
          `usually a carrier data defect and will distort any distance analysis involving them.`,
        row.row,
      );
    } else {
      seenPositions.set(positionKey, siteKey);
    }

    const azimuth = numeric(read(definition.fields.azimuthDegrees, row, headers, index));
    const beamWidth = numeric(read(definition.fields.beamWidthDegrees, row, headers, index));
    if (azimuth === undefined) {
      warnings.add(
        'MISSING_AZIMUTH',
        'WARNING',
        'Some sectors have no antenna azimuth. They will be drawn as full circles rather than ' +
          'wedges, because their direction is unknown.',
        row.row,
      );
    }
    if (beamWidth === undefined) {
      warnings.add(
        'MISSING_BEAMWIDTH',
        'INFO',
        'Some sectors have no antenna beam width. A nominal width will be drawn and explicitly ' +
          'marked as assumed.',
        row.row,
      );
    }

    sectors.push({
      sectorKey,
      siteKey,
      carrier: definition.carrier,
      siteId,
      sectorId,
      ...(read(definition.fields.rawCellId, row, headers, index)
        ? { rawCellId: read(definition.fields.rawCellId, row, headers, index)! }
        : {}),
      lat,
      lon,
      ...(azimuth !== undefined ? { azimuthDegrees: azimuth } : {}),
      ...(beamWidth !== undefined ? { beamWidthDegrees: beamWidth } : {}),
      ...(read(definition.fields.technology, row, headers, index)
        ? { technology: codeLookup<RadioTechnology>(read(definition.fields.technology, row, headers, index), definition.technologyMap, 'UNKNOWN') }
        : {}),
      ...(read(definition.fields.band, row, headers, index) ? { band: read(definition.fields.band, row, headers, index)! } : {}),
      ...(read(definition.fields.siteName, row, headers, index) ? { siteName: read(definition.fields.siteName, row, headers, index)! } : {}),
      ...(read(definition.fields.siteAddress, row, headers, index) ? { siteAddress: read(definition.fields.siteAddress, row, headers, index)! } : {}),
      sourceRow: row.row,
      rowHash: hashSourceRow(row.raw),
      qualityFlags: [...flags],
    });
  }

  return { sectors, warnings: warnings.toWarnings(), rowsRead: document.rows.length };
}
