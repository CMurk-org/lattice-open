// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Carrier parser definitions.
 *
 * ⚠ CALIBRATION NOTICE
 *
 * Every definition in this file is marked SYNTHETIC_ONLY. The column names and
 * formats are plausible reconstructions built against the synthetic generator
 * in the synthetic fixture generator — they have NOT been validated against genuine carrier
 * productions.
 *
 * Before operational use, each definition must be calibrated against real
 * returns from that carrier and its `calibration` field updated. The import UI
 * displays this status prominently and reports print it, so an uncalibrated
 * parser can never be silently relied upon.
 *
 * Calibrating a carrier means: obtain real productions, compare column names
 * and value formats, extend the `columns` alias lists to cover the variants
 * seen, confirm the timezone convention against cover letters, then bump the
 * definition `version` and set `calibration`.
 */

import type { ParserDefinition } from './types';

const EVENT_KIND_MAP = {
  VOICE: 'VOICE', VOI: 'VOICE', CALL: 'VOICE', V: 'VOICE',
  SMS: 'SMS', SMSMO: 'SMS', SMSMT: 'SMS', TEXT: 'SMS', S: 'SMS',
  MMS: 'MMS',
  DATA: 'DATA', DAT: 'DATA', GPRS: 'DATA', PDP: 'DATA', D: 'DATA',
  REG: 'REGISTRATION', REGISTRATION: 'REGISTRATION', LU: 'LOCATION_UPDATE',
  HANDOVER: 'HANDOVER', HO: 'HANDOVER',
} as const;

const DIRECTION_MAP = {
  MO: 'ORIGINATING', O: 'ORIGINATING', OUT: 'ORIGINATING', OUTGOING: 'ORIGINATING',
  ORIGINATING: 'ORIGINATING', ORIG: 'ORIGINATING',
  MT: 'TERMINATING', T: 'TERMINATING', I: 'TERMINATING', IN: 'TERMINATING',
  INCOMING: 'TERMINATING', TERMINATING: 'TERMINATING', TERM: 'TERMINATING',
} as const;

const TECHNOLOGY_MAP = {
  LTE: 'LTE', '4G': 'LTE', EUTRAN: 'LTE',
  NR: 'NR', '5G': 'NR', NRSA: 'NR', NSA: 'NR',
  UMTS: 'UMTS', '3G': 'UMTS', WCDMA: 'UMTS', HSPA: 'UMTS',
  GSM: 'GSM', '2G': 'GSM', GERAN: 'GSM',
  CDMA: 'CDMA', '1X': 'CDMA', EVDO: 'CDMA',
  IMS: 'IMS', VOLTE: 'IMS', WIFI: 'WIFI',
} as const;

const SYNTHETIC_NOTE =
  'Reconstructed from the synthetic generator only. Not validated against genuine ' +
  'productions from this carrier. Calibrate before operational use.';

// ---------------------------------------------------------------------------
// AT&T
// ---------------------------------------------------------------------------

export const ATT_TOWER_DUMP: ParserDefinition = {
  id: 'att.tower-dump',
  version: '0.1.0',
  carrier: 'ATT',
  carrierDisplayName: 'AT&T',
  recordType: 'TOWER_DUMP',
  description: 'AT&T tower dump / cell-site record, comma-delimited, local time.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote: SYNTHETIC_NOTE,
  delimiter: ',',
  fingerprint: {
    required: ['Target Number', 'IMSI', 'IMEI', 'Date/Time', 'Cell ID'],
    optional: ['Call Type', 'Direction', 'Duration (sec)', 'Other Party', 'Site', 'Sector', 'Technology', 'Timing Advance', 'RSRP'],
    // A cell-site list shares several of these headers but carries coordinates.
    forbidden: ['Latitude', 'Longitude'],
    filenamePattern: /att|at&t/i,
  },
  // AT&T productions in the reconstructed format state the zone only in the
  // cover letter, so the parser refuses to assume one.
  timezoneNote:
    'AT&T records in this format carry no timezone. The production cover letter states it, and ' +
    'the analyst must declare it on the evidence package. No default is applied.',
  fields: {
    timestamp: { kind: 'SINGLE', field: { columns: ['Date/Time', 'DateTime', 'Date Time'], required: true } },
    msisdn: { columns: ['Target Number', 'Target', 'Subscriber Number'] },
    imsi: { columns: ['IMSI'] },
    imei: { columns: ['IMEI', 'Equipment ID'] },
    rawCellId: { columns: ['Cell ID', 'CellID', 'Cell'] },
    siteId: { columns: ['Site', 'Site ID', 'Cell Site'] },
    sectorId: { columns: ['Sector', 'Sector ID'] },
    technology: { columns: ['Technology', 'RAT', 'Network Type'] },
    eventKind: { columns: ['Call Type', 'Type', 'Event Type'] },
    direction: { columns: ['Direction', 'Call Direction'] },
    durationSec: { columns: ['Duration (sec)', 'Duration', 'Duration Seconds'] },
    otherParty: { columns: ['Other Party', 'Dialed Number', 'Called Number'] },
    timingAdvance: { columns: ['Timing Advance', 'TA', 'PerCallTA'] },
    rsrp: { columns: ['RSRP', 'Signal Strength'] },
  },
  eventKindMap: EVENT_KIND_MAP,
  directionMap: DIRECTION_MAP,
  technologyMap: TECHNOLOGY_MAP,
};

export const ATT_CELL_SITE_LIST: ParserDefinition = {
  id: 'att.cell-site-list',
  version: '0.1.0',
  carrier: 'ATT',
  carrierDisplayName: 'AT&T',
  recordType: 'CELL_SITE_LIST',
  description: 'AT&T cell site and sector list with coordinates and azimuths.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote:
    SYNTHETIC_NOTE +
    ' Note that this format omits antenna beam width, which is a common real-world gap; sectors ' +
    'from this source render with an explicitly assumed width.',
  delimiter: ',',
  fingerprint: {
    required: ['Cell ID', 'Latitude', 'Longitude'],
    optional: ['Site', 'Sector', 'Site Name', 'Street Address', 'Azimuth', 'Technology'],
    filenamePattern: /att.*(cell|site)|cellsite.*att/i,
  },
  timezoneNote: 'Cell site lists carry no timestamps.',
  fields: {
    timestamp: { kind: 'SINGLE', field: { columns: ['__none__'] } },
    rawCellId: { columns: ['Cell ID', 'CellID'] },
    siteId: { columns: ['Site', 'Site ID'] },
    sectorId: { columns: ['Sector'] },
    siteName: { columns: ['Site Name', 'Name'] },
    siteAddress: { columns: ['Street Address', 'Address'] },
    reportedLat: { columns: ['Latitude', 'Lat'] },
    reportedLon: { columns: ['Longitude', 'Lon', 'Long'] },
    azimuthDegrees: { columns: ['Azimuth', 'Azimuth Degrees'] },
    beamWidthDegrees: { columns: ['Beamwidth', 'Beam Width'] },
    technology: { columns: ['Technology', 'RAT'] },
  },
  technologyMap: TECHNOLOGY_MAP,
};

// ---------------------------------------------------------------------------
// Verizon
// ---------------------------------------------------------------------------

export const VERIZON_TOWER_DUMP: ParserDefinition = {
  id: 'verizon.tower-dump',
  version: '0.1.0',
  carrier: 'VERIZON',
  carrierDisplayName: 'Verizon',
  recordType: 'TOWER_DUMP',
  description: 'Verizon tower dump with separate date, time and timezone columns.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote: SYNTHETIC_NOTE,
  delimiter: ',',
  fingerprint: {
    required: ['MDN', 'Date', 'Time', 'Cell Site'],
    optional: ['MIN', 'IMSI', 'ESN/IMEI', 'Time Zone', 'Seizure Type', 'Direction', 'Duration', 'Dialed Digits', 'Sector', 'Switch', 'RTT'],
    forbidden: ['Latitude', 'Longitude'],
    filenamePattern: /vzw|verizon/i,
  },
  timezoneNote:
    'This format carries an explicit Time Zone column, which is used per row. Where it is blank, ' +
    'the package-declared zone applies.',
  fields: {
    timestamp: {
      kind: 'SPLIT',
      date: { columns: ['Date'], required: true },
      time: { columns: ['Time'], required: true },
      zone: { columns: ['Time Zone', 'TimeZone', 'TZ'] },
    },
    msisdn: { columns: ['MDN', 'MIN', 'Mobile Number'] },
    imsi: { columns: ['IMSI'] },
    imei: { columns: ['ESN/IMEI', 'IMEI', 'ESN'] },
    rawCellId: { columns: ['Cell Site', 'Cell', 'Cell ID'] },
    siteId: { columns: ['Cell Site', 'Site'] },
    sectorId: { columns: ['Sector'] },
    eventKind: { columns: ['Seizure Type', 'Call Type', 'Type'] },
    direction: { columns: ['Direction'] },
    durationSec: { columns: ['Duration', 'Duration (sec)'] },
    otherParty: { columns: ['Dialed Digits', 'Other Party'] },
    rttRaw: { columns: ['RTT', 'Round Trip Time'] },
  },
  eventKindMap: EVENT_KIND_MAP,
  directionMap: DIRECTION_MAP,
  technologyMap: TECHNOLOGY_MAP,
};

export const VERIZON_CELL_SITE_LIST: ParserDefinition = {
  id: 'verizon.cell-site-list',
  version: '0.1.0',
  carrier: 'VERIZON',
  carrierDisplayName: 'Verizon',
  recordType: 'CELL_SITE_LIST',
  description: 'Verizon cell site list including antenna azimuth and beam width.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote: SYNTHETIC_NOTE,
  delimiter: ',',
  fingerprint: {
    required: ['Cell Site', 'Latitude', 'Longitude'],
    optional: ['Sector', 'Site Name', 'Address', 'Azimuth', 'Beamwidth', 'Technology'],
    filenamePattern: /vzw|verizon/i,
  },
  timezoneNote: 'Cell site lists carry no timestamps.',
  fields: {
    timestamp: { kind: 'SINGLE', field: { columns: ['__none__'] } },
    siteId: { columns: ['Cell Site', 'Site'] },
    sectorId: { columns: ['Sector'] },
    siteName: { columns: ['Site Name', 'Name'] },
    siteAddress: { columns: ['Address'] },
    reportedLat: { columns: ['Latitude', 'Lat'] },
    reportedLon: { columns: ['Longitude', 'Lon'] },
    azimuthDegrees: { columns: ['Azimuth'] },
    beamWidthDegrees: { columns: ['Beamwidth', 'Beam Width'] },
    technology: { columns: ['Technology', 'RAT'] },
  },
  technologyMap: TECHNOLOGY_MAP,
};

// ---------------------------------------------------------------------------
// T-Mobile
// ---------------------------------------------------------------------------

export const TMOBILE_TOWER_DUMP: ParserDefinition = {
  id: 'tmobile.tower-dump',
  version: '0.1.0',
  carrier: 'TMOBILE',
  carrierDisplayName: 'T-Mobile',
  recordType: 'TOWER_DUMP',
  description: 'T-Mobile tab-delimited tower dump with ISO-8601 timestamps carrying an offset.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote: SYNTHETIC_NOTE,
  delimiter: '\t',
  fingerprint: {
    required: ['MSISDN', 'IMSI', 'EventTimestamp', 'CellIdentity'],
    optional: ['IMEI', 'EventType', 'CallDirection', 'DurationSeconds', 'OtherPartyNumber', 'eNodeB', 'SectorNumber', 'LAC', 'TAC', 'RAT', 'TimingAdvance'],
    forbidden: ['Latitude', 'Longitude'],
    filenamePattern: /tmo|t-mobile|tmobile/i,
  },
  timezoneNote:
    'Timestamps in this format carry an explicit UTC offset, so conversion is exact and no ' +
    'assumption is required.',
  fields: {
    timestamp: { kind: 'SINGLE', field: { columns: ['EventTimestamp', 'Event Timestamp'], required: true } },
    msisdn: { columns: ['MSISDN'] },
    imsi: { columns: ['IMSI'] },
    imei: { columns: ['IMEI'] },
    rawCellId: { columns: ['CellIdentity', 'Cell Identity', 'CGI'] },
    siteId: { columns: ['eNodeB', 'eNodeB ID', 'ENB'] },
    sectorId: { columns: ['SectorNumber', 'Sector'] },
    lac: { columns: ['LAC'] },
    tac: { columns: ['TAC'] },
    enodebId: { columns: ['eNodeB', 'ENB'] },
    technology: { columns: ['RAT', 'Technology'] },
    eventKind: { columns: ['EventType', 'Event Type'] },
    direction: { columns: ['CallDirection', 'Direction'] },
    durationSec: { columns: ['DurationSeconds', 'Duration'] },
    otherParty: { columns: ['OtherPartyNumber', 'Other Party'] },
    timingAdvance: { columns: ['TimingAdvance', 'TA'] },
  },
  eventKindMap: EVENT_KIND_MAP,
  directionMap: DIRECTION_MAP,
  technologyMap: TECHNOLOGY_MAP,
};

export const TMOBILE_CELL_SITE_LIST: ParserDefinition = {
  id: 'tmobile.cell-site-list',
  version: '0.1.0',
  carrier: 'TMOBILE',
  carrierDisplayName: 'T-Mobile',
  recordType: 'CELL_SITE_LIST',
  description: 'T-Mobile tab-delimited cell site list with azimuth and beam width.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote: SYNTHETIC_NOTE,
  delimiter: '\t',
  fingerprint: {
    required: ['CellIdentity', 'Latitude', 'Longitude'],
    optional: ['eNodeB', 'SectorNumber', 'SiteName', 'AzimuthDegrees', 'HorizontalBeamwidth', 'RAT', 'Band'],
    filenamePattern: /tmo|t-mobile|tmobile/i,
  },
  timezoneNote: 'Cell site lists carry no timestamps.',
  fields: {
    timestamp: { kind: 'SINGLE', field: { columns: ['__none__'] } },
    rawCellId: { columns: ['CellIdentity'] },
    siteId: { columns: ['eNodeB', 'ENB'] },
    sectorId: { columns: ['SectorNumber', 'Sector'] },
    siteName: { columns: ['SiteName', 'Site Name'] },
    reportedLat: { columns: ['Latitude'] },
    reportedLon: { columns: ['Longitude'] },
    azimuthDegrees: { columns: ['AzimuthDegrees', 'Azimuth'] },
    beamWidthDegrees: { columns: ['HorizontalBeamwidth', 'Beamwidth'] },
    technology: { columns: ['RAT', 'Technology'] },
    band: { columns: ['Band'] },
  },
  technologyMap: TECHNOLOGY_MAP,
};

// ---------------------------------------------------------------------------
// UScellular
// ---------------------------------------------------------------------------

export const USCELLULAR_TOWER_DUMP: ParserDefinition = {
  id: 'uscellular.tower-dump',
  version: '0.1.0',
  carrier: 'USCELLULAR',
  carrierDisplayName: 'UScellular',
  recordType: 'TOWER_DUMP',
  description: 'UScellular pipe-delimited tower dump with compact numeric timestamps.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote: SYNTHETIC_NOTE,
  delimiter: '|',
  fingerprint: {
    required: ['SUBSCRIBER_NBR', 'IMSI_NBR', 'EVENT_DTM', 'CELL_ID'],
    optional: ['EQUIPMENT_ID', 'EVENT_CD', 'DIR_CD', 'DUR_SEC', 'OTHER_NBR', 'SITE_CD', 'SECT_CD', 'TA_VAL'],
    forbidden: ['LAT_DEC', 'LON_DEC'],
    filenamePattern: /uscc|uscellular|us cellular/i,
  },
  timezoneNote:
    'This format carries no timezone and compact numeric timestamps give no offset. The analyst ' +
    'must declare the production timezone; no default is applied.',
  fields: {
    timestamp: { kind: 'SINGLE', field: { columns: ['EVENT_DTM', 'EVENT_DT'], required: true } },
    msisdn: { columns: ['SUBSCRIBER_NBR', 'SUBSCR_NBR'] },
    imsi: { columns: ['IMSI_NBR', 'IMSI'] },
    imei: { columns: ['EQUIPMENT_ID', 'IMEI_NBR', 'IMEI'] },
    rawCellId: { columns: ['CELL_ID'] },
    siteId: { columns: ['SITE_CD', 'SITE_ID'] },
    sectorId: { columns: ['SECT_CD', 'SECTOR_CD'] },
    eventKind: { columns: ['EVENT_CD', 'EVT_CD'] },
    direction: { columns: ['DIR_CD'] },
    durationSec: { columns: ['DUR_SEC'] },
    otherParty: { columns: ['OTHER_NBR'] },
    timingAdvance: { columns: ['TA_VAL', 'TA'] },
  },
  eventKindMap: EVENT_KIND_MAP,
  directionMap: DIRECTION_MAP,
  technologyMap: TECHNOLOGY_MAP,
};

export const USCELLULAR_CELL_SITE_LIST: ParserDefinition = {
  id: 'uscellular.cell-site-list',
  version: '0.1.0',
  carrier: 'USCELLULAR',
  carrierDisplayName: 'UScellular',
  recordType: 'CELL_SITE_LIST',
  description: 'UScellular pipe-delimited cell site list.',
  calibration: 'SYNTHETIC_ONLY',
  calibrationNote: SYNTHETIC_NOTE,
  delimiter: '|',
  fingerprint: {
    required: ['CELL_ID', 'LAT_DEC', 'LON_DEC'],
    optional: ['SITE_CD', 'SECT_CD', 'AZIMUTH_DEG', 'BEAM_DEG'],
    filenamePattern: /uscc|uscellular/i,
  },
  timezoneNote: 'Cell site lists carry no timestamps.',
  fields: {
    timestamp: { kind: 'SINGLE', field: { columns: ['__none__'] } },
    rawCellId: { columns: ['CELL_ID'] },
    siteId: { columns: ['SITE_CD'] },
    sectorId: { columns: ['SECT_CD'] },
    reportedLat: { columns: ['LAT_DEC', 'LATITUDE'] },
    reportedLon: { columns: ['LON_DEC', 'LONGITUDE'] },
    azimuthDegrees: { columns: ['AZIMUTH_DEG', 'AZIMUTH'] },
    beamWidthDegrees: { columns: ['BEAM_DEG', 'BEAMWIDTH'] },
  },
  technologyMap: TECHNOLOGY_MAP,
};

export const BUILT_IN_PARSERS: readonly ParserDefinition[] = [
  ATT_TOWER_DUMP,
  ATT_CELL_SITE_LIST,
  VERIZON_TOWER_DUMP,
  VERIZON_CELL_SITE_LIST,
  TMOBILE_TOWER_DUMP,
  TMOBILE_CELL_SITE_LIST,
  USCELLULAR_TOWER_DUMP,
  USCELLULAR_CELL_SITE_LIST,
];
