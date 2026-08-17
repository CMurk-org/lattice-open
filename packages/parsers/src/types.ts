// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parser definitions.
 *
 * A parser is DATA, not code: a schema fingerprint plus a field map. One engine
 * executes all of them. Adding a carrier means adding a definition, which is
 * what makes the parser layer genuinely pluggable rather than four copies of
 * the same loop.
 */

import type { RecordType, RadioTechnology, EventKind, EventDirection } from '@cmurk/cellular-schema';
import type { Delimiter, TabularRow } from './tabular';

/**
 * How much real-world validation a parser has had.
 *
 * This is surfaced in the import UI and printed in reports. A parser calibrated
 * only against synthetic fixtures must not be presented as if it were validated
 * against genuine productions — that distinction matters when a defence expert
 * asks how the software knew what the columns meant.
 */
export type CalibrationStatus =
  | 'SYNTHETIC_ONLY'
  | 'SAMPLE_CALIBRATED'
  | 'FIELD_CALIBRATED';

export const CALIBRATION_DISPLAY: Record<CalibrationStatus, { label: string; caution: string }> = {
  SYNTHETIC_ONLY: {
    label: 'Not calibrated against real productions',
    caution:
      'This parser has been validated only against synthetic test data. Its column interpretation ' +
      'must be confirmed against a genuine production from this carrier before operational use.',
  },
  SAMPLE_CALIBRATED: {
    label: 'Calibrated against sample productions',
    caution:
      'This parser was calibrated against a limited number of real productions. Carrier formats ' +
      'change; review the import warnings before relying on the result.',
  },
  FIELD_CALIBRATED: {
    label: 'Calibrated against production returns',
    caution: 'Carrier formats change without notice. Review import warnings on every import.',
  },
};

/** Source column(s) for a canonical field. First matching alias wins. */
export interface SourceField {
  /** Header aliases, tried in order. Matching is case- and space-insensitive. */
  readonly columns: readonly string[];
  /** Optional transform applied to the raw cell value before normalization. */
  readonly transform?: (value: string, row: TabularRow, headers: readonly string[]) => string;
  /** When true, the field's absence makes the row unusable. */
  readonly required?: boolean;
}

/** Timestamp assembly: a single column, or separate date/time/zone columns. */
export type TimestampMap =
  | { readonly kind: 'SINGLE'; readonly field: SourceField }
  | {
      readonly kind: 'SPLIT';
      readonly date: SourceField;
      readonly time: SourceField;
      /** Column carrying a per-row timezone, when the carrier provides one. */
      readonly zone?: SourceField;
    };

export interface FieldMap {
  readonly timestamp: TimestampMap;
  readonly timestampEnd?: TimestampMap;
  readonly msisdn?: SourceField;
  readonly imsi?: SourceField;
  readonly imei?: SourceField;
  readonly iccid?: SourceField;
  readonly esn?: SourceField;
  readonly meid?: SourceField;
  readonly carrierSubscriberId?: SourceField;
  readonly carrierDeviceId?: SourceField;
  readonly rawCellId?: SourceField;
  readonly siteId?: SourceField;
  readonly sectorId?: SourceField;
  readonly lac?: SourceField;
  readonly tac?: SourceField;
  readonly enodebId?: SourceField;
  readonly technology?: SourceField;
  readonly band?: SourceField;
  readonly eventKind?: SourceField;
  readonly direction?: SourceField;
  readonly durationSec?: SourceField;
  readonly otherParty?: SourceField;
  readonly disposition?: SourceField;
  readonly timingAdvance?: SourceField;
  readonly rttRaw?: SourceField;
  readonly rsrp?: SourceField;
  readonly reportedLat?: SourceField;
  readonly reportedLon?: SourceField;
  readonly reportedUncertaintyM?: SourceField;
  readonly reportedLocationMethod?: SourceField;
  readonly azimuthDegrees?: SourceField;
  readonly beamWidthDegrees?: SourceField;
  readonly siteName?: SourceField;
  readonly siteAddress?: SourceField;
}

export interface SchemaFingerprint {
  /** Every one of these headers must be present for the parser to be a candidate. */
  readonly required: readonly string[];
  /** Presence of these raises confidence but is not mandatory. */
  readonly optional?: readonly string[];
  /**
   * Presence of any of these rules the parser OUT. Used to separate formats
   * from the same carrier that share most of their columns.
   */
  readonly forbidden?: readonly string[];
  /** Filename hint. Contributes to confidence; never decisive on its own. */
  readonly filenamePattern?: RegExp;
}

export interface ParserDefinition {
  readonly id: string;
  readonly version: string;
  readonly carrier: string;
  readonly carrierDisplayName: string;
  readonly recordType: RecordType;
  readonly description: string;
  readonly calibration: CalibrationStatus;
  /** Provenance of the format knowledge: which productions it was built from. */
  readonly calibrationNote: string;
  readonly delimiter?: Delimiter;
  readonly skipLines?: number;
  readonly fingerprint: SchemaFingerprint;
  /**
   * Timezone this carrier writes when the file itself does not say.
   * Undefined means the parser refuses to guess and the analyst must declare it.
   */
  readonly defaultTimezone?: string;
  /** Where the default timezone knowledge comes from, printed in reports. */
  readonly timezoneNote: string;
  readonly fields: FieldMap;
  /** Maps carrier event codes onto the canonical vocabulary. */
  readonly eventKindMap?: Readonly<Record<string, EventKind>>;
  readonly directionMap?: Readonly<Record<string, EventDirection>>;
  readonly technologyMap?: Readonly<Record<string, RadioTechnology>>;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface DetectionResult {
  readonly parserId: string;
  readonly parserVersion: string;
  readonly carrier: string;
  readonly carrierDisplayName: string;
  readonly recordType: RecordType;
  readonly calibration: CalibrationStatus;
  /** 0..1. Anything below the acceptance threshold requires analyst review. */
  readonly confidence: number;
  readonly matchedRequired: readonly string[];
  readonly missingRequired: readonly string[];
  readonly matchedOptional: readonly string[];
  /** Columns present in the file that this parser does not map. */
  readonly unmappedColumns: readonly string[];
  /** Per-check breakdown, so the confidence figure is itself explainable. */
  readonly signals: readonly { name: string; weight: number; score: number; detail: string }[];
  readonly notes: readonly string[];
}

export interface ImportWarning {
  readonly code: string;
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly message: string;
  readonly count: number;
  /** Row numbers of the first few occurrences, for the review UI. */
  readonly sampleRows: readonly number[];
}
