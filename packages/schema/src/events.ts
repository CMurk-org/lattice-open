// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The canonical cellular event — the high-volume record.
 *
 * Every carrier row, whatever its original shape, becomes one of these. It is
 * deliberately flat and denormalized: this is the row that lands in ClickHouse
 * and gets scanned a hundred million at a time.
 *
 * Note what is NOT here: no latitude/longitude for the device. A sector
 * observation is not a device position, and the schema refuses to provide a
 * field that would invite that mistake. Carrier-*reported* positions live in
 * clearly-named `reported*` fields, and estimated positions are produced only
 * by the location engine, only as regions.
 */

import type { TimeConversionMethod, TimeConfidence } from './time';

export const RADIO_TECHNOLOGIES = [
  'GSM',
  'UMTS',
  'CDMA',
  'LTE',
  'NR',
  'IMS',
  'WIFI',
  'UNKNOWN',
] as const;
export type RadioTechnology = (typeof RADIO_TECHNOLOGIES)[number];

export const EVENT_KINDS = [
  'VOICE',
  'SMS',
  'MMS',
  'DATA',
  'REGISTRATION',
  'LOCATION_UPDATE',
  'HANDOVER',
  'PAGING',
  'SUPPLEMENTARY',
  'UNKNOWN',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const RECORD_TYPES = [
  'TOWER_DUMP',
  'CDR',
  'SUBSCRIBER',
  'CELL_SITE_LIST',
  'TIMING_ADVANCE',
  'PCMD',
  'RTT',
  'NELOS',
  'LOCATION_RECORD',
  'DATA_SESSION',
  'UNKNOWN',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export type EventDirection = 'ORIGINATING' | 'TERMINATING' | 'UNKNOWN';

export interface CellularEvent {
  // --- identity & provenance -------------------------------------------------
  /** Deterministic content hash. Re-importing the same row yields the same id. */
  readonly eventId: string;
  readonly caseId: string;
  readonly packageId: string;
  readonly sourceFileId: string;
  /** 1-based row number in the source file, for VIEW SOURCE. */
  readonly sourceRow: number;
  readonly sourceSheet?: string;
  /** SHA-256 of the exact original row text. Proves the source row is unaltered. */
  readonly rowHash: string;
  readonly parserId: string;
  readonly parserVersion: string;

  readonly carrier: string;
  readonly recordType: RecordType;

  // --- time ------------------------------------------------------------------
  /** Normalized UTC. Absent when the timestamp could not be resolved. */
  readonly tsUtc?: string;
  readonly tsEpochMs?: number;
  /** Verbatim source text. Always present. */
  readonly tsOriginal: string;
  readonly tsSourceZone: string;
  readonly tsMethod: TimeConversionMethod;
  readonly tsConfidence: TimeConfidence;
  /** Event end, for records that carry one (call teardown, session end). */
  readonly tsEndUtc?: string;

  // --- identifiers (normalized; raw forms retained in `raw`) -----------------
  readonly msisdn?: string;
  readonly imsi?: string;
  readonly imei?: string;
  readonly iccid?: string;
  readonly esn?: string;
  readonly meid?: string;
  readonly carrierSubscriberId?: string;
  readonly carrierDeviceId?: string;

  // --- network location ------------------------------------------------------
  /** Canonical site key: `${carrier}:${siteIdentifier}`. */
  readonly cellSiteKey?: string;
  /** Canonical sector key: `${cellSiteKey}:${sectorIdentifier}`. */
  readonly sectorKey?: string;
  /** The cell identifier exactly as the carrier wrote it. */
  readonly rawCellId?: string;
  readonly lac?: string;
  readonly tac?: string;
  readonly enodebId?: string;
  readonly sectorId?: string;
  readonly technology?: RadioTechnology;
  readonly band?: string;
  /** Sector the device moved to, for handover records. */
  readonly targetSectorKey?: string;

  // --- event semantics -------------------------------------------------------
  readonly eventKind: EventKind;
  readonly direction: EventDirection;
  readonly durationSec?: number;
  /** Normalized identifier of the other party, for communication records. */
  readonly otherParty?: string;
  readonly otherPartyRaw?: string;
  /** Carrier's own disposition text, e.g. 'ANSWERED', 'NO ANSWER', 'VOICEMAIL'. */
  readonly disposition?: string;
  readonly bytesUp?: number;
  readonly bytesDown?: number;

  // --- radio measurements (present only when the carrier supplied them) ------
  /** Raw timing advance step count. Interpretation depends on `technology`. */
  readonly timingAdvance?: number;
  /** Round-trip time in chips (UMTS) or as reported; unit recorded in `raw`. */
  readonly rttRaw?: number;
  readonly rttMs?: number;
  readonly rsrp?: number;
  readonly rsrq?: number;
  readonly rscp?: number;
  readonly ecio?: number;
  readonly sinr?: number;
  /** Angle of arrival in degrees true, when the carrier reports it. */
  readonly aoaDegrees?: number;

  // --- carrier-reported position (NOT an inference by this system) -----------
  readonly reportedLat?: number;
  readonly reportedLon?: number;
  /** Carrier's own stated uncertainty radius, in metres. */
  readonly reportedUncertaintyM?: number;
  /** Carrier's own description of how it derived the position, e.g. 'AGPS', 'NELOS'. */
  readonly reportedLocationMethod?: string;
  readonly reportedConfidencePct?: number;

  // --- quality ---------------------------------------------------------------
  /** Data-quality issue codes raised for this row at parse time. */
  readonly qualityFlags: readonly string[];
  /** Columns present in the source row that the parser did not map. */
  readonly unmappedFields?: Readonly<Record<string, string>>;
}

/** The identifier fields, in the order used for correlation preference. */
export const CORRELATION_FIELDS = [
  'imei',
  'imsi',
  'iccid',
  'meid',
  'esn',
  'msisdn',
  'carrierSubscriberId',
  'carrierDeviceId',
] as const;
export type CorrelationField = (typeof CORRELATION_FIELDS)[number];

/** Map a correlation field back to its identifier type. */
export const CORRELATION_FIELD_TYPE: Record<CorrelationField, string> = {
  imei: 'IMEI',
  imsi: 'IMSI',
  iccid: 'ICCID',
  meid: 'MEID',
  esn: 'ESN',
  msisdn: 'MSISDN',
  carrierSubscriberId: 'CARRIER_SUBSCRIBER_ID',
  carrierDeviceId: 'CARRIER_DEVICE_ID',
};

/** Every identifier present on an event, as typed keys. */
export function eventIdentifierKeys(event: CellularEvent): string[] {
  const keys: string[] = [];
  for (const field of CORRELATION_FIELDS) {
    const value = event[field];
    if (value) keys.push(`${CORRELATION_FIELD_TYPE[field]}:${value}`);
  }
  return keys;
}

/**
 * Data-quality flag codes. Every one of these means "an analyst should look",
 * never "the system fixed it".
 */
export const QUALITY_FLAGS = {
  MISSING_TIMESTAMP: 'MISSING_TIMESTAMP',
  UNPARSEABLE_TIMESTAMP: 'UNPARSEABLE_TIMESTAMP',
  ASSUMED_TIMEZONE: 'ASSUMED_TIMEZONE',
  DST_AMBIGUOUS: 'DST_AMBIGUOUS',
  DST_NONEXISTENT: 'DST_NONEXISTENT',
  TIMESTAMP_IN_FUTURE: 'TIMESTAMP_IN_FUTURE',
  TIMESTAMP_IMPLAUSIBLY_OLD: 'TIMESTAMP_IMPLAUSIBLY_OLD',
  MISSING_IDENTIFIERS: 'MISSING_IDENTIFIERS',
  MALFORMED_IMEI: 'MALFORMED_IMEI',
  MALFORMED_IMSI: 'MALFORMED_IMSI',
  MALFORMED_MSISDN: 'MALFORMED_MSISDN',
  IMEI_CHECKSUM_FAILED: 'IMEI_CHECKSUM_FAILED',
  ASSUMED_COUNTRY_CODE: 'ASSUMED_COUNTRY_CODE',
  MISSING_CELL_REFERENCE: 'MISSING_CELL_REFERENCE',
  UNKNOWN_SECTOR: 'UNKNOWN_SECTOR',
  UNRESOLVED_CELL_ID: 'UNRESOLVED_CELL_ID',
  DUPLICATE_ROW: 'DUPLICATE_ROW',
  UNMAPPED_COLUMNS: 'UNMAPPED_COLUMNS',
  NEGATIVE_DURATION: 'NEGATIVE_DURATION',
  COORDINATE_OUT_OF_RANGE: 'COORDINATE_OUT_OF_RANGE',
  NULL_ISLAND_COORDINATE: 'NULL_ISLAND_COORDINATE',
  TIMING_ADVANCE_OUT_OF_RANGE: 'TIMING_ADVANCE_OUT_OF_RANGE',
} as const;
export type QualityFlag = (typeof QUALITY_FLAGS)[keyof typeof QUALITY_FLAGS];

export const QUALITY_FLAG_DESCRIPTIONS: Record<QualityFlag, { severity: 'INFO' | 'WARNING' | 'ERROR'; text: string }> = {
  MISSING_TIMESTAMP: { severity: 'ERROR', text: 'The record carried no timestamp. It cannot take part in time-based analysis.' },
  UNPARSEABLE_TIMESTAMP: { severity: 'ERROR', text: 'The timestamp did not match any known format and was retained verbatim only.' },
  ASSUMED_TIMEZONE: { severity: 'WARNING', text: 'No timezone was stated; one was assumed. Confirm against the production cover letter.' },
  DST_AMBIGUOUS: { severity: 'WARNING', text: 'This local time occurs twice on this date; two UTC interpretations are possible.' },
  DST_NONEXISTENT: { severity: 'WARNING', text: 'This local time does not exist on this date; the declared zone may be wrong.' },
  TIMESTAMP_IN_FUTURE: { severity: 'WARNING', text: 'The timestamp is later than the import time.' },
  TIMESTAMP_IMPLAUSIBLY_OLD: { severity: 'WARNING', text: 'The timestamp predates commercial cellular service.' },
  MISSING_IDENTIFIERS: { severity: 'ERROR', text: 'The record contained no usable device or subscriber identifier.' },
  MALFORMED_IMEI: { severity: 'WARNING', text: 'The IMEI was not a valid length.' },
  MALFORMED_IMSI: { severity: 'WARNING', text: 'The IMSI was not a valid length or had an unrecognised MCC/MNC.' },
  MALFORMED_MSISDN: { severity: 'WARNING', text: 'The phone number could not be normalized to E.164.' },
  IMEI_CHECKSUM_FAILED: { severity: 'WARNING', text: 'The IMEI check digit did not validate.' },
  ASSUMED_COUNTRY_CODE: { severity: 'INFO', text: 'A country code was assumed for a 10-digit number.' },
  MISSING_CELL_REFERENCE: { severity: 'ERROR', text: 'The record had no cell or sector reference and cannot be mapped.' },
  UNKNOWN_SECTOR: { severity: 'WARNING', text: 'The referenced sector is not present in any supplied cell-site list.' },
  UNRESOLVED_CELL_ID: { severity: 'WARNING', text: 'The cell identifier could not be decomposed into site and sector.' },
  DUPLICATE_ROW: { severity: 'INFO', text: 'An identical row was already present in this evidence package.' },
  UNMAPPED_COLUMNS: { severity: 'INFO', text: 'The source row contained columns the parser did not recognise; they were retained.' },
  NEGATIVE_DURATION: { severity: 'WARNING', text: 'The call or session duration was negative.' },
  COORDINATE_OUT_OF_RANGE: { severity: 'ERROR', text: 'A supplied coordinate was outside valid latitude/longitude bounds.' },
  NULL_ISLAND_COORDINATE: { severity: 'WARNING', text: 'A supplied coordinate was exactly 0,0 — almost always a missing-value placeholder.' },
  TIMING_ADVANCE_OUT_OF_RANGE: { severity: 'WARNING', text: 'The timing advance value was outside the valid range for the stated technology.' },
};
