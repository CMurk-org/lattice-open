// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Export formats: KML, GeoJSON and CSV.
 *
 * Exported evidence leaves this system and is read in tools that know nothing
 * about evidence layers. The disclosures therefore travel *inside* the export —
 * in KML placemark descriptions, in CSV columns, in GeoJSON properties — rather
 * than being left behind in the UI.
 *
 * A sector wedge opened in Google Earth with no caveat attached is exactly the
 * failure mode this product exists to prevent.
 */

import type { EvidenceLayer, GeoPoint } from '@cmurk/cellular-schema';

/**
 * A sector coverage outline, as produced by an analysis layer.
 *
 * Declared structurally rather than imported: an export utility renders a
 * polygon somebody else computed. It must not know, and must not imply, how
 * the geometry was derived — only how to write it out with its disclosures
 * intact.
 */
export type BeamWidthSource = 'CARRIER_SUPPLIED' | 'NOMINAL_ASSUMED';
export type RangeSource = 'CARRIER_SUPPLIED' | 'NOMINAL_ASSUMED' | 'TIMING_DERIVED';

export interface SectorWedge {
  /** GeoJSON-order ring: [lon, lat], explicitly closed. */
  readonly ring: readonly (readonly [number, number])[];
  readonly origin: GeoPoint;
  readonly azimuthDegrees?: number;
  readonly beamWidthDegrees: number;
  readonly beamWidthSource: BeamWidthSource;
  readonly rangeMeters: number;
  readonly rangeSource: RangeSource;
  readonly innerRadiusMeters: number;
  readonly isFullCircle: boolean;
  /** Everything the renderer must disclose about this geometry. */
  readonly disclosures: readonly string[];
}
/**
 * How each evidence layer is named in exported artifacts.
 *
 * These exact words appear in files opened outside this system, so they say
 * what the value *is* rather than which subsystem produced it.
 */
export const REPORT_LAYER_LABEL: Record<EvidenceLayer, string> = {
  OBSERVED: 'Carrier supplied',
  CALCULATED: 'Calculated',
  INFERRED: 'System inferred',
  ANALYST_ASSERTED: 'Analyst entered',
};

function xmlEscape(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** CDATA-safe wrapper for HTML descriptions inside KML. */
function cdata(html: string): string {
  return `<![CDATA[${html.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

// ---------------------------------------------------------------------------
// KML
// ---------------------------------------------------------------------------

export interface KmlSite {
  readonly siteKey: string;
  readonly name: string;
  readonly carrier: string;
  readonly position: GeoPoint;
  readonly address?: string;
}

export interface KmlSector {
  readonly sectorKey: string;
  readonly carrier: string;
  readonly wedge: SectorWedge;
  readonly technology?: string;
  readonly observationCount?: number;
}

export interface KmlObservation {
  readonly eventId: string;
  readonly identifierKey: string;
  readonly tsUtc: string;
  readonly sectorKey: string;
  /** Position of the SERVING SITE, never of the device. */
  readonly sitePosition: GeoPoint;
  readonly eventKind: string;
  readonly sourceFileId: string;
  readonly sourceRow: number;
}

export interface KmlExportInput {
  readonly caseNumber: string;
  readonly caseTitle: string;
  readonly generatedAt: string;
  readonly sites: readonly KmlSite[];
  readonly sectors: readonly KmlSector[];
  readonly observations?: readonly KmlObservation[];
  readonly displayTimezone: string;
}

/** Colours match the on-screen evidence-layer palette. KML is aabbggrr. */
const KML_LAYER_COLOR: Record<EvidenceLayer, { line: string; fill: string }> = {
  OBSERVED: { line: 'ff6e760f', fill: '4d6e760f' },
  CALCULATED: { line: 'ffd8411d', fill: '4dd8411d' },
  INFERRED: { line: 'ff0953b4', fill: '4d0953b4' },
  ANALYST_ASSERTED: { line: 'ffd9286d', fill: '4dd9286d' },
};

/**
 * Export cell topology and observations as KML.
 *
 * Sites are OBSERVED (the carrier stated the coordinate). Sector wedges are
 * CALCULATED (geometry derived from azimuth and beam width). Observations are
 * placed at the SERVING SITE and say so — a device is never given a coordinate.
 */
export function exportKml(input: KmlExportInput): string {
  const styles = (Object.keys(KML_LAYER_COLOR) as EvidenceLayer[])
    .map((layer) => {
      const color = KML_LAYER_COLOR[layer];
      return `<Style id="layer-${layer.toLowerCase()}">
    <LineStyle><color>${color.line}</color><width>2</width></LineStyle>
    <PolyStyle><color>${color.fill}</color></PolyStyle>
    <IconStyle><color>${color.line}</color><scale>0.9</scale>
      <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
    </IconStyle>
  </Style>`;
    })
    .join('\n  ');

  const sitePlacemarks = input.sites
    .map(
      (site) => `    <Placemark>
      <name>${xmlEscape(site.name)}</name>
      <styleUrl>#layer-observed</styleUrl>
      <description>${cdata(`
        <p><b>${REPORT_LAYER_LABEL.OBSERVED}</b> — this coordinate was supplied by the carrier in its
        cell site list.</p>
        <table>
          <tr><td><b>Site</b></td><td>${xmlEscape(site.siteKey)}</td></tr>
          <tr><td><b>Carrier</b></td><td>${xmlEscape(site.carrier)}</td></tr>
          ${site.address ? `<tr><td><b>Address</b></td><td>${xmlEscape(site.address)}</td></tr>` : ''}
        </table>
        <p><i>This is the location of the antenna installation, not of any device.</i></p>
      `)}</description>
      <Point><coordinates>${site.position.lon.toFixed(6)},${site.position.lat.toFixed(6)},0</coordinates></Point>
    </Placemark>`,
    )
    .join('\n');

  const sectorPlacemarks = input.sectors
    .map((sector) => {
      const ring = sector.wedge.ring
        .map(([lon, lat]) => `${lon.toFixed(6)},${lat.toFixed(6)},0`)
        .join(' ');

      const disclosures = sector.wedge.disclosures.length
        ? `<ul>${sector.wedge.disclosures.map((d) => `<li>${xmlEscape(d)}</li>`).join('')}</ul>`
        : '';

      return `    <Placemark>
      <name>${xmlEscape(sector.sectorKey)}</name>
      <styleUrl>#layer-calculated</styleUrl>
      <description>${cdata(`
        <p><b>${REPORT_LAYER_LABEL.CALCULATED}</b> — this shape was computed from the antenna azimuth
        and beam width the carrier supplied. It is not a coverage prediction and it is not a
        statement of where any device was.</p>
        <table>
          <tr><td><b>Sector</b></td><td>${xmlEscape(sector.sectorKey)}</td></tr>
          <tr><td><b>Carrier</b></td><td>${xmlEscape(sector.carrier)}</td></tr>
          ${sector.technology ? `<tr><td><b>Technology</b></td><td>${xmlEscape(sector.technology)}</td></tr>` : ''}
          <tr><td><b>Azimuth</b></td><td>${sector.wedge.azimuthDegrees !== undefined ? `${Math.round(sector.wedge.azimuthDegrees)}&#176; true` : 'not supplied'}</td></tr>
          <tr><td><b>Beam width</b></td><td>${Math.round(sector.wedge.beamWidthDegrees)}&#176; (${xmlEscape(sector.wedge.beamWidthSource === 'CARRIER_SUPPLIED' ? 'carrier supplied' : 'nominal, assumed')})</td></tr>
          <tr><td><b>Extent drawn</b></td><td>${Math.round(sector.wedge.rangeMeters)} m (${xmlEscape(sector.wedge.rangeSource.replace(/_/g, ' ').toLowerCase())})</td></tr>
          ${sector.observationCount !== undefined ? `<tr><td><b>Observations</b></td><td>${sector.observationCount}</td></tr>` : ''}
        </table>
        <p><b>Important:</b></p>${disclosures}
      `)}</description>
      <Polygon>
        <altitudeMode>clampToGround</altitudeMode>
        <outerBoundaryIs><LinearRing><coordinates>${ring}</coordinates></LinearRing></outerBoundaryIs>
      </Polygon>
    </Placemark>`;
    })
    .join('\n');

  const observationPlacemarks = (input.observations ?? [])
    .map(
      (obs) => `    <Placemark>
      <name>${xmlEscape(obs.identifierKey)} @ ${xmlEscape(obs.tsUtc)}</name>
      <styleUrl>#layer-observed</styleUrl>
      <TimeStamp><when>${xmlEscape(obs.tsUtc)}</when></TimeStamp>
      <description>${cdata(`
        <p><b>${REPORT_LAYER_LABEL.OBSERVED}</b> — the network recorded this identifier on this
        sector at this time.</p>
        <p><b style="color:#b45309">This marker is placed at the CELL SITE, not at the device.</b>
        The device was somewhere within the sector's coverage area, which is not shown by this point.</p>
        <table>
          <tr><td><b>Identifier</b></td><td>${xmlEscape(obs.identifierKey)}</td></tr>
          <tr><td><b>Time (UTC)</b></td><td>${xmlEscape(obs.tsUtc)}</td></tr>
          <tr><td><b>Sector</b></td><td>${xmlEscape(obs.sectorKey)}</td></tr>
          <tr><td><b>Event type</b></td><td>${xmlEscape(obs.eventKind)}</td></tr>
          <tr><td><b>Source</b></td><td>${xmlEscape(obs.sourceFileId)} row ${obs.sourceRow}</td></tr>
        </table>
      `)}</description>
      <Point><coordinates>${obs.sitePosition.lon.toFixed(6)},${obs.sitePosition.lat.toFixed(6)},0</coordinates></Point>
    </Placemark>`,
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>${xmlEscape(input.caseNumber)} — ${xmlEscape(input.caseTitle)}</name>
  <description>${cdata(`
    <p>Exported from Lattice at ${xmlEscape(input.generatedAt)}.</p>
    <p><b>Read this before interpreting anything in this file.</b></p>
    <ul>
      <li>Cell site points are the locations of antenna installations, supplied by the carrier.
          They are not device locations.</li>
      <li>Sector shapes are computed from the azimuth and beam width the carrier supplied. They
          represent the direction an antenna faces, not its actual coverage. Real coverage depends
          on terrain, buildings, network configuration and load, none of which are in carrier records.</li>
      <li>Observation markers are placed at the serving cell site because that is what the record
          establishes. The device was somewhere in the sector's coverage, not at the tower.</li>
      <li>Times are UTC. The case displays times in ${xmlEscape(input.displayTimezone)}.</li>
    </ul>
  `)}</description>

  ${styles}

  <Folder>
    <name>Cell sites (carrier supplied)</name>
${sitePlacemarks}
  </Folder>

  <Folder>
    <name>Sector geometry (calculated)</name>
${sectorPlacemarks}
  </Folder>
${observationPlacemarks ? `
  <Folder>
    <name>Observations (carrier supplied)</name>
    <description>${cdata('<p>Each marker sits at the serving cell site, not at the device.</p>')}</description>
${observationPlacemarks}
  </Folder>` : ''}
</Document>
</kml>`;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export interface CsvColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly value: (row: T) => string | number | undefined;
}

function csvEscape(value: string | number | undefined): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  // Neutralise spreadsheet formula injection: a value starting with =, +, -
  // or @ is executed by Excel and Sheets on open. Evidence exports must never
  // become an attack vector against the analyst who opens them.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * Render rows as CSV with a provenance preamble.
 *
 * The preamble is commented so it does not corrupt the header row, and carries
 * the case, the export time and the standing caveat, so a CSV that escapes into
 * an email thread still says what it is.
 */
export function exportCsv<T>(
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
  meta: { caseNumber: string; title: string; generatedAt: string; notes?: readonly string[] },
): string {
  const preamble = [
    `# Lattice export — ${meta.caseNumber} — ${meta.title}`,
    `# Generated ${meta.generatedAt}`,
    '# Records showing a device served by a cell sector do not establish where that device was.',
    '# A device or subscriber identifier is not a person.',
    ...(meta.notes ?? []).map((note) => `# ${note}`),
  ].join('\r\n');

  const header = columns.map((column) => csvEscape(column.header)).join(',');
  const body = rows
    .map((row) => columns.map((column) => csvEscape(column.value(row))).join(','))
    .join('\r\n');

  return `${preamble}\r\n${header}\r\n${body}\r\n`;
}

// ---------------------------------------------------------------------------
// GeoJSON
// ---------------------------------------------------------------------------

/**
 * Wrap a feature collection with export metadata.
 *
 * GeoJSON has no standard metadata slot, so the caveats go into a top-level
 * `properties` member alongside the collection. Every feature also keeps its
 * own `layer` property.
 */
export function exportGeoJson(
  features: readonly unknown[],
  meta: { caseNumber: string; title: string; generatedAt: string },
): string {
  return JSON.stringify(
    {
      type: 'FeatureCollection',
      properties: {
        source: 'Lattice',
        caseNumber: meta.caseNumber,
        caseTitle: meta.title,
        generatedAt: meta.generatedAt,
        readBeforeUse: [
          'Cell site points are antenna installation locations supplied by the carrier, not device locations.',
          'Sector polygons are computed from carrier-supplied azimuth and beam width. They are not coverage predictions.',
          'Credible regions are inferences about where evidence permits a device to have been, not records of where it was.',
          'Each feature carries a "layer" property: OBSERVED, CALCULATED, INFERRED or ANALYST_ASSERTED.',
        ],
      },
      features,
    },
    null,
    2,
  );
}
