// ESLint flat config (ESLint 9). The package is ESM, so this file is too.
//
// Scope is deliberately narrow: this exists so `npm run lint` has a working
// setup behind it and so CI can run it on pull requests. It is not an attempt
// to restyle the codebase.
//
// Type-checked rules are NOT enabled. They need a TypeScript program per run,
// which is slower and, more to the point, would turn a lint job into a second
// compiler with its own opinions. `tsc` already runs in CI and is the
// authority on types.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // dist/ is build output, node_modules/ is not ours. Neither is source.
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // `_`-prefixed arguments are the established way to say "required by the
      // signature, unused on purpose" - commander callbacks and catch blocks
      // both hit this.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Warning, not error, and the number is the reason: 58 occurrences in
      // src/client.ts and src/cli.ts, all of them pre-existing. They sit where
      // untyped JSON comes back from Overleaf, which has no published schema,
      // so each one is a real typing decision rather than a mechanical fix.
      //
      // Making this an error would mean CI fails on `main` from the day it is
      // switched on, which trains everyone to ignore it. As a warning it stays
      // visible and does not block, and new code can be held to a higher bar in
      // review. Revisit once the count is low enough to fix in one pass.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
