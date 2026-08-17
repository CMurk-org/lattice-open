// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from 'vitest';
import { normalizeTimestamp, canonicalZone, windowAround, makeWindow, windowContains } from './time';

describe('normalizeTimestamp — original preservation', () => {
  it('never alters the original text, even when unparseable', () => {
    const weird = 'not a timestamp at all';
    const result = normalizeTimestamp(weird);
    expect(result.original).toBe(weird);
    expect(result.utc).toBeUndefined();
    expect(result.confidence).toBe('UNRESOLVED');
    expect(result.method).toBe('UNRESOLVED');
  });

  it('preserves surrounding whitespace-trimmed original for valid values', () => {
    const result = normalizeTimestamp('  2024-03-15 22:31:42  ', { packageZone: 'America/Chicago' });
    expect(result.original).toBe('2024-03-15 22:31:42');
    expect(result.utc).toBe('2024-03-16T03:31:42.000Z');
  });
});

describe('normalizeTimestamp — explicit offsets are exact', () => {
  it('honours an explicit offset in the source text', () => {
    const result = normalizeTimestamp('2024-03-15T22:31:42-05:00', { packageZone: 'America/Los_Angeles' });
    expect(result.confidence).toBe('EXACT');
    expect(result.method).toBe('SOURCE_EXPLICIT_OFFSET');
    expect(result.utc).toBe('2024-03-16T03:31:42.000Z');
  });

  it('ignores the package zone when the row carries its own offset', () => {
    const withPackageZone = normalizeTimestamp('2024-06-01T12:00:00+02:00', { packageZone: 'America/New_York' });
    const withoutPackageZone = normalizeTimestamp('2024-06-01T12:00:00+02:00');
    expect(withPackageZone.utc).toBe(withoutPackageZone.utc);
    expect(withPackageZone.utc).toBe('2024-06-01T10:00:00.000Z');
  });

  it('treats a trailing Z as UTC', () => {
    const result = normalizeTimestamp('2024-03-15T22:31:42Z');
    expect(result.utc).toBe('2024-03-15T22:31:42.000Z');
    expect(result.confidence).toBe('EXACT');
  });
});

describe('normalizeTimestamp — zone provenance', () => {
  it('records a package-declared zone as ZONE_DECLARED, not assumed', () => {
    const result = normalizeTimestamp('03/15/2024 10:31:42 PM', { packageZone: 'America/Chicago' });
    expect(result.method).toBe('PACKAGE_DECLARED_ZONE');
    expect(result.confidence).toBe('ZONE_DECLARED');
    expect(result.sourceZone).toBe('America/Chicago');
    expect(result.utc).toBe('2024-03-16T03:31:42.000Z');
  });

  it('flags a carrier-default zone as assumed and warns', () => {
    const result = normalizeTimestamp('2024-03-15 22:31:42', { carrierDefaultZone: 'America/New_York' });
    expect(result.method).toBe('CARRIER_DOCUMENTED_DEFAULT');
    expect(result.confidence).toBe('ZONE_ASSUMED');
    expect(result.warning).toMatch(/cover letter/i);
  });

  it('falls back to UTC with a loud warning when nothing declares a zone', () => {
    const result = normalizeTimestamp('2024-03-15 22:31:42');
    expect(result.method).toBe('ASSUMED_UTC');
    expect(result.confidence).toBe('ZONE_ASSUMED');
    expect(result.warning).toMatch(/no timezone was stated/i);
  });

  it('prefers a row-level zone over the package zone', () => {
    const result = normalizeTimestamp('2024-03-15 22:31:42', {
      rowZone: 'America/Denver',
      packageZone: 'America/New_York',
    });
    expect(result.sourceZone).toBe('America/Denver');
    expect(result.method).toBe('SOURCE_DECLARED_ZONE');
  });

  it('reads a zone abbreviation from the timestamp text itself', () => {
    const result = normalizeTimestamp('2024-03-15 22:31:42 CST', { packageZone: 'America/Los_Angeles' });
    expect(result.sourceZone).toBe('America/Chicago');
    expect(result.method).toBe('SOURCE_DECLARED_ZONE');
    expect(result.utc).toBe('2024-03-16T03:31:42.000Z');
  });
});

describe('normalizeTimestamp — DST hazards are surfaced, never silently resolved', () => {
  // US DST 2024: forward 2024-03-10 02:00, back 2024-11-03 02:00.

  it('flags a local time that occurs twice on the fall-back date', () => {
    const result = normalizeTimestamp('2024-11-03 01:30:00', { packageZone: 'America/New_York' });
    expect(result.confidence).toBe('DST_AMBIGUOUS');
    expect(result.alternatives).toHaveLength(2);
    expect(result.alternatives?.[0]).not.toBe(result.alternatives?.[1]);
    expect(result.warning).toMatch(/occurs twice/i);
  });

  it('flags a local time that does not exist on the spring-forward date', () => {
    const result = normalizeTimestamp('2024-03-10 02:30:00', { packageZone: 'America/New_York' });
    expect(result.confidence).toBe('DST_NONEXISTENT');
    expect(result.warning).toMatch(/does not exist/i);
  });

  it('does not flag ordinary times near but not inside a transition', () => {
    const before = normalizeTimestamp('2024-11-03 04:30:00', { packageZone: 'America/New_York' });
    expect(before.confidence).toBe('ZONE_DECLARED');
    const after = normalizeTimestamp('2024-03-10 04:30:00', { packageZone: 'America/New_York' });
    expect(after.confidence).toBe('ZONE_DECLARED');
  });

  it('does not flag DST hazards for a fixed-offset zone', () => {
    const result = normalizeTimestamp('2024-11-03 01:30:00', { packageZone: 'UTC' });
    expect(result.confidence).toBe('ZONE_DECLARED');
  });
});

describe('normalizeTimestamp — carrier formats', () => {
  const cases: [string, string, string][] = [
    ['SQL datetime', '2024-03-15 22:31:42', '2024-03-16T03:31:42.000Z'],
    ['US 12-hour', '03/15/2024 10:31:42 PM', '2024-03-16T03:31:42.000Z'],
    ['US 24-hour', '03/15/2024 22:31:42', '2024-03-16T03:31:42.000Z'],
    ['compact numeric', '20240315223142', '2024-03-16T03:31:42.000Z'],
    ['dashed US', '03-15-2024 22:31:42', '2024-03-16T03:31:42.000Z'],
    ['ISO T-separated', '2024-03-15T22:31:42', '2024-03-16T03:31:42.000Z'],
    ['SQL with millis', '2024-03-15 22:31:42.000', '2024-03-16T03:31:42.000Z'],
  ];

  for (const [label, input, expected] of cases) {
    it(`parses ${label}: ${input}`, () => {
      const result = normalizeTimestamp(input, { packageZone: 'America/Chicago' });
      expect(result.utc, `${label} failed`).toBe(expected);
      expect(result.matchedFormat).toBeDefined();
    });
  }

  it('parses Oracle-style timestamps carriers emit from database exports', () => {
    const result = normalizeTimestamp('15-MAR-24 10.31.42.000000 PM', { packageZone: 'America/Chicago' });
    expect(result.utc).toBe('2024-03-16T03:31:42.000Z');
  });

  it('records which format matched so parsing is auditable', () => {
    const result = normalizeTimestamp('03/15/2024 10:31:42 PM', { packageZone: 'UTC' });
    expect(result.matchedFormat).toBe('US 12-hour');
  });
});

describe('normalizeTimestamp — epoch handling', () => {
  it('treats a 10-digit value as epoch seconds', () => {
    const result = normalizeTimestamp('1710545502');
    expect(result.utc).toBe('2024-03-15T23:31:42.000Z');
    expect(result.method).toBe('NATIVE_UTC');
    expect(result.confidence).toBe('EXACT');
  });

  it('treats a 13-digit value as epoch milliseconds', () => {
    const result = normalizeTimestamp('1710545502000');
    expect(result.utc).toBe('2024-03-15T23:31:42.000Z');
    expect(result.epochMs).toBe(1710545502000);
  });

  it('does not mistake a 14-digit compact timestamp for an epoch', () => {
    const result = normalizeTimestamp('20240315223142', { packageZone: 'UTC' });
    expect(result.matchedFormat).toBe('Compact numeric');
    expect(result.utc).toBe('2024-03-15T22:31:42.000Z');
  });
});

describe('normalizeTimestamp — day-first productions', () => {
  it('reads 05/03/2024 as 5 March when dayFirst is set', () => {
    const result = normalizeTimestamp('05/03/2024 14:00:00', { packageZone: 'UTC', dayFirst: true });
    expect(result.utc).toBe('2024-03-05T14:00:00.000Z');
  });

  it('reads 05/03/2024 as 3 May by default', () => {
    const result = normalizeTimestamp('05/03/2024 14:00:00', { packageZone: 'UTC' });
    expect(result.utc).toBe('2024-05-03T14:00:00.000Z');
  });
});

describe('canonicalZone', () => {
  it('maps carrier abbreviations to IANA zones', () => {
    expect(canonicalZone('CST')).toBe('America/Chicago');
    expect(canonicalZone('pst')).toBe('America/Los_Angeles');
    expect(canonicalZone('GMT')).toBe('UTC');
  });

  it('accepts IANA zones directly', () => {
    expect(canonicalZone('America/Phoenix')).toBe('America/Phoenix');
  });

  it('accepts fixed offsets in several notations', () => {
    expect(canonicalZone('UTC-5')).toBe('UTC-5');
    expect(canonicalZone('-05:00')).toBe('UTC-5');
    expect(canonicalZone('GMT+0530')).toBe('UTC+5:30');
  });

  it('rejects nonsense', () => {
    expect(canonicalZone('Middle Earth')).toBeUndefined();
    expect(canonicalZone('')).toBeUndefined();
  });
});

describe('time windows', () => {
  it('builds a window around an incident instant', () => {
    const w = windowAround('2024-03-15T22:22:00.000Z', 27, 23, 'Incident A');
    expect(w.startUtc).toBe('2024-03-15T21:55:00.000Z');
    expect(w.endUtc).toBe('2024-03-15T22:45:00.000Z');
    expect(w.label).toBe('Incident A');
  });

  it('rejects an inverted window rather than silently swapping it', () => {
    expect(() => makeWindow('2024-03-15T22:00:00Z', '2024-03-15T21:00:00Z')).toThrow(/after its end/);
  });

  it('tests containment inclusively at both bounds', () => {
    const w = makeWindow('2024-03-15T21:55:00.000Z', '2024-03-15T22:45:00.000Z');
    expect(windowContains(w, '2024-03-15T21:55:00.000Z')).toBe(true);
    expect(windowContains(w, '2024-03-15T22:45:00.000Z')).toBe(true);
    expect(windowContains(w, '2024-03-15T22:45:00.001Z')).toBe(false);
    expect(windowContains(w, '2024-03-15T21:54:59.999Z')).toBe(false);
  });
});
