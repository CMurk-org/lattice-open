// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @cmurk/cellular-parsers — evidence ingestion.
 *
 * Parsers are declarative: a schema fingerprint plus a field map, executed by a
 * single normalization engine. Adding a carrier is a data change.
 *
 * Two rules hold throughout:
 *   1. Nothing is silently repaired. Anomalies become quality flags an analyst
 *      reviews; the original value is always preserved.
 *   2. Nothing is silently guessed. An unrecognised format produces a mapping
 *      PROPOSAL that a human must approve before evidence is incorporated.
 */

export * from './tabular';
export * from './types';
export * from './detect';
export * from './carriers';
export * from './normalize';
export * from './generic';
export * from './registry';
export * from './archive';
export * from './xlsx';
