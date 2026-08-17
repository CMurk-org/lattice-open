// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import {
  hashBuffer,
  hashStream,
  hashSourceRow,
  deterministicRecordId,
  packageManifestHash,
  outputDigest,
  appendAuditEntry,
  verifyAuditChain,
  canonicalJson,
  AUDIT_GENESIS_HASH,
  type AuditChainEntry,
  type FileIntegrityRecord,
} from './integrity';

describe('hashing', () => {
  it('produces the published SHA-256 of a known input', () => {
    expect(hashBuffer('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes a stream identically to the same bytes in memory', async () => {
    const data = 'row1\nrow2\nrow3\n';
    const streamed = await hashStream(Readable.from([Buffer.from(data)]));
    expect(streamed.hash).toBe(hashBuffer(data));
    expect(streamed.bytes).toBe(Buffer.byteLength(data));
  });

  it('gives different source rows different hashes', () => {
    expect(hashSourceRow('a,b,c')).not.toBe(hashSourceRow('a,b,d'));
  });

  it('is sensitive to whitespace, because evidence is byte-exact', () => {
    expect(hashSourceRow('a,b,c')).not.toBe(hashSourceRow('a, b, c'));
  });
});

describe('deterministicRecordId', () => {
  it('yields the same id for the same row, making re-imports idempotent', () => {
    const first = deterministicRecordId(['file_1', 42, '310260123456789', '2024-03-15T22:31:42Z']);
    const second = deterministicRecordId(['file_1', 42, '310260123456789', '2024-03-15T22:31:42Z']);
    expect(first).toBe(second);
  });

  it('yields different ids for different rows of the same file', () => {
    const a = deterministicRecordId(['file_1', 42, 'x']);
    const b = deterministicRecordId(['file_1', 43, 'x']);
    expect(a).not.toBe(b);
  });

  it('distinguishes undefined fields from empty ones positionally', () => {
    expect(deterministicRecordId(['a', undefined, 'b'])).not.toBe(deterministicRecordId(['a', 'b', undefined]));
  });
});

describe('packageManifestHash', () => {
  const file = (sha256: string, name: string): FileIntegrityRecord => ({
    sourceFileId: `file_${name}`,
    originalFilename: name,
    sizeBytes: 100,
    sha256,
    importedAt: '2024-03-16T10:00:00Z',
    importedByUserId: 'usr_1',
    importJobId: 'job_1',
    storageKey: `s3://evidence/${name}`,
  });

  it('is independent of the order files were listed in', () => {
    const a = [file('a'.repeat(64), 'one.csv'), file('b'.repeat(64), 'two.csv')];
    const b = [file('b'.repeat(64), 'two.csv'), file('a'.repeat(64), 'one.csv')];
    expect(packageManifestHash(a)).toBe(packageManifestHash(b));
  });

  it('changes when any file in the package changes', () => {
    const before = [file('a'.repeat(64), 'one.csv')];
    const after = [file('c'.repeat(64), 'one.csv')];
    expect(packageManifestHash(before)).not.toBe(packageManifestHash(after));
  });
});

describe('outputDigest', () => {
  it('proves which records a transformation emitted', () => {
    expect(outputDigest(['r1', 'r2', 'r3'])).toBe(outputDigest(['r1', 'r2', 'r3']));
    expect(outputDigest(['r1', 'r2'])).not.toBe(outputDigest(['r1', 'r2', 'r3']));
  });

  it('is order-sensitive, because record order is part of the transformation', () => {
    expect(outputDigest(['r1', 'r2'])).not.toBe(outputDigest(['r2', 'r1']));
  });
});

describe('canonicalJson', () => {
  it('is independent of property insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ x: { z: 1, y: 2 } })).toBe('{"x":{"y":2,"z":1}}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('omits undefined values rather than emitting invalid JSON', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('refuses cyclic structures instead of hanging', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });
});

describe('audit hash chain', () => {
  const build = (count: number, key?: Buffer): AuditChainEntry[] => {
    const entries: AuditChainEntry[] = [];
    let previous: AuditChainEntry | null = null;
    for (let i = 1; i <= count; i += 1) {
      const entry = appendAuditEntry(
        previous,
        {
          at: `2024-03-16T10:0${i}:00Z`,
          actorId: 'usr_1',
          action: i % 2 === 0 ? 'EVIDENCE_ACCESS' : 'CASE_ACCESS',
          payload: { caseId: 'case_1', n: i },
        },
        key,
      );
      entries.push(entry);
      previous = entry;
    }
    return entries;
  };

  it('links the first entry to the genesis hash', () => {
    const [first] = build(1);
    expect(first?.previousHash).toBe(AUDIT_GENESIS_HASH);
    expect(first?.seq).toBe(1);
  });

  it('verifies an untouched chain', () => {
    const result = verifyAuditChain(build(20));
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(20);
  });

  it('detects an altered entry payload', () => {
    const entries = build(10);
    const target = entries[4]!;
    entries[4] = { ...target, payloadHash: 'f'.repeat(64) };
    const result = verifyAuditChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(5);
    expect(result.message).toMatch(/modified/i);
  });

  it('detects an altered actor', () => {
    const entries = build(10);
    entries[6] = { ...entries[6]!, actorId: 'usr_impostor' };
    const result = verifyAuditChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(7);
  });

  it('detects a deleted entry', () => {
    const entries = build(10);
    entries.splice(4, 1);
    const result = verifyAuditChain(entries);
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/gap/i);
  });

  it('detects a re-linked chain where an entry was replaced wholesale', () => {
    const entries = build(10);
    // An attacker rewrites entry 5 and re-links it, but cannot fix entry 6 onward.
    const forged = appendAuditEntry(
      { seq: 4, entryHash: entries[3]!.entryHash },
      { at: '2024-03-16T10:05:00Z', actorId: 'usr_1', action: 'CASE_ACCESS', payload: { caseId: 'case_1', n: 999 } },
    );
    entries[4] = forged;
    const result = verifyAuditChain(entries);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(6);
  });

  it('rejects a chain forged without the HMAC key', () => {
    const key = Buffer.from('a-secret-audit-key-held-outside-the-database');
    const entries = build(5, key);
    expect(verifyAuditChain(entries, key).valid).toBe(true);

    // Rebuilding entry 3 without the key produces a hash that will not verify.
    const forged = appendAuditEntry(
      { seq: 2, entryHash: entries[1]!.entryHash },
      { at: '2024-03-16T10:03:00Z', actorId: 'usr_1', action: 'CASE_ACCESS', payload: { caseId: 'case_1', n: 3 } },
    );
    entries[2] = forged;
    const result = verifyAuditChain(entries, key);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(3);
  });

  it('is insensitive to payload key ordering, so re-serialisation does not break it', () => {
    const a = appendAuditEntry(null, {
      at: '2024-03-16T10:01:00Z',
      actorId: 'usr_1',
      action: 'CASE_ACCESS',
      payload: { caseId: 'case_1', userId: 'usr_1' },
    });
    const b = appendAuditEntry(null, {
      at: '2024-03-16T10:01:00Z',
      actorId: 'usr_1',
      action: 'CASE_ACCESS',
      payload: { userId: 'usr_1', caseId: 'case_1' },
    });
    expect(a.entryHash).toBe(b.entryHash);
  });
});
