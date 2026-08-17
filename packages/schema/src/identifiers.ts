// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Cellular identifiers.
 *
 * Correlation across tower dumps lives or dies here. The same device appears as
 * `+1 (555) 010-1234`, `5550101234` and `15550101234` across three carriers'
 * exports; unless those normalize to one value the intersection analysis is
 * simply wrong. Equally important: the system must always be able to say WHICH
 * identifier produced a match, because an IMEI match and an MSISDN match mean
 * very different things evidentially.
 *
 * Normalization never discards the original. Every `Identifier` keeps `raw`.
 */

export const IDENTIFIER_TYPES = [
  'MSISDN',
  'IMSI',
  'IMEI',
  'ESN',
  'MEID',
  'ICCID',
  'SIP_URI',
  'IP_ADDRESS',
  'CARRIER_SUBSCRIBER_ID',
  'CARRIER_DEVICE_ID',
] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/**
 * Evidential weight of a match on each identifier type. Used for ranking and
 * for the wording of explanations — never as a probability of anything.
 */
export const IDENTIFIER_STRENGTH: Record<
  IdentifierType,
  { rank: number; meaning: string }
> = {
  IMEI: {
    rank: 5,
    meaning: 'Identifies a specific handset. Survives SIM changes. Can be spoofed or reprogrammed.',
  },
  IMSI: {
    rank: 4,
    meaning: 'Identifies a specific SIM/subscriber on the network. Moves with the SIM between handsets.',
  },
  ICCID: { rank: 4, meaning: 'Identifies the physical SIM card.' },
  MEID: { rank: 4, meaning: 'Identifies a CDMA handset.' },
  ESN: { rank: 3, meaning: 'Legacy CDMA handset identifier.' },
  MSISDN: {
    rank: 3,
    meaning: 'The dialable number. Can be ported between SIMs and reassigned between subscribers over time.',
  },
  CARRIER_SUBSCRIBER_ID: { rank: 2, meaning: 'Carrier-internal subscriber key. Meaning is carrier-specific.' },
  CARRIER_DEVICE_ID: { rank: 2, meaning: 'Carrier-internal device key. Meaning is carrier-specific.' },
  SIP_URI: { rank: 2, meaning: 'VoLTE/IMS session identifier.' },
  IP_ADDRESS: {
    rank: 1,
    meaning: 'Network address. Frequently shared via CGNAT and reassigned; weak on its own.',
  },
};

export interface Identifier {
  readonly type: IdentifierType;
  /** Exactly as it appeared in the source. */
  readonly raw: string;
  /** Canonical form used for joins. Undefined when the value could not be normalized. */
  readonly normalized?: string;
  /** Structural validity per the identifier's specification. */
  readonly valid: boolean;
  /** Everything questionable about this value, surfaced to the data-quality engine. */
  readonly issues: readonly string[];
  /** Type-specific derived facts, e.g. IMSI → MCC/MNC, IMEI → TAC. */
  readonly derived?: Readonly<Record<string, string>>;
}

const digitsOnly = (s: string) => s.replace(/\D+/g, '');

/** Values carriers use to mean "no value". Treated as absent, never as data. */
const NULL_TOKENS = new Set([
  '',
  '0',
  'N/A',
  'NA',
  'NULL',
  'NONE',
  'UNKNOWN',
  'UNAVAILABLE',
  'NOT AVAILABLE',
  'NOT PROVIDED',
  '-',
  '--',
  'RESTRICTED',
  'PRIVATE',
  'WITHHELD',
  'ANONYMOUS',
  'BLOCKED',
]);

export function isNullToken(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return true;
  return NULL_TOKENS.has(value.trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// MSISDN / phone number
// ---------------------------------------------------------------------------

/**
 * Normalize to E.164 where possible.
 *
 * NANP assumptions are applied only to 10- and 11-digit values, and are
 * recorded as an issue so the analyst can see that a country code was inferred
 * rather than supplied. International values arriving with a leading + or 011
 * are respected as-is.
 */
export function normalizeMsisdn(raw: string, defaultCountryCode = '1'): Identifier {
  const original = raw.trim();
  const issues: string[] = [];

  if (isNullToken(original)) {
    return { type: 'MSISDN', raw: original, valid: false, issues: ['Value is a null/placeholder token.'] };
  }

  // Short codes (3–6 digits) are real, dialable, and must not be padded to E.164.
  const bare = digitsOnly(original);
  if (!original.startsWith('+') && bare.length >= 3 && bare.length <= 6) {
    return {
      type: 'MSISDN',
      raw: original,
      normalized: bare,
      valid: true,
      issues: [],
      derived: { kind: 'SHORT_CODE' },
    };
  }

  let digits = bare;
  let explicitInternational = original.startsWith('+');

  if (!explicitInternational && digits.startsWith('011') && digits.length > 12) {
    digits = digits.slice(3);
    explicitInternational = true;
    issues.push('Leading 011 international dialing prefix removed.');
  }

  if (digits.length === 0) {
    return { type: 'MSISDN', raw: original, valid: false, issues: ['No digits present.'] };
  }

  if (explicitInternational) {
    if (digits.length < 8 || digits.length > 15) {
      issues.push(`International number has ${digits.length} digits, outside the E.164 range of 8–15.`);
    }
    return {
      type: 'MSISDN',
      raw: original,
      normalized: `+${digits}`,
      valid: issues.length === 0,
      issues,
      derived: { kind: 'INTERNATIONAL' },
    };
  }

  if (digits.length === 10) {
    if (defaultCountryCode === '1' && !isValidNanp(digits)) {
      issues.push('Does not satisfy North American Numbering Plan area/exchange rules.');
    }
    issues.push(`Country code +${defaultCountryCode} was assumed; it was not present in the source.`);
    return {
      type: 'MSISDN',
      raw: original,
      normalized: `+${defaultCountryCode}${digits}`,
      valid: true,
      issues,
      derived: { kind: 'NANP', npa: digits.slice(0, 3), nxx: digits.slice(3, 6) },
    };
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    const nanp = digits.slice(1);
    if (!isValidNanp(nanp)) {
      issues.push('Does not satisfy North American Numbering Plan area/exchange rules.');
    }
    return {
      type: 'MSISDN',
      raw: original,
      normalized: `+${digits}`,
      valid: true,
      issues,
      derived: { kind: 'NANP', npa: nanp.slice(0, 3), nxx: nanp.slice(3, 6) },
    };
  }

  if (digits.length >= 8 && digits.length <= 15) {
    issues.push(
      `Number has ${digits.length} digits and no country code indicator; it was retained as-is ` +
        `rather than assuming a country. It will only correlate with identically-formatted values.`,
    );
    return { type: 'MSISDN', raw: original, normalized: digits, valid: false, issues };
  }

  return {
    type: 'MSISDN',
    raw: original,
    valid: false,
    issues: [`Length ${digits.length} is not a plausible phone number.`],
  };
}

function isValidNanp(tenDigits: string): boolean {
  // NPA: [2-9] then 2 digits, second digit not 9 (N9X reserved). NXX: [2-9] then 2 digits.
  return /^[2-9][0-8]\d[2-9]\d{6}$/.test(tenDigits);
}

// ---------------------------------------------------------------------------
// IMSI
// ---------------------------------------------------------------------------

/** MCC/MNC prefixes for the carriers we target, used to sanity-check IMSIs. */
const KNOWN_US_MCC_MNC: Readonly<Record<string, string>> = {
  '310030': 'AT&T',
  '310070': 'AT&T',
  '310150': 'AT&T',
  '310170': 'AT&T',
  '310280': 'AT&T',
  '310380': 'AT&T',
  '310410': 'AT&T',
  '310560': 'AT&T',
  '311180': 'AT&T',
  '310004': 'Verizon',
  '310005': 'Verizon',
  '310012': 'Verizon',
  '311480': 'Verizon',
  '310590': 'Verizon',
  '310890': 'Verizon',
  '310160': 'T-Mobile',
  '310200': 'T-Mobile',
  '310210': 'T-Mobile',
  '310220': 'T-Mobile',
  '310230': 'T-Mobile',
  '310240': 'T-Mobile',
  '310250': 'T-Mobile',
  '310260': 'T-Mobile',
  '310270': 'T-Mobile',
  '310310': 'T-Mobile',
  '310490': 'T-Mobile',
  '310660': 'T-Mobile',
  '310800': 'T-Mobile',
  '311882': 'T-Mobile',
  '310120': 'Sprint (T-Mobile)',
  '312530': 'Sprint (T-Mobile)',
  '311870': 'Boost',
  '310730': 'UScellular',
  '311220': 'UScellular',
  '310320': 'UScellular',
};

export function normalizeImsi(raw: string): Identifier {
  const original = raw.trim();
  if (isNullToken(original)) {
    return { type: 'IMSI', raw: original, valid: false, issues: ['Value is a null/placeholder token.'] };
  }

  const digits = digitsOnly(original);
  const issues: string[] = [];

  if (digits.length !== 15) {
    if (digits.length < 6) {
      return {
        type: 'IMSI',
        raw: original,
        valid: false,
        issues: [`IMSI has ${digits.length} digits; too short to be usable.`],
      };
    }
    issues.push(`IMSI has ${digits.length} digits; the specification defines up to 15 (usually exactly 15).`);
  }

  const mcc = digits.slice(0, 3);
  // US MNCs are 3 digits; most of the rest of the world uses 2. We only assert
  // a 3-digit MNC for MCC 310–316 (North America).
  const mccNum = Number.parseInt(mcc, 10);
  const mncLength = mccNum >= 310 && mccNum <= 316 ? 3 : 2;
  const mnc = digits.slice(3, 3 + mncLength);
  const msin = digits.slice(3 + mncLength);

  const derived: Record<string, string> = { mcc, mnc, msin };
  const operator = KNOWN_US_MCC_MNC[`${mcc}${mnc}`];
  if (operator) derived.operator = operator;
  else if (mccNum >= 310 && mccNum <= 316) {
    issues.push(`MCC/MNC ${mcc}${mnc} is not in the known North American operator table.`);
  }

  return {
    type: 'IMSI',
    raw: original,
    normalized: digits,
    valid: digits.length === 15 && issues.length === 0,
    issues,
    derived,
  };
}

// ---------------------------------------------------------------------------
// IMEI
// ---------------------------------------------------------------------------

/**
 * IMEI is 14 digits + a Luhn check digit. IMEISV is 14 digits + a 2-digit
 * software version and carries NO check digit.
 *
 * We normalize both to the 14-digit device identity so that an IMEI and an
 * IMEISV for the same handset correlate — that is a real and common situation
 * across carrier exports, and failing to handle it splits one device in two.
 * The check digit and SV are preserved in `derived`.
 */
export function normalizeImei(raw: string): Identifier {
  const original = raw.trim();
  if (isNullToken(original)) {
    return { type: 'IMEI', raw: original, valid: false, issues: ['Value is a null/placeholder token.'] };
  }

  const digits = digitsOnly(original);
  const issues: string[] = [];
  const derived: Record<string, string> = {};

  let body: string;
  if (digits.length === 15) {
    body = digits.slice(0, 14);
    const checkDigit = digits[14] ?? '';
    const expected = luhnCheckDigit(body);
    derived.checkDigit = checkDigit;
    derived.form = 'IMEI';
    if (checkDigit !== expected) {
      issues.push(
        `IMEI check digit is ${checkDigit} but Luhn computes ${expected}. The value may be ` +
          `mistyped, truncated, or deliberately altered.`,
      );
    }
  } else if (digits.length === 16) {
    body = digits.slice(0, 14);
    derived.softwareVersion = digits.slice(14);
    derived.form = 'IMEISV';
  } else if (digits.length === 14) {
    body = digits;
    derived.form = 'IMEI_NO_CHECK_DIGIT';
  } else {
    return {
      type: 'IMEI',
      raw: original,
      valid: false,
      issues: [`IMEI has ${digits.length} digits; expected 14, 15 (IMEI) or 16 (IMEISV).`],
    };
  }

  derived.tac = body.slice(0, 8);
  derived.serial = body.slice(8, 14);

  if (/^(\d)\1{13}$/.test(body)) {
    issues.push('IMEI consists of a single repeated digit; this is a placeholder, not a real device.');
  }

  return {
    type: 'IMEI',
    raw: original,
    normalized: body,
    valid: issues.length === 0,
    issues,
    derived,
  };
}

export function luhnCheckDigit(body: string): string {
  let sum = 0;
  // Rightmost digit of `body` is doubled (it sits in an even position from the right
  // once the check digit is appended).
  for (let i = 0; i < body.length; i += 1) {
    const digit = Number.parseInt(body[body.length - 1 - i] ?? '0', 10);
    if (i % 2 === 0) {
      const doubled = digit * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else {
      sum += digit;
    }
  }
  return String((10 - (sum % 10)) % 10);
}

// ---------------------------------------------------------------------------
// Other identifier types
// ---------------------------------------------------------------------------

export function normalizeIccid(raw: string): Identifier {
  const original = raw.trim();
  if (isNullToken(original)) {
    return { type: 'ICCID', raw: original, valid: false, issues: ['Value is a null/placeholder token.'] };
  }
  const digits = digitsOnly(original);
  const issues: string[] = [];
  if (digits.length < 18 || digits.length > 22) {
    issues.push(`ICCID has ${digits.length} digits; expected 18–22.`);
  }
  if (!digits.startsWith('89')) {
    issues.push('ICCID does not begin with the telecom major industry identifier 89.');
  }
  return {
    type: 'ICCID',
    raw: original,
    normalized: digits,
    valid: issues.length === 0,
    issues,
    derived: { mii: digits.slice(0, 2), countryCode: digits.slice(2, 5) },
  };
}

export function normalizeEsnMeid(raw: string, type: 'ESN' | 'MEID' = 'MEID'): Identifier {
  const original = raw.trim();
  if (isNullToken(original)) {
    return { type, raw: original, valid: false, issues: ['Value is a null/placeholder token.'] };
  }
  const cleaned = original.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const issues: string[] = [];
  const expected = type === 'MEID' ? 14 : 8;
  if (cleaned.length !== expected && cleaned.length !== expected + 1) {
    issues.push(`${type} has ${cleaned.length} hex digits; expected ${expected}.`);
  }
  return {
    type,
    raw: original,
    normalized: cleaned.slice(0, expected),
    valid: issues.length === 0,
    issues,
  };
}

export function normalizeOpaque(raw: string, type: IdentifierType): Identifier {
  const original = raw.trim();
  if (isNullToken(original)) {
    return { type, raw: original, valid: false, issues: ['Value is a null/placeholder token.'] };
  }
  return { type, raw: original, normalized: original.toUpperCase(), valid: true, issues: [] };
}

/** Dispatch to the right normalizer for a declared type. */
export function normalizeIdentifier(
  raw: string,
  type: IdentifierType,
  opts: { defaultCountryCode?: string } = {},
): Identifier {
  switch (type) {
    case 'MSISDN':
      return normalizeMsisdn(raw, opts.defaultCountryCode ?? '1');
    case 'IMSI':
      return normalizeImsi(raw);
    case 'IMEI':
      return normalizeImei(raw);
    case 'ICCID':
      return normalizeIccid(raw);
    case 'ESN':
      return normalizeEsnMeid(raw, 'ESN');
    case 'MEID':
      return normalizeEsnMeid(raw, 'MEID');
    default:
      return normalizeOpaque(raw, type);
  }
}

/**
 * Infer the identifier type of a bare value. Used only to SUGGEST mappings
 * during the import review step — never to silently classify evidence.
 */
export function inferIdentifierType(
  raw: string,
): { type: IdentifierType; confidence: number; rationale: string } | undefined {
  const digits = digitsOnly(raw);
  if (isNullToken(raw)) return undefined;

  // 15 digits is ambiguous: both IMSI and IMEI are 15 digits, and an IMEI's
  // 8-digit TAC frequently begins with a value that also looks like a mobile
  // country code (35xxxxxx is an extremely common TAC prefix AND 352 is a
  // plausible MCC). Weigh both signals rather than testing one first.
  if (digits.length === 15) {
    const mcc = Number.parseInt(digits.slice(0, 3), 10);
    const knownOperator = KNOWN_US_MCC_MNC[digits.slice(0, 6)];
    const luhnValid = luhnCheckDigit(digits.slice(0, 14)) === digits[14];
    const plausibleMcc = mcc >= 200 && mcc <= 750;

    if (knownOperator && !luhnValid) {
      return {
        type: 'IMSI',
        confidence: 0.9,
        rationale: `15 digits beginning with a known ${knownOperator} MCC/MNC (${digits.slice(0, 6)}).`,
      };
    }
    if (knownOperator && luhnValid) {
      // A known operator prefix is far stronger evidence than a Luhn digit that
      // matches by chance one time in ten, but the ambiguity is real and stated.
      return {
        type: 'IMSI',
        confidence: 0.6,
        rationale:
          `15 digits beginning with a known ${knownOperator} MCC/MNC (${digits.slice(0, 6)}), though ` +
          `the value also satisfies the IMEI check digit. Confirm against the column heading.`,
      };
    }
    if (luhnValid) {
      return {
        type: 'IMEI',
        confidence: 0.85,
        rationale:
          `15 digits with a valid IMEI Luhn check digit and no recognised operator prefix ` +
          `(TAC ${digits.slice(0, 8)}).`,
      };
    }
    if (plausibleMcc) {
      return {
        type: 'IMSI',
        confidence: 0.5,
        rationale:
          `15 digits beginning with a plausible mobile country code (${digits.slice(0, 3)}) but an ` +
          `unrecognised operator prefix, and the IMEI check digit does not validate.`,
      };
    }
  }
  if (digits.length === 16) {
    return { type: 'IMEI', confidence: 0.5, rationale: '16 digits, consistent with an IMEISV.' };
  }
  if (digits.length >= 18 && digits.length <= 22 && digits.startsWith('89')) {
    return { type: 'ICCID', confidence: 0.8, rationale: '18–22 digits beginning with 89.' };
  }
  if (raw.trim().startsWith('+') || digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) {
    return { type: 'MSISDN', confidence: 0.75, rationale: 'Matches North American or E.164 phone number shape.' };
  }
  if (/^sip:/i.test(raw.trim())) {
    return { type: 'SIP_URI', confidence: 0.95, rationale: 'Begins with the sip: scheme.' };
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(raw.trim()) || /^[0-9a-f:]{6,39}$/i.test(raw.trim())) {
    return { type: 'IP_ADDRESS', confidence: 0.6, rationale: 'Matches an IPv4 or IPv6 address shape.' };
  }
  return undefined;
}

/**
 * The key used to join records. Includes the type, so an IMEI and an MSISDN
 * that happen to share digits can never collide.
 */
export function identifierKey(id: Pick<Identifier, 'type' | 'normalized' | 'raw'>): string {
  return `${id.type}:${id.normalized ?? id.raw}`;
}

export function parseIdentifierKey(key: string): { type: IdentifierType; value: string } | undefined {
  const idx = key.indexOf(':');
  if (idx < 0) return undefined;
  const type = key.slice(0, idx) as IdentifierType;
  if (!IDENTIFIER_TYPES.includes(type)) return undefined;
  return { type, value: key.slice(idx + 1) };
}

/** Format an identifier for display, masking where policy requires it. */
export function displayIdentifier(id: Identifier, mask = false): string {
  const value = id.normalized ?? id.raw;
  if (!mask) return value;
  if (value.length <= 4) return '•'.repeat(value.length);
  return `${'•'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}
