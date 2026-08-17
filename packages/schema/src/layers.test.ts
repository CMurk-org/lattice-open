// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from 'vitest';
import {
  observed,
  calculated,
  inferred,
  analystAsserted,
  weakestLayer,
  isFactual,
  collectProvenance,
  confidenceFromScore,
  AssertionInvariantError,
} from './layers';
import { explanation, reason } from './explain';
import type { ProvenanceRef } from './provenance';

const sourceRef: ProvenanceRef = {
  caseId: 'case_1',
  packageId: 'pkg_1',
  sourceFileId: 'file_1',
  locator: { sheet: 'Sheet1', row: 42 },
  rowHash: 'a'.repeat(64),
};

const method = { id: 'test.method', version: '1.0.0' };

describe('observed()', () => {
  it('accepts a value that cites a real source row', () => {
    const a = observed('Cell 123 / Sector B', sourceRef);
    expect(a.layer).toBe('OBSERVED');
    expect(a.value).toBe('Cell 123 / Sector B');
    expect(isFactual(a)).toBe(true);
  });

  it('refuses an observation with no provenance at all', () => {
    expect(() => observed('anything', [])).toThrow(AssertionInvariantError);
  });

  it('refuses an observation that cannot point at a source row', () => {
    expect(() => observed('anything', { caseId: 'case_1' })).toThrow(/source file and a locator/);
    expect(() => observed('anything', { caseId: 'case_1', sourceFileId: 'file_1' })).toThrow(/locator/);
  });

  it('freezes the assertion so downstream code cannot mutate evidence', () => {
    const a = observed('value', sourceRef);
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { value: string }).value = 'tampered';
    }).toThrow();
  });
});

describe('calculated()', () => {
  it('requires a method and the evidence it consumed', () => {
    const a = calculated(1108, method, [sourceRef], {
      uncertainty: { kind: 'DISTANCE_BAND_METERS', min: 554, max: 1108, statement: '±1 TA step' },
    });
    expect(a.layer).toBe('CALCULATED');
    expect(a.method).toEqual(method);
    expect(a.uncertainty?.min).toBe(554);
    expect(isFactual(a)).toBe(false);
  });

  it('refuses a calculation that cites no evidence', () => {
    expect(() => calculated(1, method, [])).toThrow(/must cite the evidence/);
  });
});

describe('inferred()', () => {
  const conf = confidenceFromScore(0.8, 'Share of incident windows containing this identifier', 4);
  const exp = explanation('Present in four of five incident datasets.', [
    reason('OBSERVED', 'Observed in Incident A.', { provenance: [sourceRef] }),
  ]);

  it('requires confidence and an explanation', () => {
    const a = inferred('likely corridor', method, [sourceRef], conf, exp);
    expect(a.layer).toBe('INFERRED');
    expect(a.confidence?.band).toBe('HIGH');
    expect(a.explanation?.reasons).toHaveLength(1);
  });

  it('refuses an inference with an empty explanation', () => {
    const empty = { summary: 'because', reasons: [] };
    expect(() => inferred('x', method, [sourceRef], conf, empty)).toThrow(/explanation reason/);
  });

  it('refuses an out-of-range confidence score', () => {
    const bad = { ...conf, score: 1.5 };
    expect(() => inferred('x', method, [sourceRef], bad, exp)).toThrow(/within 0\.\.1/);
    const nan = { ...conf, score: Number.NaN };
    expect(() => inferred('x', method, [sourceRef], nan, exp)).toThrow(/within 0\.\.1/);
  });

  it('refuses an inference that cites no evidence', () => {
    expect(() => inferred('x', method, [], conf, exp)).toThrow(/must cite the evidence/);
  });
});

describe('analystAsserted()', () => {
  it('attributes the value to the human who entered it', () => {
    const a = analystAsserted('Suspect vehicle seen here', { userId: 'usr_9', displayName: 'Det. Rivera' }, '2024-03-16T10:00:00Z', 'From witness statement');
    expect(a.layer).toBe('ANALYST_ASSERTED');
    expect(a.explanation?.reasons[0]?.statement).toMatch(/Det\. Rivera/);
    expect(a.explanation?.reasons[0]?.statement).toMatch(/usr_9/);
  });
});

describe('weakestLayer()', () => {
  it('lets one inference downgrade an otherwise observed chain', () => {
    expect(weakestLayer(['OBSERVED', 'OBSERVED', 'INFERRED'])).toBe('INFERRED');
  });

  it('downgrades observed+calculated to calculated', () => {
    expect(weakestLayer(['OBSERVED', 'CALCULATED'])).toBe('CALCULATED');
  });

  it('keeps a purely observed chain observed', () => {
    expect(weakestLayer(['OBSERVED', 'OBSERVED'])).toBe('OBSERVED');
  });

  it('treats an empty chain as inferred rather than as fact', () => {
    expect(weakestLayer([])).toBe('INFERRED');
  });
});

describe('confidenceFromScore()', () => {
  it('bands scores consistently', () => {
    expect(confidenceFromScore(0.9, 'm', 1).band).toBe('HIGH');
    expect(confidenceFromScore(0.5, 'm', 1).band).toBe('MODERATE');
    expect(confidenceFromScore(0.1, 'm', 1).band).toBe('LOW');
  });

  it('clamps rather than emitting an impossible score', () => {
    expect(confidenceFromScore(2, 'm', 1).score).toBe(1);
    expect(confidenceFromScore(-1, 'm', 1).score).toBe(0);
  });

  it('always carries a plain-language meaning for the report', () => {
    const c = confidenceFromScore(0.8, 'Share of incident windows containing this identifier', 4);
    expect(c.meaning).toMatch(/incident windows/);
    expect(c.supportingObservations).toBe(4);
  });
});

describe('collectProvenance()', () => {
  it('de-duplicates references across assertions', () => {
    const a = observed('x', sourceRef);
    const b = observed('y', sourceRef);
    const other: ProvenanceRef = { ...sourceRef, locator: { sheet: 'Sheet1', row: 43 } };
    const c = observed('z', other);
    expect(collectProvenance([a, b, c])).toHaveLength(2);
  });
});
