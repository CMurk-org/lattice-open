// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * XLSX ingestion.
 *
 * Each worksheet is converted into the same `TabularDocument` the delimited
 * reader produces, so every parser definition, detection signal and
 * normalization rule works on spreadsheets unchanged. A workbook with four
 * sheets becomes four documents; the analyst chooses which hold record sets.
 *
 * ── An honesty point about row hashes ────────────────────────────────────────
 *
 * A CSV row has a byte-exact original line, and its hash proves the displayed
 * row is the row that was analysed. A spreadsheet row has no such thing: the
 * cells live in compressed XML, split across a shared-string table, with
 * formatting held separately. There is nothing to hash byte-for-byte.
 *
 * So spreadsheet rows are hashed over a DEFINED CANONICAL FORM — the cell
 * display values, tab-joined, in column order. That is still verifiable:
 * re-reading the same workbook and re-canonicalising reproduces the hash. But
 * it is a weaker claim than the byte-exact one, and the system says so rather
 * than letting a reader assume otherwise. The workbook file itself is still
 * hashed byte-exactly, so file-level integrity is unaffected.
 *
 * ── Values ───────────────────────────────────────────────────────────────────
 *
 * Date cells are rendered as ISO-8601 rather than as Excel displays them.
 * Excel stores a date as a serial number and renders it through a locale
 * format, so the displayed text of the same cell differs between machines.
 * ISO-8601 is unambiguous, and the conversion is disclosed on the document.
 */

import ExcelJS from 'exceljs';
import { hashSourceRow } from '@cmurk/cellular-schema';
import type { TabularDocument, TabularRow } from './tabular';

export interface WorkbookSheet {
  readonly document: TabularDocument;
  readonly sheetName: string;
  readonly sheetIndex: number;
  readonly rowCount: number;
  /** Things about this sheet the analyst must see before importing it. */
  readonly notes: readonly string[];
  /** True when the sheet holds no usable tabular data. */
  readonly empty: boolean;
}

export interface WorkbookRead {
  readonly sheets: readonly WorkbookSheet[];
  readonly notes: readonly string[];
  /** Sheets containing formulas — a sign the file was derived, not exported raw. */
  readonly sheetsWithFormulas: readonly string[];
}

/** The canonical row form spreadsheet hashes are computed over. */
export const SPREADSHEET_ROW_CANONICAL_FORM =
  'Cell display values, tab-joined in column order, trailing empty cells removed.';

function canonicalRow(fields: readonly string[]): string {
  // Trailing empties are dropped so a row is not hashed differently because
  // Excel happened to record an extra blank cell.
  const trimmed = [...fields];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed.join('\t');
}

/**
 * Render a cell to text.
 *
 * Returns the string the analyst would see, except for dates, which are
 * rendered ISO-8601 for the reason given at the top of this file.
 */
function cellText(cell: ExcelJS.Cell): { text: string; isFormula: boolean; isDate: boolean } {
  const value = cell.value;

  if (value === null || value === undefined) return { text: '', isFormula: false, isDate: false };

  if (value instanceof Date) {
    return { text: value.toISOString(), isFormula: false, isDate: true };
  }

  if (typeof value === 'object') {
    // Formula cell: use the cached result the carrier's export wrote.
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      if (result instanceof Date) return { text: result.toISOString(), isFormula: true, isDate: true };
      if (result === null || result === undefined) return { text: '', isFormula: true, isDate: false };
      if (typeof result === 'object' && 'error' in result) {
        return { text: String(result.error), isFormula: true, isDate: false };
      }
      return { text: String(result), isFormula: true, isDate: false };
    }
    // Rich text: concatenate the runs.
    if ('richText' in value) {
      return {
        text: (value as ExcelJS.CellRichTextValue).richText.map((run) => run.text).join(''),
        isFormula: false,
        isDate: false,
      };
    }
    // Hyperlink cell: the visible text, not the target.
    if ('text' in value) {
      return { text: String((value as ExcelJS.CellHyperlinkValue).text), isFormula: false, isDate: false };
    }
    if ('error' in value) {
      return { text: String((value as ExcelJS.CellErrorValue).error), isFormula: false, isDate: false };
    }
  }

  return { text: String(value), isFormula: false, isDate: false };
}

export interface XlsxReadOptions {
  /** Maximum data rows per sheet. Used when sampling for detection. */
  readonly limit?: number;
  /** Skip leading rows before the header, for sheets with a title block. */
  readonly skipRows?: number;
}

/**
 * Read a workbook into one `TabularDocument` per sheet.
 */
export async function readWorkbook(data: Buffer, opts: XlsxReadOptions = {}): Promise<WorkbookRead> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
  } catch (error) {
    throw new Error(
      `The workbook could not be read: ${error instanceof Error ? error.message : String(error)}. ` +
        `It may be corrupt, password-protected, or a legacy .xls file rather than .xlsx.`,
    );
  }

  const sheets: WorkbookSheet[] = [];
  const notes: string[] = [];
  const sheetsWithFormulas: string[] = [];

  workbook.eachSheet((worksheet, sheetId) => {
    const sheetNotes: string[] = [];
    let sawFormula = false;
    let sawDate = false;

    const skip = opts.skipRows ?? 0;
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;

    // Collect every populated row as text fields.
    const collected: { rowNumber: number; fields: string[] }[] = [];
    const maxColumn = worksheet.columnCount;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= skip) return;
      if (collected.length > limit + 1) return;

      const fields: string[] = [];
      for (let column = 1; column <= maxColumn; column += 1) {
        const rendered = cellText(row.getCell(column));
        if (rendered.isFormula) sawFormula = true;
        if (rendered.isDate) sawDate = true;
        fields.push(rendered.text.trim());
      }
      // Skip rows that are entirely blank.
      if (fields.some((field) => field !== '')) {
        collected.push({ rowNumber, fields });
      }
    });

    if (collected.length === 0) {
      sheets.push({
        document: emptyDocument(worksheet.name),
        sheetName: worksheet.name,
        sheetIndex: sheetId,
        rowCount: 0,
        notes: ['This sheet contains no populated rows.'],
        empty: true,
      });
      return;
    }

    const headerEntry = collected[0]!;
    const headers = headerEntry.fields.map((field) => field.trim());

    // Trailing unnamed columns are common in spreadsheets; drop them from the
    // header so column counts line up, but say so.
    let effectiveWidth = headers.length;
    while (effectiveWidth > 0 && headers[effectiveWidth - 1] === '') effectiveWidth -= 1;
    if (effectiveWidth < headers.length) {
      sheetNotes.push(
        `${headers.length - effectiveWidth} trailing column(s) had no header and were excluded from ` +
          `the column mapping. Any values in them are retained as unmapped fields.`,
      );
    }
    const trimmedHeaders = headers.slice(0, effectiveWidth);

    const headerRow: TabularRow = {
      row: headerEntry.rowNumber,
      raw: canonicalRow(headerEntry.fields),
      fields: trimmedHeaders,
      offset: 0,
    };

    const rows: TabularRow[] = [];
    const raggedRows: { row: number; expected: number; actual: number }[] = [];

    for (const entry of collected.slice(1)) {
      if (rows.length >= limit) break;
      const fields = entry.fields.slice(0, effectiveWidth);
      // Count populated cells beyond the header width as a ragged row.
      const populatedWidth = entry.fields.reduce(
        (width, field, index) => (field !== '' ? index + 1 : width),
        0,
      );
      if (populatedWidth > effectiveWidth) {
        raggedRows.push({ row: entry.rowNumber, expected: effectiveWidth, actual: populatedWidth });
      }
      rows.push({
        row: entry.rowNumber,
        raw: canonicalRow(entry.fields),
        fields,
        offset: 0,
      });
    }

    if (sawFormula) {
      sheetsWithFormulas.push(worksheet.name);
      sheetNotes.push(
        'This sheet contains formulas. A raw carrier export does not; formulas mean the workbook ' +
          'was derived or edited after production. The cached formula results were read. Establish ' +
          'the provenance of this file before relying on it.',
      );
    }
    if (sawDate) {
      sheetNotes.push(
        'Date-typed cells were rendered as ISO-8601 from the values Excel stored. Excel displays ' +
          'the same cell differently depending on the machine locale, so the displayed text is not ' +
          'used.',
      );
    }

    sheets.push({
      document: {
        delimiter: '\t',
        origin: 'SPREADSHEET',
        sheetName: worksheet.name,
        headers: trimmedHeaders,
        headerRow,
        rows,
        raggedRows,
        hadBom: false,
        lineEnding: 'LF',
      },
      sheetName: worksheet.name,
      sheetIndex: sheetId,
      rowCount: rows.length,
      notes: sheetNotes,
      empty: false,
    });
  });

  if (sheets.length > 1) {
    notes.push(
      `The workbook contains ${sheets.length} sheets: ${sheets.map((s) => s.sheetName).join(', ')}. ` +
        `Each is treated as a separate table and detected independently.`,
    );
  }
  notes.push(
    `Spreadsheet rows have no byte-exact source line, so row hashes are computed over a canonical ` +
      `form: ${SPREADSHEET_ROW_CANONICAL_FORM} The workbook file itself is hashed byte-exactly.`,
  );

  return { sheets, notes, sheetsWithFormulas };
}

function emptyDocument(sheetName: string): TabularDocument {
  return {
    delimiter: '\t',
    origin: 'SPREADSHEET',
    sheetName,
    headers: [],
    headerRow: { row: 1, raw: '', fields: [], offset: 0 },
    rows: [],
    raggedRows: [],
    hadBom: false,
    lineEnding: 'LF',
  };
}

/**
 * Serialise a sheet as delimited text.
 *
 * The detection and normalization engines take text, so a sheet is handed to
 * them in this form. Tab-delimited with the same canonicalisation used for row
 * hashes, so the hash a row receives during import matches the one computed
 * here — the provenance chain stays intact across the conversion.
 */
export function sheetAsDelimitedText(sheet: WorkbookSheet): string {
  const lines = [sheet.document.headerRow.raw, ...sheet.document.rows.map((row) => row.raw)];
  return lines.join('\n');
}

/** Row hash for a spreadsheet row, over the canonical form. */
export function spreadsheetRowHash(row: TabularRow): string {
  return hashSourceRow(row.raw);
}

export function isXlsx(filename: string, data?: Buffer): boolean {
  if (/\.(xlsx|xlsm)$/i.test(filename)) return true;
  // XLSX is a ZIP whose first member is conventionally [Content_Types].xml.
  if (data && data.length > 30) {
    const head = data.subarray(0, 4);
    if (head[0] === 0x50 && head[1] === 0x4b) {
      return data.subarray(0, 200).includes(Buffer.from('[Content_Types].xml'));
    }
  }
  return false;
}
