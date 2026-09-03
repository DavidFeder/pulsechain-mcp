/**
 * ESLint 10 flat config for this TypeScript ESM repo.
 * Modest ruleset: @eslint/js recommended + typescript-eslint recommended.
 * Not stylistic-all and not type-checked — no mass-format pass.
 */
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "scripts/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // Existing `_` prefix / rest-omit convention (confirm omit, mock args).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
);
