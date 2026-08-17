// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Evidence provenance.
 *
 * The chain every displayed value must be able to walk backwards:
 *
 *   Case → EvidencePackage → SourceFile → Sheet/Table → Row → NormalizedRecord
 *        → Transformation → Analysis → Finding
 *
 * A `ProvenanceRef` is a pointer into that chain. Nothing in this system stores
 * a copy of the source row as the authority — the authority is always the
 * original, hashed, immutable file in object storage. A ref plus a locator is
 * enough to re-extract the exact bytes and prove they have not changed.
 */

export interface SourceLocator {
  /** Path inside an archive, when the file arrived inside a ZIP. */
  readonly container?: string;
  /** Worksheet name, XML table name, PDF page label, or logical table. */
  readonly sheet?: string;
  /** 1-based row number as it appears in the source, including header rows. */
  readonly row: number;
  /** Original column header, when the ref points at a single field. */
  readonly column?: string;
  /** Byte offset of the record start, for delimited/fixed-width sources. */
  readonly byteOffset?: number;
  /** Byte length of the record, when known. */
  readonly byteLength?: number;
}

export interface ProvenanceRef {
  readonly caseId: string;
  readonly packageId?: string;
  readonly sourceFileId?: string;
  readonly locator?: SourceLocator;
  /**
   * SHA-256 of the exact original row text as ingested. Re-reading the source
   * and re-hashing must reproduce this value, or the evidence has changed
   * underneath us and the UI must refuse to display it as verified.
   */
  readonly rowHash?: string;
  /** Canonical id of the normalized record derived from this row. */
  readonly recordId?: string;
  /** Identity + version of the transformation that produced the normalized record. */
  readonly transformId?: string;
  /** The analysis run that consumed the record, when the ref is analytical. */
  readonly analysisRunId?: string;
  /** The finding produced, when the ref is a conclusion. */
  readonly findingId?: string;
}

export type ProvenanceStage =
  | 'CASE'
  | 'EVIDENCE_PACKAGE'
  | 'SOURCE_FILE'
  | 'TABLE'
  | 'SOURCE_ROW'
  | 'NORMALIZED_RECORD'
  | 'TRANSFORMATION'
  | 'ANALYSIS'
  | 'FINDING';

export interface ProvenanceChainNode {
  readonly stage: ProvenanceStage;
  readonly id: string;
  readonly label: string;
  /** Extra display detail, e.g. file hash, parser version, row number. */
  readonly detail?: Record<string, string | number | undefined>;
}

/**
 * Expand a ref into the ordered chain the UI renders in the "VIEW SOURCE"
 * panel. Stages absent from the ref are omitted rather than fabricated.
 */
export function buildProvenanceChain(
  ref: ProvenanceRef,
  labels: Partial<Record<ProvenanceStage, string>> = {},
): ProvenanceChainNode[] {
  const chain: ProvenanceChainNode[] = [
    { stage: 'CASE', id: ref.caseId, label: labels.CASE ?? ref.caseId },
  ];

  if (ref.packageId) {
    chain.push({
      stage: 'EVIDENCE_PACKAGE',
      id: ref.packageId,
      label: labels.EVIDENCE_PACKAGE ?? ref.packageId,
    });
  }
  if (ref.sourceFileId) {
    chain.push({
      stage: 'SOURCE_FILE',
      id: ref.sourceFileId,
      label: labels.SOURCE_FILE ?? ref.sourceFileId,
    });
  }
  if (ref.locator?.sheet) {
    chain.push({
      stage: 'TABLE',
      id: ref.locator.sheet,
      label: labels.TABLE ?? ref.locator.sheet,
      detail: { container: ref.locator.container },
    });
  }
  if (ref.locator) {
    chain.push({
      stage: 'SOURCE_ROW',
      id: `row:${ref.locator.row}`,
      label: labels.SOURCE_ROW ?? `Row ${ref.locator.row}`,
      detail: {
        row: ref.locator.row,
        column: ref.locator.column,
        byteOffset: ref.locator.byteOffset,
        rowHash: ref.rowHash,
      },
    });
  }
  if (ref.recordId) {
    chain.push({
      stage: 'NORMALIZED_RECORD',
      id: ref.recordId,
      label: labels.NORMALIZED_RECORD ?? ref.recordId,
    });
  }
  if (ref.transformId) {
    chain.push({
      stage: 'TRANSFORMATION',
      id: ref.transformId,
      label: labels.TRANSFORMATION ?? ref.transformId,
    });
  }
  if (ref.analysisRunId) {
    chain.push({
      stage: 'ANALYSIS',
      id: ref.analysisRunId,
      label: labels.ANALYSIS ?? ref.analysisRunId,
    });
  }
  if (ref.findingId) {
    chain.push({ stage: 'FINDING', id: ref.findingId, label: labels.FINDING ?? ref.findingId });
  }

  return chain;
}

/** Stable de-duplication key for a ref. */
export function provenanceKey(ref: ProvenanceRef): string {
  return [
    ref.caseId,
    ref.packageId ?? '',
    ref.sourceFileId ?? '',
    ref.locator?.container ?? '',
    ref.locator?.sheet ?? '',
    ref.locator?.row ?? '',
    ref.locator?.column ?? '',
    ref.recordId ?? '',
    ref.analysisRunId ?? '',
    ref.findingId ?? '',
  ].join('|');
}

/** Narrow a ref to the row it points at, dropping analytical stages. */
export function toSourceRowRef(ref: ProvenanceRef): ProvenanceRef {
  return {
    caseId: ref.caseId,
    ...(ref.packageId ? { packageId: ref.packageId } : {}),
    ...(ref.sourceFileId ? { sourceFileId: ref.sourceFileId } : {}),
    ...(ref.locator ? { locator: ref.locator } : {}),
    ...(ref.rowHash ? { rowHash: ref.rowHash } : {}),
    ...(ref.recordId ? { recordId: ref.recordId } : {}),
  };
}

/** Result of re-reading a source row to verify it still matches what we ingested. */
export interface ProvenanceVerification {
  readonly ref: ProvenanceRef;
  readonly status: 'VERIFIED' | 'HASH_MISMATCH' | 'SOURCE_UNAVAILABLE' | 'NO_HASH_RECORDED';
  readonly expectedRowHash?: string;
  readonly actualRowHash?: string;
  /** Exact original text of the row, when it could be re-read. */
  readonly rawRow?: string;
  readonly message: string;
}
