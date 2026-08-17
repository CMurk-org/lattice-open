// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @cmurk/cellular-export — portable conversions of normalized records.
 *
 * Exported evidence is read in tools that know nothing about evidence layers,
 * so the caveats travel inside the file. A KML opened in Google Earth states
 * that a marker sits at the tower, not at the device; CSV output neutralises
 * spreadsheet formula injection, because an MSISDN begins with "+".
 */

export * from './export';
