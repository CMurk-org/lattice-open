// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Delimited-text reading with forensic locators.
 *
 * Every row yielded carries the exact original text and its 1-based row number,
 * because that pair is what "VIEW SOURCE" resolves and what the row hash is
 * computed over. A reader that discards the original text makes provenance
 * unverifiable, so this one never does.
 *
 * Handles the delimiters and quoting conventions carrier productions actually
 * use: comma, tab, pipe and semicolon; RFC 4180 double-quote escaping;
 * CRLF/LF/CR line endings; and a UTF-8 BOM.
 */

export type Delimiter = ',' | '\t' | '|' | ';';

export interface TabularRow {
  /** 1-based row number in the file, counting the header row as row 1. */
  readonly row: number;
  /** Exactly the bytes of this record, without the line terminator. */
  readonly raw: string;
  readonly fields: readonly string[];
  /** Byte offset of the record start within the decoded text. */
  readonly offset: number;
}

export interface TabularDocument {
  readonly delimiter: Delimiter;
  /**
   * Where the rows came from.
   *
   * DELIMITED rows have a byte-exact original line, so their hash is over the
   * source bytes. SPREADSHEET rows do not exist as text — the cells live in
   * XML — so their hash is over a defined canonical form. The provenance
   * viewer words its verification message differently for each, because
   * claiming a byte-exact match for a spreadsheet row would be false.
   */
  readonly origin?: 'DELIMITED' | 'SPREADSHEET';
  /** Worksheet name, for spreadsheet sources. */
  readonly sheetName?: string;
  readonly headers: readonly string[];
  readonly headerRow: TabularRow;
  readonly rows: readonly TabularRow[];
  /** Rows whose field count differs from the header, retained not discarded. */
  readonly raggedRows: readonly { row: number; expected: number; actual: number }[];
  readonly hadBom: boolean;
  readonly lineEnding: 'CRLF' | 'LF' | 'CR' | 'MIXED';
}

const DELIMITERS: Delimiter[] = [',', '\t', '|', ';'];

/**
 * Detect the delimiter by scoring consistency of field counts across the first
 * several lines. Frequency alone is unreliable — a comma-delimited file full of
 * addresses has plenty of stray commas inside quotes.
 */
export function detectDelimiter(text: string, sampleLines = 20): Delimiter {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim().length > 0).slice(0, sampleLines);
  if (lines.length === 0) return ',';

  let best: { delimiter: Delimiter; score: number } = { delimiter: ',', score: -1 };

  for (const delimiter of DELIMITERS) {
    const counts = lines.map((line) => splitLine(line, delimiter).length);
    const first = counts[0] ?? 0;
    if (first < 2) continue;
    // Reward many fields, penalise inconsistency between lines.
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 100 + first;
    if (score > best.score) best = { delimiter, score };
  }

  return best.score < 0 ? ',' : best.delimiter;
}

/** RFC 4180 field splitting for a single already-extracted line. */
function splitLine(line: string, delimiter: Delimiter): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Split text into records, honouring quoted fields that contain line breaks.
 * Returns each record's text and its byte offset.
 */
function splitRecords(text: string, delimiter: Delimiter): { raw: string; offset: number }[] {
  const records: { raw: string; offset: number }[] = [];
  let current = '';
  let start = 0;
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      records.push({ raw: current, offset: start });
      current = '';
      // Consume a CRLF pair as one terminator.
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      start = i + 1;
      continue;
    }

    current += char;
  }

  if (current.length > 0) records.push({ raw: current, offset: start });
  return records;
}

export interface ReadOptions {
  readonly delimiter?: Delimiter;
  /** Skip leading lines before the header, for files with preamble text. */
  readonly skipLines?: number;
  /** Maximum data rows to read; used for sampling during detection. */
  readonly limit?: number;
}

export function readTabular(input: string, opts: ReadOptions = {}): TabularDocument {
  const hadBom = input.charCodeAt(0) === 0xfeff;
  let text = hadBom ? input.slice(1) : input;

  const lineEnding = detectLineEnding(text);
  const delimiter = opts.delimiter ?? detectDelimiter(text);

  const skip = opts.skipLines ?? 0;
  if (skip > 0) {
    const records = splitRecords(text, delimiter);
    text = records.slice(skip).map((r) => r.raw).join('\n');
  }

  const records = splitRecords(text, delimiter).filter((r) => r.raw.trim().length > 0);
  if (records.length === 0) {
    throw new Error('The file contains no readable rows.');
  }

  const headerRecord = records[0]!;
  const headers = splitLine(headerRecord.raw, delimiter).map((h) => h.trim());
  const headerRow: TabularRow = {
    row: 1 + skip,
    raw: headerRecord.raw,
    fields: headers,
    offset: headerRecord.offset,
  };

  const rows: TabularRow[] = [];
  const raggedRows: { row: number; expected: number; actual: number }[] = [];
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;

  for (let i = 1; i < records.length && rows.length < limit; i += 1) {
    const record = records[i]!;
    const fields = splitLine(record.raw, delimiter);
    const rowNumber = i + 1 + skip;
    if (fields.length !== headers.length) {
      raggedRows.push({ row: rowNumber, expected: headers.length, actual: fields.length });
    }
    rows.push({ row: rowNumber, raw: record.raw, fields, offset: record.offset });
  }

  return { delimiter, origin: 'DELIMITED', headers, headerRow, rows, raggedRows, hadBom, lineEnding };
}

function detectLineEnding(text: string): TabularDocument['lineEnding'] {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  const present = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (present > 1) return 'MIXED';
  if (crlf > 0) return 'CRLF';
  if (cr > 0) return 'CR';
  return 'LF';
}

/** Look up a field by header name, tolerant of case and surrounding whitespace. */
export function fieldValue(
  row: TabularRow,
  headers: readonly string[],
  name: string,
): string | undefined {
  const index = headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
  if (index < 0) return undefined;
  const value = row.fields[index];
  return value === undefined ? undefined : value.trim();
}

/** Build a header → index map once, for hot loops. */
export function headerIndex(headers: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((header, index) => {
    map.set(header.trim().toLowerCase(), index);
  });
  return map;
}
