// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from 'vitest';
import {
  normalizeMsisdn,
  normalizeImsi,
  normalizeImei,
  normalizeIccid,
  luhnCheckDigit,
  inferIdentifierType,
  identifierKey,
  parseIdentifierKey,
  displayIdentifier,
  isNullToken,
} from './identifiers';

describe('normalizeMsisdn — cross-carrier correlation', () => {
  it('collapses the formats three carriers use for one number', () => {
    const forms = ['+1 (555) 010-1234', '5550101234', '1-555-010-1234', '15550101234', '+15550101234'];
    const normalized = forms.map((f) => normalizeMsisdn(f).normalized);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('+15550101234');
  });

  it('flags that a country code was assumed for a bare 10-digit number', () => {
    const result = normalizeMsisdn('5550101234');
    expect(result.normalized).toBe('+15550101234');
    expect(result.issues.some((i) => /assumed/i.test(i))).toBe(true);
  });

  it('does not flag an assumption when the country code was supplied', () => {
    const result = normalizeMsisdn('15550101234');
    expect(result.issues.some((i) => /assumed/i.test(i))).toBe(false);
  });

  it('preserves short codes rather than padding them to E.164', () => {
    const result = normalizeMsisdn('611');
    expect(result.normalized).toBe('611');
    expect(result.derived?.kind).toBe('SHORT_CODE');
    expect(result.valid).toBe(true);
  });

  it('handles international numbers without forcing a NANP country code', () => {
    const result = normalizeMsisdn('+44 20 7946 0958');
    expect(result.normalized).toBe('+442079460958');
    expect(result.derived?.kind).toBe('INTERNATIONAL');
  });

  it('strips a leading 011 international dialing prefix', () => {
    const result = normalizeMsisdn('011442079460958');
    expect(result.normalized).toBe('+442079460958');
    expect(result.issues.some((i) => /011/.test(i))).toBe(true);
  });

  it('rejects placeholder tokens instead of treating them as a device', () => {
    for (const token of ['', 'N/A', 'UNKNOWN', 'RESTRICTED', 'PRIVATE', '0', '--']) {
      const result = normalizeMsisdn(token);
      expect(result.valid, `${token} should not be valid`).toBe(false);
      expect(result.normalized, `${token} should not normalize`).toBeUndefined();
    }
  });

  it('flags numbers that violate NANP area/exchange rules', () => {
    const result = normalizeMsisdn('1234567890');
    expect(result.issues.some((i) => /Numbering Plan/i.test(i))).toBe(true);
  });

  it('refuses to invent a country code for a non-NANP-shaped number', () => {
    // 11 digits not starting with 1: cannot be NANP, and no + was supplied.
    // The value is retained verbatim and marked invalid rather than being
    // padded into a number that would correlate with the wrong device.
    const result = normalizeMsisdn('44207946095');
    expect(result.normalized).toBe('44207946095');
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => /no country code indicator/i.test(i))).toBe(true);
  });
});

describe('normalizeImsi', () => {
  it('decomposes a 15-digit IMSI into MCC, MNC and MSIN', () => {
    const result = normalizeImsi('310260123456789');
    expect(result.valid).toBe(true);
    expect(result.derived?.mcc).toBe('310');
    expect(result.derived?.mnc).toBe('260');
    expect(result.derived?.msin).toBe('123456789');
    expect(result.derived?.operator).toBe('T-Mobile');
  });

  it('identifies AT&T and Verizon prefixes', () => {
    expect(normalizeImsi('310410123456789').derived?.operator).toBe('AT&T');
    expect(normalizeImsi('311480123456789').derived?.operator).toBe('Verizon');
    expect(normalizeImsi('310730123456789').derived?.operator).toBe('UScellular');
  });

  it('uses a 2-digit MNC outside North America', () => {
    const result = normalizeImsi('234150000000000');
    expect(result.derived?.mcc).toBe('234');
    expect(result.derived?.mnc).toBe('15');
  });

  it('flags an unknown North American MCC/MNC rather than silently accepting it', () => {
    const result = normalizeImsi('310999123456789');
    expect(result.issues.some((i) => /not in the known/i.test(i))).toBe(true);
    expect(result.valid).toBe(false);
  });

  it('flags a wrong-length IMSI but still normalizes what it can', () => {
    const result = normalizeImsi('31026012345');
    expect(result.valid).toBe(false);
    expect(result.normalized).toBe('31026012345');
    expect(result.issues[0]).toMatch(/11 digits/);
  });

  it('strips formatting characters', () => {
    expect(normalizeImsi('310-260-123456789').normalized).toBe('310260123456789');
  });
});

describe('normalizeImei', () => {
  it('validates the Luhn check digit', () => {
    // 35209900176148 + Luhn check digit
    const body = '35209900176148';
    const check = luhnCheckDigit(body);
    const result = normalizeImei(`${body}${check}`);
    expect(result.valid).toBe(true);
    expect(result.derived?.form).toBe('IMEI');
    expect(result.derived?.checkDigit).toBe(check);
  });

  it('flags a failed check digit as possible mistyping or alteration', () => {
    const body = '35209900176148';
    const wrong = String((Number(luhnCheckDigit(body)) + 1) % 10);
    const result = normalizeImei(`${body}${wrong}`);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatch(/check digit/i);
  });

  it('correlates an IMEI with the IMEISV of the same handset', () => {
    const body = '35209900176148';
    const imei = normalizeImei(`${body}${luhnCheckDigit(body)}`);
    const imeisv = normalizeImei(`${body}07`);
    expect(imei.normalized).toBe(imeisv.normalized);
    expect(imeisv.derived?.form).toBe('IMEISV');
    expect(imeisv.derived?.softwareVersion).toBe('07');
  });

  it('extracts the type allocation code', () => {
    const result = normalizeImei('352099001761481');
    expect(result.derived?.tac).toBe('35209900');
    expect(result.derived?.serial).toBe('176148');
  });

  it('rejects an all-same-digit placeholder', () => {
    const result = normalizeImei('11111111111111');
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatch(/placeholder/i);
  });

  it('rejects implausible lengths', () => {
    expect(normalizeImei('12345').valid).toBe(false);
    expect(normalizeImei('12345').normalized).toBeUndefined();
  });
});

describe('normalizeIccid', () => {
  it('accepts a well-formed ICCID', () => {
    const result = normalizeIccid('89014103211118510720');
    expect(result.valid).toBe(true);
    expect(result.derived?.mii).toBe('89');
  });

  it('flags an ICCID that does not begin with 89', () => {
    const result = normalizeIccid('12014103211118510720');
    expect(result.issues.some((i) => /89/.test(i))).toBe(true);
  });
});

describe('luhnCheckDigit', () => {
  it('computes the documented check digit for a known IMEI body', () => {
    // 490154203237518 is a widely published valid test IMEI.
    expect(luhnCheckDigit('49015420323751')).toBe('8');
  });
});

describe('inferIdentifierType — suggestion only, never silent classification', () => {
  it('recognises an IMSI by known MCC/MNC with high confidence', () => {
    const guess = inferIdentifierType('310260123456789');
    expect(guess?.type).toBe('IMSI');
    expect(guess?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(guess?.rationale).toMatch(/T-Mobile/);
  });

  it('recognises a NANP phone number', () => {
    expect(inferIdentifierType('5550101234')?.type).toBe('MSISDN');
    expect(inferIdentifierType('+15550101234')?.type).toBe('MSISDN');
  });

  it('recognises an ICCID', () => {
    expect(inferIdentifierType('89014103211118510720')?.type).toBe('ICCID');
  });

  it('returns nothing for a value it cannot classify', () => {
    expect(inferIdentifierType('banana')).toBeUndefined();
    expect(inferIdentifierType('N/A')).toBeUndefined();
  });

  it('always reports a rationale an analyst can evaluate', () => {
    const guess = inferIdentifierType('352099001761481');
    expect(guess?.rationale.length).toBeGreaterThan(10);
  });
});

describe('identifier keys', () => {
  it('namespaces by type so digit collisions across types cannot merge devices', () => {
    const asImei = identifierKey({ type: 'IMEI', normalized: '35209900176148', raw: '' });
    const asImsi = identifierKey({ type: 'IMSI', normalized: '35209900176148', raw: '' });
    expect(asImei).not.toBe(asImsi);
  });

  it('round-trips through parseIdentifierKey', () => {
    const key = identifierKey({ type: 'MSISDN', normalized: '+15550101234', raw: '' });
    expect(parseIdentifierKey(key)).toEqual({ type: 'MSISDN', value: '+15550101234' });
  });

  it('rejects a key with an unknown type', () => {
    expect(parseIdentifierKey('NONSENSE:123')).toBeUndefined();
  });
});

describe('display masking', () => {
  it('masks all but the last four characters when policy requires it', () => {
    const id = normalizeMsisdn('5550101234');
    expect(displayIdentifier(id, true)).toBe('••••••••1234');
    expect(displayIdentifier(id, false)).toBe('+15550101234');
  });
});

describe('isNullToken', () => {
  it('recognises the placeholder vocabulary carriers actually emit', () => {
    for (const t of ['N/A', 'na', 'unknown', 'Not Provided', 'RESTRICTED', '', '  ', '-']) {
      expect(isNullToken(t), `${t} should be a null token`).toBe(true);
    }
    expect(isNullToken('5550101234')).toBe(false);
  });
});
