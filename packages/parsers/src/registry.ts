// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Parser registry.
 *
 * Holds the built-in carrier definitions plus any analyst-approved mappings
 * registered at runtime, and routes a file to the right one.
 */

import type { ParserDefinition, DetectionResult } from './types';
import { BUILT_IN_PARSERS } from './carriers';
import { detectFormat, AUTO_ACCEPT_CONFIDENCE, type DetectionInput } from './detect';
import { suggestMapping, type GenericProfile } from './generic';

export type RoutingDecision =
  | {
      readonly kind: 'AUTO';
      readonly parser: ParserDefinition;
      readonly detection: DetectionResult;
      readonly alternatives: readonly DetectionResult[];
    }
  | {
      readonly kind: 'NEEDS_CONFIRMATION';
      readonly parser: ParserDefinition;
      readonly detection: DetectionResult;
      readonly alternatives: readonly DetectionResult[];
      readonly reason: string;
    }
  | {
      readonly kind: 'NEEDS_MAPPING';
      readonly profile: GenericProfile;
      readonly reason: string;
    };

export class ParserRegistry {
  private readonly definitions = new Map<string, ParserDefinition>();

  constructor(initial: readonly ParserDefinition[] = BUILT_IN_PARSERS) {
    for (const definition of initial) this.register(definition);
  }

  register(definition: ParserDefinition): void {
    const key = `${definition.id}@${definition.version}`;
    if (this.definitions.has(key)) {
      throw new Error(
        `Parser ${key} is already registered. Bump the version rather than redefining a parser — ` +
          `imports already committed reference this exact version.`,
      );
    }
    this.definitions.set(key, definition);
  }

  get(id: string, version: string): ParserDefinition | undefined {
    return this.definitions.get(`${id}@${version}`);
  }

  list(): ParserDefinition[] {
    return [...this.definitions.values()];
  }

  /** Every parser for a carrier, newest version first. */
  forCarrier(carrier: string): ParserDefinition[] {
    return this.list().filter((d) => d.carrier === carrier);
  }

  detect(input: DetectionInput): DetectionResult[] {
    return detectFormat(this.list(), input);
  }

  /**
   * Decide how to handle a file.
   *
   * Auto-accept requires both a high confidence AND a clear margin over the
   * runner-up. Two formats scoring 0.93 and 0.92 is not a confident match — it
   * is an ambiguity, and the analyst decides.
   */
  route(input: DetectionInput): RoutingDecision {
    const results = this.detect(input);

    if (results.length === 0) {
      // Profiling works on text, so a structured source is serialised for it.
      // Tab-delimited matches the canonical form spreadsheet rows are hashed
      // over, so the profiler sees exactly the values that would be imported.
      const sample =
        input.sample ??
        (input.document
          ? [input.document.headerRow.raw, ...input.document.rows.map((row) => row.raw)].join('\n')
          : '');

      return {
        kind: 'NEEDS_MAPPING',
        profile: suggestMapping(sample, input.filename),
        reason:
          'No registered carrier format matched this file. A column mapping has been proposed for review.',
      };
    }

    const best = results[0]!;
    const runnerUp = results[1];
    const parser = this.get(best.parserId, best.parserVersion)!;
    const alternatives = results.slice(1);

    if (runnerUp && best.confidence - runnerUp.confidence < 0.1) {
      return {
        kind: 'NEEDS_CONFIRMATION',
        parser,
        detection: best,
        alternatives,
        reason:
          `Two formats matched this file with similar confidence: ${best.carrierDisplayName} ` +
          `${best.recordType} at ${(best.confidence * 100).toFixed(1)}% and ` +
          `${runnerUp.carrierDisplayName} ${runnerUp.recordType} at ${(runnerUp.confidence * 100).toFixed(1)}%. ` +
          `Confirm which is correct before importing.`,
      };
    }

    if (best.confidence < AUTO_ACCEPT_CONFIDENCE) {
      return {
        kind: 'NEEDS_CONFIRMATION',
        parser,
        detection: best,
        alternatives,
        reason:
          `Schema confidence is ${(best.confidence * 100).toFixed(1)}%, below the ` +
          `${(AUTO_ACCEPT_CONFIDENCE * 100).toFixed(0)}% threshold for automatic import. ` +
          `Review the column mapping before proceeding.`,
      };
    }

    return { kind: 'AUTO', parser, detection: best, alternatives };
  }
}

export const defaultRegistry = new ParserRegistry();
