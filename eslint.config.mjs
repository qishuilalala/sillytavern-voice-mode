import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "coverage/**",
    "esbuild.config.mjs",
    "eslint.config.mjs",
    "scripts/**",
  ]),
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message: "SillyTavern browser UI extension code must not import node:* modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["test/**/*.mjs", "server-plugin/**/*.mjs"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      "no-eval": "error",
      "no-new-func": "error",
    },
  },
]);
