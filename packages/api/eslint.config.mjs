import tseslint from "typescript-eslint";

// Existing violations are recorded in eslint-suppressions.json (ESLint bulk
// suppressions). New violations fail; fixed ones must be pruned with
// `pnpm exec eslint --prune-suppressions`, so the baseline only shrinks.
export default tseslint.config(
  { ignores: ["node_modules/**", "coverage/**", "dist/**", "**/*.d.ts"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.recommended],
  },
);
