// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * ZIP archive ingestion.
 *
 * Carrier productions routinely arrive as a single ZIP containing the returns,
 * a cell site list and a cover letter. Investigators must be able to drop that
 * archive in whole.
 *
 * An archive is untrusted input that arrives from outside the agency, so this
 * module defends against the standard attacks before anything is written:
 *
 *   zip-slip     — an entry named `../../etc/passwd` escaping the extraction
 *                  root. Entry paths are validated, never joined blindly.
 *   zip bomb     — a small archive expanding to terabytes. Total and per-member
 *                  uncompressed size are capped, and the compression ratio is
 *                  checked against a threshold.
 *   nesting      — archives inside archives, recursing forever. Depth is capped.
 *
 * Every member is hashed independently, so a file extracted from an archive has
 * the same provenance guarantees as one uploaded directly. The containing
 * archive's own hash is recorded too, so the chain of custody covers both.
 */

import { unzipSync } from 'fflate';
import { hashBuffer } from '@cmurk/cellular-schema';

export interface ArchiveMember {
  /** Path inside the archive, normalized with forward slashes. */
  readonly path: string;
  /** Filename alone, for display. */
  readonly filename: string;
  readonly content: Buffer;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** Nesting depth: 0 for a member of the archive that was uploaded. */
  readonly depth: number;
  /** Path of the archive this member came from, for nested archives. */
  readonly containerPath?: string;
}

export interface ArchiveRejection {
  readonly path: string;
  readonly reason: string;
  readonly code:
    | 'PATH_TRAVERSAL'
    | 'ABSOLUTE_PATH'
    | 'TOO_LARGE'
    | 'TOTAL_TOO_LARGE'
    | 'TOO_MANY_MEMBERS'
    | 'NESTING_TOO_DEEP'
    | 'SUSPICIOUS_RATIO'
    | 'UNREADABLE';
}

export interface ArchiveExtraction {
  readonly members: readonly ArchiveMember[];
  /** Entries refused, with the reason. Never silently dropped. */
  readonly rejected: readonly ArchiveRejection[];
  readonly archiveSha256: string;
  readonly totalUncompressedBytes: number;
  /** Nested archives that were opened, by path. */
  readonly nestedArchives: readonly string[];
  readonly notes: readonly string[];
}

export interface ArchiveOptions {
  /** Total uncompressed bytes permitted across all members. Default 2 GiB. */
  readonly maxTotalBytes?: number;
  /** Largest single member permitted. Default 512 MiB. */
  readonly maxMemberBytes?: number;
  readonly maxMembers?: number;
  /** How many levels of nested archive to open. Default 2. */
  readonly maxDepth?: number;
  /**
   * Compression ratio above which a member is treated as a probable zip bomb.
   * Text compresses ~5-10×; carrier CSVs sometimes reach 20×. 200× does not
   * occur in genuine evidence.
   */
  readonly maxCompressionRatio?: number;
}

const DEFAULTS = {
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxMemberBytes: 512 * 1024 * 1024,
  maxMembers: 10_000,
  maxDepth: 2,
  maxCompressionRatio: 200,
};

/** ZIP local file header signature. */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export function isZipArchive(data: Buffer): boolean {
  if (data.length < 4) return false;
  const head = data.subarray(0, 4);
  return head.equals(ZIP_MAGIC) || head.equals(ZIP_EMPTY);
}

/** XLSX, DOCX and friends are ZIPs; they must not be unpacked as archives. */
export function isOfficeOpenXml(filename: string): boolean {
  return /\.(xlsx|xlsm|xltx|docx|pptx)$/i.test(filename);
}

/**
 * Is this entry path safe to record?
 *
 * The path is only ever used as a label and a provenance locator — nothing is
 * written to disk under it — but it is validated anyway. A path that tries to
 * escape is evidence about the archive, and the analyst should be told.
 */
function validatePath(rawPath: string): { ok: true; path: string } | { ok: false; rejection: ArchiveRejection } {
  const normalized = rawPath.replace(/\\/g, '/');

  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return {
      ok: false,
      rejection: {
        path: rawPath,
        code: 'ABSOLUTE_PATH',
        reason:
          'The entry uses an absolute path. Genuine productions use relative paths; an absolute ' +
          'path is a sign the archive was crafted to write outside its extraction directory.',
      },
    };
  }

  if (normalized.split('/').some((segment) => segment === '..')) {
    return {
      ok: false,
      rejection: {
        path: rawPath,
        code: 'PATH_TRAVERSAL',
        reason:
          'The entry path contains a parent-directory segment ("..") that would escape the ' +
          'extraction directory. This is the zip-slip pattern and the entry has been refused.',
      },
    };
  }

  return { ok: true, path: normalized };
}

/**
 * Extract a ZIP archive.
 *
 * Returns members and rejections. A rejection is never a silent drop: the
 * import UI shows it, because "the archive contained an entry that tried to
 * escape" is something an analyst must know about the evidence they received.
 */
export function extractArchive(data: Buffer, opts: ArchiveOptions = {}): ArchiveExtraction {
  const limits = { ...DEFAULTS, ...opts };
  const archiveSha256 = hashBuffer(data);
  const members: ArchiveMember[] = [];
  const rejected: ArchiveRejection[] = [];
  const nestedArchives: string[] = [];
  const notes: string[] = [];
  let totalUncompressed = 0;

  const walk = (buffer: Buffer, depth: number, containerPath: string | undefined): void => {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(buffer));
    } catch (error) {
      rejected.push({
        path: containerPath ?? '(uploaded archive)',
        code: 'UNREADABLE',
        reason:
          `The archive could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
          `It may be corrupt, encrypted, or use a compression method this reader does not support.`,
      });
      return;
    }

    const compressedSize = buffer.length;
    let uncompressedInThisArchive = 0;

    for (const [rawPath, bytes] of Object.entries(entries)) {
      // Directory entries carry no content.
      if (rawPath.endsWith('/') || bytes.length === 0) continue;

      if (members.length >= limits.maxMembers) {
        rejected.push({
          path: rawPath,
          code: 'TOO_MANY_MEMBERS',
          reason: `The archive contains more than ${limits.maxMembers} files. Remaining entries were not read.`,
        });
        return;
      }

      const validation = validatePath(rawPath);
      if (!validation.ok) {
        rejected.push(validation.rejection);
        continue;
      }
      const path = validation.path;

      if (bytes.length > limits.maxMemberBytes) {
        rejected.push({
          path,
          code: 'TOO_LARGE',
          reason:
            `The entry expands to ${bytes.length.toLocaleString()} bytes, above the ` +
            `${limits.maxMemberBytes.toLocaleString()}-byte per-file limit.`,
        });
        continue;
      }

      if (totalUncompressed + bytes.length > limits.maxTotalBytes) {
        rejected.push({
          path,
          code: 'TOTAL_TOO_LARGE',
          reason:
            `Reading this entry would take the archive past the ` +
            `${limits.maxTotalBytes.toLocaleString()}-byte total limit. Extraction stopped here.`,
        });
        return;
      }

      const content = Buffer.from(bytes);
      totalUncompressed += content.length;
      uncompressedInThisArchive += content.length;

      const fullPath = containerPath ? `${containerPath}!/${path}` : path;
      const filename = path.split('/').pop() ?? path;

      // A nested archive is opened rather than treated as a file — but an
      // Office document is a ZIP too, and must NOT be unpacked here.
      if (isZipArchive(content) && !isOfficeOpenXml(filename)) {
        if (depth >= limits.maxDepth) {
          rejected.push({
            path: fullPath,
            code: 'NESTING_TOO_DEEP',
            reason:
              `Nested archives are opened to ${limits.maxDepth} level(s); this one is deeper. ` +
              `Extract it separately if its contents are needed.`,
          });
          continue;
        }
        nestedArchives.push(fullPath);
        walk(content, depth + 1, fullPath);
        continue;
      }

      members.push({
        path: fullPath,
        filename,
        content,
        sizeBytes: content.length,
        sha256: hashBuffer(content),
        depth,
        ...(containerPath ? { containerPath } : {}),
      });
    }

    // Ratio check runs per archive, after totals are known.
    if (compressedSize > 0) {
      const ratio = uncompressedInThisArchive / compressedSize;
      if (ratio > limits.maxCompressionRatio) {
        notes.push(
          `The archive ${containerPath ?? '(uploaded)'} expands ${ratio.toFixed(0)}× its compressed ` +
            `size, well above the ${limits.maxCompressionRatio}× threshold that genuine evidence ` +
            `reaches. Its contents were read but should be reviewed before import.`,
        );
      }
    }
  };

  walk(data, 0, undefined);

  if (nestedArchives.length > 0) {
    notes.push(
      `${nestedArchives.length} nested archive(s) were opened: ${nestedArchives.join(', ')}. ` +
        `Members from them carry the full path including the containing archive.`,
    );
  }

  return {
    members,
    rejected,
    archiveSha256,
    totalUncompressedBytes: totalUncompressed,
    nestedArchives,
    notes,
  };
}

/**
 * Files an evidence import should skip rather than attempt to parse.
 *
 * They are still hashed and recorded as part of the package — a cover letter is
 * evidence about the production even though it is not a record set.
 */
export function classifyMember(filename: string): {
  kind: 'TABULAR' | 'SPREADSHEET' | 'DOCUMENT' | 'GEOSPATIAL' | 'STRUCTURED' | 'UNKNOWN';
  parseable: boolean;
  note?: string;
} {
  const lower = filename.toLowerCase();

  if (/\.(csv|tsv|txt|tab|dat)$/.test(lower)) return { kind: 'TABULAR', parseable: true };
  if (/\.(xlsx|xlsm)$/.test(lower)) return { kind: 'SPREADSHEET', parseable: true };
  if (/\.xls$/.test(lower)) {
    return {
      kind: 'SPREADSHEET',
      parseable: false,
      note:
        'Legacy .xls (BIFF) workbooks are not read. Convert to .xlsx or CSV, and record the ' +
        'conversion in the case notes, before importing.',
    };
  }
  if (/\.(xml|json)$/.test(lower)) return { kind: 'STRUCTURED', parseable: false, note: 'Structured formats need a mapping defined before import.' };
  if (/\.(kml|kmz)$/.test(lower)) return { kind: 'GEOSPATIAL', parseable: false, note: 'Geospatial files are retained as evidence; import them through the map layer workflow.' };
  if (/\.(pdf|docx?|rtf)$/.test(lower)) {
    return {
      kind: 'DOCUMENT',
      parseable: false,
      note:
        'Retained as supplemental documentation. Cover letters frequently state the production ' +
        'timezone — check this document before importing the record sets.',
    };
  }
  return { kind: 'UNKNOWN', parseable: false, note: 'Retained but not parsed; the format was not recognised.' };
}
