// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Network topology as the carrier describes it.
 *
 * A site is a mast; a sector is one antenna face on it. Both are OBSERVED
 * facts from a carrier cell-site list — not analytical products. Anything
 * derived from them (coverage geometry, position estimates) belongs to the
 * analysis layer, not here.
 */

import type { Assertion } from './layers';
import type { RadioTechnology } from './events';

/** ISO-8601 timestamp, always with an explicit offset. */
export type Iso8601 = string;

export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

export interface CellSite {
  readonly key: string;
  readonly caseId: string;
  readonly carrier: string;
  /** Carrier's own site identifier as written in the cell-site list. */
  readonly siteIdentifier: string;
  readonly name?: string;
  readonly address?: string;
  /** Tower position, as supplied by the carrier. Always OBSERVED, never inferred. */
  readonly position: Assertion<GeoPoint>;
  /** Ground elevation / antenna height, when supplied. */
  readonly heightMeters?: number;
  readonly sectorKeys: readonly string[];
  /** Set when two supplied sites share a position — a common carrier-data defect. */
  readonly coincidentWith?: readonly string[];
}

export interface CellSector {
  readonly key: string;
  readonly siteKey: string;
  readonly caseId: string;
  readonly carrier: string;
  readonly sectorIdentifier: string;
  readonly rawCellIds: readonly string[];
  /**
   * Azimuth in degrees true, as supplied. Absent when the carrier did not
   * provide it — in which case the sector must render as a full circle, not as
   * a guessed wedge.
   */
  readonly azimuthDegrees?: Assertion<number>;
  /** Horizontal beam width in degrees, as supplied. */
  readonly beamWidthDegrees?: Assertion<number>;
  readonly technology?: RadioTechnology;
  readonly band?: string;
  readonly lac?: string;
  readonly tac?: string;
  readonly enodebId?: string;
  /**
   * Carrier-stated coverage radius, when supplied. This system never invents
   * one; absent means the wedge is drawn unbounded with an explicit note.
   */
  readonly statedRangeMeters?: Assertion<number>;
  readonly firstSeenUtc?: Iso8601;
  readonly lastSeenUtc?: Iso8601;
  readonly observationCount?: number;
}

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

/**
 * A device, as the system understands it from evidence.
 *
 * A `Device` is a cluster of identifiers that the evidence links together. It
 * is NOT a person. Linking a device to a person requires subscriber records or
 * another documented evidentiary source, held on `Party`.
 */
