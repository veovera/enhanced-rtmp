// eslint.config.js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

console.log("eslint.config.js loaded - turned off some rules for now");

export default [
  { ignores: ["**/*", "!src/**", "!wip/**/*.ts"] },

  // Base JS rules
  js.configs.recommended,

  // TS rules - !!@: re-enable recommendedTypeChecked later
  // ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      // keep type info OFF for now
      // parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: { import: importPlugin },
    rules: {
      "import/order": "off",
      "import/no-duplicates": "off",
      "prefer-const": "off",
      "no-useless-escape": "off",
      "no-prototype-builtins": "off",

      // turn OFF type-aware rules for now
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
    settings: {
      "import/resolver": { typescript: { project: "./tsconfig.json" } }
    }
  }
];
