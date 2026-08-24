// @ts-check
//
// The layering rule, as an enforceable lint config.
//
// src/ is four strictly-ordered layers and a layer may import only from layers
// above it in this list:
//
//     platform  ←  integrations  ←  operations  ←  conversation
//
// This file is the single source of truth for that rule. It is used two ways:
//
//   1. spread into eslint.config.mjs, so violations surface in normal linting
//   2. run standalone via `npm run lint:boundaries`
//
// (2) exists because the repo carries ~1100 pre-existing prettier and
// type-safety errors, so a bare `eslint` exit code cannot gate anything. Run
// on its own, this config reports layering violations and nothing else, which
// makes it usable in CI as a hard gate.
//
// Deliberately no exemption for type-only imports: an `import type` that points
// upward is still a design error, and silencing it here would silence every
// future one too.

import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

/** Layer order, dependency-first. Each layer may import itself and anything before it. */
const LAYERS = ['platform', 'integrations', 'operations', 'conversation'];

/** platform → [platform]; integrations → [platform, integrations]; … */
const layerPolicies = LAYERS.map((layer, i) => ({
  from: [{ element: { type: layer } }],
  allow: LAYERS.slice(0, i + 1).map((allowed) => ({
    to: { element: { type: allowed } },
  })),
}));

export default [
  {
    files: ['src/**/*.ts'],
    // Parser only — this rule is purely structural and needs no type
    // information, so it deliberately skips the (slow) type-aware project
    // service that the main config enables.
    languageOptions: { parser: tseslint.parser },
    plugins: { boundaries },
    settings: {
      // Element patterns match folders. src/main.ts and src/app.module.ts are
      // deliberately left unclassified: the composition root exists to wire
      // every layer together, so there is no meaningful rule to apply to it.
      'boundaries/elements': [
        { type: 'platform', pattern: 'src/platform' },
        { type: 'integrations', pattern: 'src/integrations' },
        { type: 'operations', pattern: 'src/operations' },
        { type: 'conversation', pattern: 'src/conversation' },
      ],
      'boundaries/ignore': ['**/*.spec.ts'],
      'import/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          policies: layerPolicies,
        },
      ],
    },
  },
];
