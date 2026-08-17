// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public License,
// v. 2.0. If a copy of the MPL was not distributed with this file, You can
// obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Explainability — the payload behind every "WHY?" button.
 *
 * An explanation is a tree of statements. Each statement declares its own
 * evidence layer and, where it rests on evidence, points at the exact source
 * rows. The UI renders it as an expandable outline where every leaf is
 * clickable through to the original record.
 */

import type { EvidenceLayer } from './layers';
import type { ProvenanceRef } from './provenance';
import type { MethodRef } from './method';

export interface ExplanationNode {
  readonly layer: EvidenceLayer;
  /** One plain-language sentence. No jargon that an attorney cannot read aloud. */
  readonly statement: string;
  /** Source rows supporting this specific statement. */
  readonly provenance?: readonly ProvenanceRef[];
  /** Numbers quoted in the statement, exposed structurally for tables/exports. */
  readonly quantities?: Readonly<Record<string, number | string>>;
  readonly children?: readonly ExplanationNode[];
}

export interface Explanation {
  /** One-sentence answer to "why am I being shown this?". */
  readonly summary: string;
  readonly reasons: readonly ExplanationNode[];
  /** Method that produced the explained value. */
  readonly method?: MethodRef;
  /**
   * Things that would weaken or overturn this result. Stating these is part of
   * defensible output — an explanation that only argues one way is advocacy,
   * not analysis.
   */
  readonly caveats?: readonly string[];
  /** Facts that were checked and did NOT support the result. */
  readonly contraIndicators?: readonly ExplanationNode[];
}

export function explanation(
  summary: string,
  reasons: readonly ExplanationNode[],
  opts: {
    method?: MethodRef;
    caveats?: readonly string[];
    contraIndicators?: readonly ExplanationNode[];
  } = {},
): Explanation {
  return {
    summary,
    reasons,
    ...(opts.method ? { method: opts.method } : {}),
    ...(opts.caveats ? { caveats: opts.caveats } : {}),
    ...(opts.contraIndicators ? { contraIndicators: opts.contraIndicators } : {}),
  };
}

export function reason(
  layer: EvidenceLayer,
  statement: string,
  opts: {
    provenance?: readonly ProvenanceRef[];
    quantities?: Record<string, number | string>;
    children?: readonly ExplanationNode[];
  } = {},
): ExplanationNode {
  return {
    layer,
    statement,
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
    ...(opts.quantities ? { quantities: opts.quantities } : {}),
    ...(opts.children ? { children: opts.children } : {}),
  };
}

/** Flatten an explanation to plain text for report rendering and exports. */
export function renderExplanationText(exp: Explanation, indent = 0): string {
  const lines: string[] = [`${' '.repeat(indent)}${exp.summary}`];
  const walk = (nodes: readonly ExplanationNode[], depth: number) => {
    for (const node of nodes) {
      const cited = node.provenance?.length ? ` [${node.provenance.length} source record(s)]` : '';
      lines.push(`${' '.repeat(depth)}• (${node.layer}) ${node.statement}${cited}`);
      if (node.children?.length) walk(node.children, depth + 2);
    }
  };
  walk(exp.reasons, indent + 2);
  if (exp.contraIndicators?.length) {
    lines.push(`${' '.repeat(indent + 2)}Evidence against:`);
    walk(exp.contraIndicators, indent + 4);
  }
  if (exp.caveats?.length) {
    lines.push(`${' '.repeat(indent + 2)}Caveats:`);
    for (const caveat of exp.caveats) lines.push(`${' '.repeat(indent + 4)}• ${caveat}`);
  }
  return lines.join('\n');
}

/** Every source row cited anywhere in an explanation tree. */
export function explanationProvenance(exp: Explanation): ProvenanceRef[] {
  const out: ProvenanceRef[] = [];
  const walk = (nodes: readonly ExplanationNode[]) => {
    for (const node of nodes) {
      if (node.provenance) out.push(...node.provenance);
      if (node.children) walk(node.children);
    }
  };
  walk(exp.reasons);
  if (exp.contraIndicators) walk(exp.contraIndicators);
  return out;
}
