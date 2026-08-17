// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import ExcelJS from 'exceljs';
import { extractArchive, isZipArchive, isOfficeOpenXml, classifyMember } from './archive';
import { readWorkbook, sheetAsDelimitedText, isXlsx, spreadsheetRowHash } from './xlsx';
import { defaultRegistry } from './registry';
import { normalizeEvents } from './normalize';
import { ATT_TOWER_DUMP } from './carriers';
import { hashBuffer, hashSourceRow } from '@cmurk/cellular-schema';

const zip = (files: Record<string, string | Uint8Array>): Buffer =>
  Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([path, content]) => [
          path,
          typeof content === 'string' ? strToU8(content) : content,
        ]),
      ),
    ),
  );

const ATT_CSV = [
  'Target Number,IMSI,IMEI,Date/Time,Call Type,Direction,Duration (sec),Other Party,Cell ID,Site,Sector,Technology,Timing Advance,RSRP',
  '3035551000,310410123456789,352099001761481,03/15/2024 10:31:42 PM,VOICE,MO,60,3035551001,12345601,100001,A,LTE,15,-85',
  '3035551002,310410123456790,352099001761499,03/15/2024 10:35:10 PM,SMS,MT,0,3035551003,12345601,100001,A,LTE,22,-92',
].join('\r\n');

describe('archive detection', () => {
  it('recognises a ZIP by magic bytes', () => {
    expect(isZipArchive(zip({ 'a.txt': 'x' }))).toBe(true);
    expect(isZipArchive(Buffer.from('not a zip'))).toBe(false);
    expect(isZipArchive(Buffer.alloc(2))).toBe(false);
  });

  it('does not treat an Office document as an archive to unpack', () => {
    // XLSX is a ZIP. Unpacking it as an archive would scatter its XML parts
    // through the evidence package instead of parsing the workbook.
    expect(isOfficeOpenXml('production.xlsx')).toBe(true);
    expect(isOfficeOpenXml('records.docx')).toBe(true);
    expect(isOfficeOpenXml('records.csv')).toBe(false);
  });
});

describe('archive extraction', () => {
  it('extracts members and hashes each independently', () => {
    const archive = zip({
      'ATT_TowerDump.csv': ATT_CSV,
      'ATT_CellSiteList.csv': 'Cell ID,Site,Sector,Latitude,Longitude\n1,100001,A,39.7,-104.9\n',
      'CoverLetter.txt': 'All times are Mountain Time.',
    });

    const result = extractArchive(archive);
    expect(result.members).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
    expect(result.archiveSha256).toBe(hashBuffer(archive));

    const dump = result.members.find((m) => m.filename === 'ATT_TowerDump.csv')!;
    expect(dump.sha256).toBe(hashBuffer(Buffer.from(ATT_CSV)));
    expect(dump.content.toString('utf8')).toBe(ATT_CSV);
  });

  it('preserves the path inside the archive for provenance', () => {
    const archive = zip({ 'production/2024-03/ATT_TowerDump.csv': ATT_CSV });
    const result = extractArchive(archive);
    expect(result.members[0]!.path).toBe('production/2024-03/ATT_TowerDump.csv');
    expect(result.members[0]!.filename).toBe('ATT_TowerDump.csv');
  });

  it('extracted members feed the normal detection pipeline unchanged', () => {
    const archive = zip({ 'ATT_TowerDump.csv': ATT_CSV });
    const member = extractArchive(archive).members[0]!;
    const decision = defaultRegistry.route({
      filename: member.filename,
      sample: member.content.toString('utf8'),
    });
    expect(decision.kind).toBe('AUTO');
    if (decision.kind === 'AUTO') expect(decision.parser.id).toBe('att.tower-dump');
  });

  it('skips directory entries', () => {
    const archive = zip({ 'folder/': '', 'folder/file.csv': ATT_CSV });
    const result = extractArchive(archive);
    expect(result.members).toHaveLength(1);
  });
});

describe('archive defences', () => {
  it('refuses a zip-slip path traversal entry', () => {
    const archive = zip({ '../../etc/passwd': 'root:x:0:0', 'good.csv': ATT_CSV });
    const result = extractArchive(archive);

    expect(result.members).toHaveLength(1);
    expect(result.members[0]!.filename).toBe('good.csv');

    const rejection = result.rejected.find((r) => r.code === 'PATH_TRAVERSAL');
    expect(rejection).toBeDefined();
    expect(rejection!.reason).toMatch(/zip-slip/i);
  });

  it('refuses an absolute path entry', () => {
    const archive = zip({ 'C:/Windows/system32/evil.dll': 'x' });
    const result = extractArchive(archive);
    expect(result.members).toHaveLength(0);
    expect(result.rejected[0]!.code).toBe('ABSOLUTE_PATH');
  });

  it('refuses a member larger than the per-file limit', () => {
    const archive = zip({ 'big.csv': 'x'.repeat(5000) });
    const result = extractArchive(archive, { maxMemberBytes: 1000 });
    expect(result.members).toHaveLength(0);
    expect(result.rejected[0]!.code).toBe('TOO_LARGE');
  });

  it('stops at the total size limit rather than exhausting memory', () => {
    const archive = zip({
      'a.csv': 'x'.repeat(2000),
      'b.csv': 'y'.repeat(2000),
      'c.csv': 'z'.repeat(2000),
    });
    const result = extractArchive(archive, { maxTotalBytes: 3000 });
    expect(result.totalUncompressedBytes).toBeLessThanOrEqual(3000);
    expect(result.rejected.some((r) => r.code === 'TOTAL_TOO_LARGE')).toBe(true);
  });

  it('flags an implausible compression ratio as a probable zip bomb', () => {
    // Highly repetitive content compresses far beyond anything genuine evidence does.
    const archive = zip({ 'bomb.txt': '0'.repeat(2_000_000) });
    const result = extractArchive(archive, { maxTotalBytes: 10_000_000, maxMemberBytes: 10_000_000 });
    expect(result.notes.some((n) => /well above the .*threshold/i.test(n))).toBe(true);
  });

  it('caps member count', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 50; i += 1) files[`f${i}.csv`] = 'x';
    const result = extractArchive(zip(files), { maxMembers: 10 });
    expect(result.members).toHaveLength(10);
    expect(result.rejected.some((r) => r.code === 'TOO_MANY_MEMBERS')).toBe(true);
  });

  it('opens nested archives to the configured depth and refuses deeper', () => {
    const inner = zip({ 'inner.csv': ATT_CSV });
    const middle = zip({ 'middle.zip': new Uint8Array(inner) });
    const outer = zip({ 'outer.zip': new Uint8Array(middle) });

    const shallow = extractArchive(outer, { maxDepth: 1 });
    expect(shallow.rejected.some((r) => r.code === 'NESTING_TOO_DEEP')).toBe(true);

    const deep = extractArchive(outer, { maxDepth: 3 });
    expect(deep.members).toHaveLength(1);
    expect(deep.members[0]!.path).toMatch(/outer\.zip!\/middle\.zip!\/inner\.csv/);
    expect(deep.nestedArchives.length).toBeGreaterThan(0);
  });

  it('reports an unreadable archive rather than throwing', () => {
    const result = extractArchive(Buffer.from('PK\x03\x04 corrupted garbage'));
    expect(result.members).toHaveLength(0);
    expect(result.rejected[0]!.code).toBe('UNREADABLE');
  });

  it('never silently drops an entry — every refusal is reported', () => {
    const archive = zip({ '../escape.csv': 'x', '/abs.csv': 'y', 'ok.csv': ATT_CSV });
    const result = extractArchive(archive);
    expect(result.members.length + result.rejected.length).toBe(3);
  });
});

describe('member classification', () => {
  it('marks record sets parseable and documents as retained-only', () => {
    expect(classifyMember('dump.csv').parseable).toBe(true);
    expect(classifyMember('dump.xlsx').parseable).toBe(true);
    expect(classifyMember('cover.pdf').parseable).toBe(false);
    expect(classifyMember('cover.pdf').note).toMatch(/timezone/i);
  });

  it('refuses legacy .xls with an actionable message rather than failing later', () => {
    const legacy = classifyMember('production.xls');
    expect(legacy.parseable).toBe(false);
    expect(legacy.note).toMatch(/Convert to \.xlsx or CSV/);
  });
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

async function makeWorkbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  build(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('XLSX ingestion', () => {
  it('converts a sheet into a document the existing parsers detect', async () => {
    const buffer = await makeWorkbook((wb) => {
      const sheet = wb.addWorksheet('Tower Dump');
      sheet.addRow(['Target Number', 'IMSI', 'IMEI', 'Date/Time', 'Call Type', 'Direction', 'Duration (sec)', 'Other Party', 'Cell ID', 'Site', 'Sector', 'Technology', 'Timing Advance', 'RSRP']);
      sheet.addRow(['3035551000', '310410123456789', '352099001761481', '03/15/2024 10:31:42 PM', 'VOICE', 'MO', 60, '3035551001', '12345601', '100001', 'A', 'LTE', 15, -85]);
      sheet.addRow(['3035551002', '310410123456790', '352099001761499', '03/15/2024 10:35:10 PM', 'SMS', 'MT', 0, '3035551003', '12345601', '100001', 'A', 'LTE', 22, -92]);
    });

    const workbook = await readWorkbook(buffer);
    expect(workbook.sheets).toHaveLength(1);

    const sheet = workbook.sheets[0]!;
    expect(sheet.sheetName).toBe('Tower Dump');
    expect(sheet.document.origin).toBe('SPREADSHEET');
    expect(sheet.document.headers[0]).toBe('Target Number');
    expect(sheet.rowCount).toBe(2);

    // The whole point: detection works on a spreadsheet with no changes.
    const decision = defaultRegistry.route({ filename: 'production.xlsx', document: sheet.document });
    expect(decision.kind).toBe('AUTO');
    if (decision.kind === 'AUTO') expect(decision.parser.id).toBe('att.tower-dump');
  });

  it('normalizes spreadsheet rows into events with correct identifiers', async () => {
    const buffer = await makeWorkbook((wb) => {
      const sheet = wb.addWorksheet('Sheet1');
      sheet.addRow(['Target Number', 'IMSI', 'IMEI', 'Date/Time', 'Call Type', 'Direction', 'Duration (sec)', 'Other Party', 'Cell ID', 'Site', 'Sector', 'Technology', 'Timing Advance', 'RSRP']);
      sheet.addRow(['3035551000', '310410123456789', '352099001761481', '03/15/2024 10:31:42 PM', 'VOICE', 'MO', 60, '3035551001', '12345601', '100001', 'A', 'LTE', 15, -85]);
    });

    const sheet = (await readWorkbook(buffer)).sheets[0]!;
    const result = normalizeEvents(ATT_TOWER_DUMP, sheet.document, {
      caseId: 'case_1',
      packageId: 'pkg_1',
      sourceFileId: 'file_1',
      sourceSheet: sheet.sheetName,
      declaredTimezone: 'America/Denver',
    });

    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.imsi).toBe('310410123456789');
    expect(event.imei).toBe('35209900176148');
    expect(event.tsUtc).toBe('2024-03-16T04:31:42.000Z');
    expect(event.sourceSheet).toBe('Sheet1');
  });

  it('produces one document per sheet', async () => {
    const buffer = await makeWorkbook((wb) => {
      wb.addWorksheet('Voice').addRow(['A', 'B']);
      wb.addWorksheet('Data').addRow(['C', 'D']);
      wb.addWorksheet('Sites').addRow(['E', 'F']);
    });
    const workbook = await readWorkbook(buffer);
    expect(workbook.sheets.map((s) => s.sheetName)).toEqual(['Voice', 'Data', 'Sites']);
    expect(workbook.notes.some((n) => /contains 3 sheets/.test(n))).toBe(true);
  });

  it('renders dates as ISO-8601 and discloses why', async () => {
    const buffer = await makeWorkbook((wb) => {
      const sheet = wb.addWorksheet('Sheet1');
      sheet.addRow(['When', 'What']);
      sheet.addRow([new Date('2024-03-15T22:31:42.000Z'), 'VOICE']);
    });

    const sheet = (await readWorkbook(buffer)).sheets[0]!;
    expect(sheet.document.rows[0]!.fields[0]).toBe('2024-03-15T22:31:42.000Z');
    expect(sheet.notes.some((n) => /ISO-8601/.test(n) && /locale/.test(n))).toBe(true);
  });

  it('flags formulas — a raw carrier export does not contain them', async () => {
    const buffer = await makeWorkbook((wb) => {
      const sheet = wb.addWorksheet('Sheet1');
      sheet.addRow(['A', 'B']);
      sheet.addRow([1, { formula: 'A2*2', result: 2 }]);
    });

    const workbook = await readWorkbook(buffer);
    expect(workbook.sheetsWithFormulas).toContain('Sheet1');
    expect(workbook.sheets[0]!.notes.some((n) => /derived or edited after production/i.test(n))).toBe(true);
    // The cached result is read, not the formula text.
    expect(workbook.sheets[0]!.document.rows[0]!.fields[1]).toBe('2');
  });

  it('is honest that spreadsheet row hashes are canonical, not byte-exact', async () => {
    const buffer = await makeWorkbook((wb) => {
      const sheet = wb.addWorksheet('Sheet1');
      sheet.addRow(['A', 'B']);
      sheet.addRow(['1', '2']);
    });

    const workbook = await readWorkbook(buffer);
    expect(workbook.notes.some((n) => /no byte-exact source line/i.test(n))).toBe(true);

    // The hash is reproducible: re-reading and re-canonicalising matches.
    const again = await readWorkbook(buffer);
    expect(spreadsheetRowHash(workbook.sheets[0]!.document.rows[0]!)).toBe(
      spreadsheetRowHash(again.sheets[0]!.document.rows[0]!),
    );
  });

  it('keeps the row hash consistent across the text conversion', async () => {
    // The hash computed at read time must match the one normalizeEvents
    // computes from the delimited text, or the provenance chain breaks.
    const buffer = await makeWorkbook((wb) => {
      const sheet = wb.addWorksheet('Sheet1');
      sheet.addRow(['Target Number', 'IMSI', 'IMEI', 'Date/Time', 'Cell ID']);
      sheet.addRow(['3035551000', '310410123456789', '352099001761481', '03/15/2024 10:31:42 PM', '12345601']);
    });

    const sheet = (await readWorkbook(buffer)).sheets[0]!;
    const row = sheet.document.rows[0]!;
    const lineInText = sheetAsDelimitedText(sheet).split('\n')[1]!;
    expect(hashSourceRow(lineInText)).toBe(spreadsheetRowHash(row));
  });

  it('reports an empty sheet rather than failing', async () => {
    const buffer = await makeWorkbook((wb) => { wb.addWorksheet('Empty'); });
    const workbook = await readWorkbook(buffer);
    expect(workbook.sheets[0]!.empty).toBe(true);
    expect(workbook.sheets[0]!.notes[0]).toMatch(/no populated rows/i);
  });

  it('rejects a non-workbook with an actionable message', async () => {
    await expect(readWorkbook(Buffer.from('not a workbook'))).rejects.toThrow(/could not be read/i);
  });

  it('detects XLSX by content as well as extension', async () => {
    const buffer = await makeWorkbook((wb) => { wb.addWorksheet('S').addRow(['A']); });
    expect(isXlsx('production.xlsx')).toBe(true);
    expect(isXlsx('no-extension', buffer)).toBe(true);
    expect(isXlsx('plain.csv', Buffer.from('a,b,c'))).toBe(false);
  });

  it('carries a workbook inside an archive all the way to detection', async () => {
    const workbookBuffer = await makeWorkbook((wb) => {
      const sheet = wb.addWorksheet('Dump');
      sheet.addRow(['Target Number', 'IMSI', 'IMEI', 'Date/Time', 'Call Type', 'Direction', 'Duration (sec)', 'Other Party', 'Cell ID', 'Site', 'Sector', 'Technology', 'Timing Advance', 'RSRP']);
      sheet.addRow(['3035551000', '310410123456789', '352099001761481', '03/15/2024 10:31:42 PM', 'VOICE', 'MO', 60, '3035551001', '12345601', '100001', 'A', 'LTE', 15, -85]);
    });

    const archive = zip({
      'production/ATT_Records.xlsx': new Uint8Array(workbookBuffer),
      'production/CoverLetter.txt': 'All times Mountain.',
    });

    const extraction = extractArchive(archive);
    // The workbook must survive as a single member, not be unpacked as a ZIP.
    const member = extraction.members.find((m) => m.filename === 'ATT_Records.xlsx');
    expect(member).toBeDefined();
    expect(isXlsx(member!.filename, member!.content)).toBe(true);

    const sheet = (await readWorkbook(member!.content)).sheets[0]!;
    const decision = defaultRegistry.route({
      filename: member!.filename,
      document: sheet.document,
    });
    expect(decision.kind).toBe('AUTO');
  });
});
