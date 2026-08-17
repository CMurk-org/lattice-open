// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * @cmurk/cellular-schema — the normalized cellular-record model.
 *
 * The vocabulary two systems need to agree on to read the same carrier
 * production the same way: what a record is, what layer a value belongs to,
 * where it came from, and how its timestamp was resolved.
 *
 * There is deliberately no latitude or longitude for a device. A sector
 * observation says a device was somewhere in a coverage area; the schema has
 * no field that would let it be recorded as a position.
 */

export * from './layers';
export * from './provenance';
export * from './integrity';
export * from './time';
export * from './identifiers';
export * from './events';
export * from './model';
export * from './method';
export * from './explain';
export * from './ids';

export const SCHEMA_VERSION = '0.1.0';
