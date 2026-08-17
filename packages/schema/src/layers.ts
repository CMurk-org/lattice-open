// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The three-layer evidence model.
 *
 * This is the single most important type in the system. Every value that can
 * reach an investigator's screen or a report is wrapped in an `Assertion`,
 * and every `Assertion` declares which layer it belongs to.
 *
 * The system must NEVER present an inferred location or relationship as an
 * established fact. The type system is the first line of defence: there is no
 * way to construct an `Assertion` without declaring its layer and its basis.
 */

import type { ProvenanceRef } from './provenance';
import type { MethodRef } from './method';
import type { Explanation } from './explain';

/**
 * OBSERVED           — directly contained in source evidence.
 *                      e.g. "IMSI X was recorded by Cell 123 / Sector B at 22:31:42."
 *
 * CALCULATED         — deterministically derived from source evidence by a
 *                      versioned algorithm. Reproducible bit-for-bit.
 *                      e.g. "This timing advance yields a 554–1108 m distance band."
 *
 * INFERRED           — suggested by statistical or analytical modelling. Carries
 *                      confidence and always carries an explanation.
 *                      e.g. "Six observations make this corridor the most likely path."
 *
 * ANALYST_ASSERTED   — entered by a human analyst, not derived from carrier data.
 *                      Tracked separately so reports can distinguish analyst input
 *                      from carrier-supplied material.
 */
export const EVIDENCE_LAYERS = ['OBSERVED', 'CALCULATED', 'INFERRED', 'ANALYST_ASSERTED'] as const;
export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number];

/** Display metadata so every surface renders the layers identically. */
export const LAYER_DISPLAY: Record<
  EvidenceLayer,
  { label: string; reportLabel: string; short: string; description: string }
> = {
  OBSERVED: {
    label: 'Observed',
    reportLabel: 'Carrier supplied',
    short: 'OBS',
    description: 'Directly recorded in the source evidence produced by the carrier.',
  },
  CALCULATED: {
    label: 'Calculated',
    reportLabel: 'Calculated',
    short: 'CALC',
    description: 'Deterministically derived from source evidence by a versioned algorithm.',
  },
  INFERRED: {
    label: 'Inferred',
    reportLabel: 'System inferred',
    short: 'INF',
    description: 'Suggested by analytical modelling. Not an established fact.',
  },
  ANALYST_ASSERTED: {
    label: 'Analyst entered',
    reportLabel: 'Analyst entered',
    short: 'ANL',
    description: 'Entered by an analyst; not derived from carrier records.',
  },
};

/** Ordering used when a composite value must adopt its weakest constituent layer. */
const LAYER_STRENGTH: Record<EvidenceLayer, number> = {
  OBSERVED: 3,
  CALCULATED: 2,
  ANALYST_ASSERTED: 1,
  INFERRED: 0,
};

/**
 * Statistical confidence. Only meaningful for INFERRED assertions.
 * `score` is a 0..1 model-internal score; it is NOT a probability of guilt,
 * a probability that a person was present, or any other legal quantity.
 */
export interface Confidence {
  readonly score: number;
  readonly band: 'LOW' | 'MODERATE' | 'HIGH';
  /** What the score actually measures, in plain language, for the report. */
  readonly meaning: string;
  /** Number of independent supporting observations behind the score. */
  readonly supportingObservations: number;
}

export type UncertaintyKind =
  | 'RADIAL_METERS'
  | 'DISTANCE_BAND_METERS'
  | 'SECTOR_WEDGE'
  | 'PROBABILITY_SURFACE'
  | 'TIME_SECONDS'
  | 'CATEGORICAL';

/** Explicit, never-implied uncertainty. Absence of this field means "unquantified". */
export interface Uncertainty {
  readonly kind: UncertaintyKind;
  /** Lower/upper bounds in the unit implied by `kind`, where applicable. */
  readonly min?: number;
  readonly max?: number;
  /** Human-readable statement for reports, e.g. "±1 timing-advance step (554 m)". */
  readonly statement: string;
  /**
   * True when the underlying record did not carry enough precision to bound the
   * value at all. Renderers must show this prominently rather than showing a
   * spuriously tidy number.
   */
  readonly unbounded?: boolean;
}

/**
 * A value plus everything needed to defend it.
 *
 * Construct only through `observed()`, `calculated()`, `inferred()` or
 * `analystAsserted()` — those helpers enforce the per-layer invariants.
 */
export interface Assertion<T> {
  readonly layer: EvidenceLayer;
  readonly value: T;
  /** Where this came from. OBSERVED assertions point at an exact source row. */
  readonly provenance: readonly ProvenanceRef[];
  /** Algorithm identity + version. Required for CALCULATED and INFERRED. */
  readonly method?: MethodRef;
  /** Required for INFERRED. */
  readonly confidence?: Confidence;
  readonly uncertainty?: Uncertainty;
  /** The payload behind the "WHY?" button. Required for INFERRED. */
  readonly explanation?: Explanation;
}

export class AssertionInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionInvariantError';
  }
}

/**
 * Something directly present in the source evidence.
 * Requires at least one provenance reference resolving to a real source row —
 * an observation with no source is a contradiction in terms.
 */
export function observed<T>(
  value: T,
  provenance: ProvenanceRef | readonly ProvenanceRef[],
  opts: { uncertainty?: Uncertainty } = {},
): Assertion<T> {
  const refs = Array.isArray(provenance) ? provenance : [provenance as ProvenanceRef];
  if (refs.length === 0) {
    throw new AssertionInvariantError('OBSERVED assertions require at least one provenance reference');
  }
  for (const ref of refs) {
    if (!ref.sourceFileId || !ref.locator) {
      throw new AssertionInvariantError(
        'OBSERVED assertions must cite a source file and a locator (sheet/row) within it',
      );
    }
  }
  return Object.freeze({
    layer: 'OBSERVED' as const,
    value,
    provenance: Object.freeze([...refs]),
    ...(opts.uncertainty ? { uncertainty: opts.uncertainty } : {}),
  });
}

/**
 * Deterministically derived. Must name the algorithm and version that produced
 * it, and must cite the assertions it consumed.
 */
export function calculated<T>(
  value: T,
  method: MethodRef,
  basis: readonly ProvenanceRef[],
  opts: { uncertainty?: Uncertainty; explanation?: Explanation } = {},
): Assertion<T> {
  if (basis.length === 0) {
    throw new AssertionInvariantError(
      `CALCULATED assertion from ${method.id} must cite the evidence it was derived from`,
    );
  }
  return Object.freeze({
    layer: 'CALCULATED' as const,
    value,
    provenance: Object.freeze([...basis]),
    method,
    ...(opts.uncertainty ? { uncertainty: opts.uncertainty } : {}),
    ...(opts.explanation ? { explanation: opts.explanation } : {}),
  });
}

/**
 * Statistically or analytically suggested. Confidence and explanation are
 * mandatory: an inference an analyst cannot interrogate is not admissible
 * output in this system.
 */
export function inferred<T>(
  value: T,
  method: MethodRef,
  basis: readonly ProvenanceRef[],
  confidence: Confidence,
  explanation: Explanation,
  opts: { uncertainty?: Uncertainty } = {},
): Assertion<T> {
  if (basis.length === 0) {
    throw new AssertionInvariantError(
      `INFERRED assertion from ${method.id} must cite the evidence it was derived from`,
    );
  }
  if (confidence.score < 0 || confidence.score > 1 || !Number.isFinite(confidence.score)) {
    throw new AssertionInvariantError(`Confidence score must be within 0..1, received ${confidence.score}`);
  }
  if (!explanation.reasons.length) {
    throw new AssertionInvariantError(
      `INFERRED assertion from ${method.id} must carry at least one explanation reason`,
    );
  }
  return Object.freeze({
    layer: 'INFERRED' as const,
    value,
    provenance: Object.freeze([...basis]),
    method,
    confidence,
    explanation,
    ...(opts.uncertainty ? { uncertainty: opts.uncertainty } : {}),
  });
}

/** Entered by a human. Attributed to that human, never blended into carrier data. */
export function analystAsserted<T>(
  value: T,
  author: { userId: string; displayName: string },
  at: string,
  note: string,
  provenance: readonly ProvenanceRef[] = [],
): Assertion<T> {
  return Object.freeze({
    layer: 'ANALYST_ASSERTED' as const,
    value,
    provenance: Object.freeze([...provenance]),
    explanation: {
      summary: note,
      reasons: [
        {
          layer: 'ANALYST_ASSERTED' as const,
          statement: `Entered by ${author.displayName} (${author.userId}) at ${at}.`,
        },
      ],
    },
  });
}

/**
 * Combine layers for a composite value. A derived value can never be stronger
 * than its weakest input: one inference anywhere in the chain makes the whole
 * result an inference.
 */
export function weakestLayer(layers: readonly EvidenceLayer[]): EvidenceLayer {
  if (layers.length === 0) return 'INFERRED';
  return layers.reduce((weakest, current) =>
    LAYER_STRENGTH[current] < LAYER_STRENGTH[weakest] ? current : weakest,
  );
}

/** Convenience: is this assertion safe to state as a fact in a report? */
export function isFactual(assertion: Assertion<unknown>): boolean {
  return assertion.layer === 'OBSERVED';
}

/** Collect the full provenance set for a group of assertions, de-duplicated. */
export function collectProvenance(assertions: readonly Assertion<unknown>[]): ProvenanceRef[] {
  const seen = new Map<string, ProvenanceRef>();
  for (const assertion of assertions) {
    for (const ref of assertion.provenance) {
      const key = JSON.stringify([
        ref.caseId,
        ref.packageId,
        ref.sourceFileId,
        ref.locator?.sheet,
        ref.locator?.row,
        ref.recordId,
      ]);
      if (!seen.has(key)) seen.set(key, ref);
    }
  }
  return [...seen.values()];
}

/** Build a Confidence from a score, using the system-wide band thresholds. */
export function confidenceFromScore(
  score: number,
  meaning: string,
  supportingObservations: number,
): Confidence {
  const clamped = Math.min(1, Math.max(0, score));
  const band = clamped >= 0.75 ? 'HIGH' : clamped >= 0.4 ? 'MODERATE' : 'LOW';
  return { score: clamped, band, meaning, supportingObservations };
}
