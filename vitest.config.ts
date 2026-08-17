// Copyright (c) 2026 Alvand Kiumarsi
// SPDX-License-Identifier: MPL-2.0

import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkg = (name: string) => resolve(__dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  test: { include: ['packages/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
  resolve: {
    alias: {
      '@cmurk/cellular-schema': pkg('schema'),
      '@cmurk/geodesy': pkg('geodesy'),
      '@cmurk/cellular-parsers': pkg('parsers'),
      '@cmurk/cellular-export': pkg('export'),
    },
  },
});
