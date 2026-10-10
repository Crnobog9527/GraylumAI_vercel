import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Existing violations are recorded in eslint-suppressions.json (ESLint bulk
// suppressions). New violations fail; fixed ones must be pruned with
// `pnpm exec eslint --prune-suppressions`, so the baseline only shrinks.
export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "test-results/**",
      "playwright-report/**",
      "**/*.d.ts",
      "public/library-sandbox/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [tseslint.configs.recommended],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
);
