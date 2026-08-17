// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Versioned analytical methods.
 *
 * Reproducibility requirement: a finding generated today must be reproducible
 * by another authorized analyst six months from now, even if the algorithm has
 * since changed. Every analyzer therefore declares a stable id and a semantic
 * version, and every result records the exact version that produced it.
 *
 * When an algorithm's behaviour changes, its version MUST be bumped. Historical
 * runs keep replaying against the version they recorded.
 */

export interface MethodRef {
  /** Stable identifier, e.g. 'parser.att.tower-dump'. */
  readonly id: string;
  /** Semantic version of the algorithm's behaviour, not the package. */
  readonly version: string;
  /** Exact parameters the run was executed with. Part of the reproducibility key. */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface MethodDescriptor {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  /** Plain-language description used verbatim in the report methodology section. */
  readonly description: string;
  /**
   * What layer results from this method carry.
   *
   * OBSERVED is permitted: some methods do nothing but surface a fact already
   * present in the records (for example, that one IMEI appears with two IMSIs).
   * Forcing such a method to claim CALCULATED would understate the strength of
   * its output, which is as much a misrepresentation as overstating it.
   */
  readonly producesLayer: 'OBSERVED' | 'CALCULATED' | 'INFERRED';
  /** Documented assumptions and limits, printed in reports. */
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  /** Literature or standards reference, where one applies. */
  readonly references?: readonly string[];
}

/**
 * Registry of every analytical method in the system. The report generator reads
 * this to produce the methodology appendix, so a method that is not registered
 * cannot appear in a report.
 */
export class MethodRegistry {
  private readonly methods = new Map<string, MethodDescriptor>();

  register(descriptor: MethodDescriptor): MethodDescriptor {
    const key = `${descriptor.id}@${descriptor.version}`;
    const existing = this.methods.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(descriptor)) {
      throw new Error(
        `Method ${key} is already registered with different metadata. Bump the version instead of ` +
          `redefining a published method — historical findings depend on it.`,
      );
    }
    this.methods.set(key, descriptor);
    return descriptor;
  }

  get(id: string, version: string): MethodDescriptor | undefined {
    return this.methods.get(`${id}@${version}`);
  }

  /** Resolve the descriptor a ref points at, for report rendering. */
  resolve(ref: MethodRef): MethodDescriptor | undefined {
    return this.get(ref.id, ref.version);
  }

  list(): MethodDescriptor[] {
    return [...this.methods.values()].sort((a, b) =>
      a.id === b.id ? a.version.localeCompare(b.version) : a.id.localeCompare(b.id),
    );
  }

  /** Latest registered version of a method id, by simple numeric semver ordering. */
  latest(id: string): MethodDescriptor | undefined {
    const candidates = [...this.methods.values()].filter((m) => m.id === id);
    if (candidates.length === 0) return undefined;
    return candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The process-wide registry. Analyzers self-register at module load. */
export const methodRegistry = new MethodRegistry();

export function defineMethod(descriptor: MethodDescriptor): MethodDescriptor {
  return methodRegistry.register(descriptor);
}

export function methodRef(
  descriptor: MethodDescriptor,
  params?: Record<string, unknown>,
): MethodRef {
  return { id: descriptor.id, version: descriptor.version, ...(params ? { params } : {}) };
}
