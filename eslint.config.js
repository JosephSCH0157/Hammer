// eslint.config.js
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default [
  // Ignore build artifacts
  { ignores: ["dist/**", "node_modules/**"] },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended (type-aware rules can be added later)
  ...tseslint.configs.recommended,

  // App source files
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh
    },
    rules: {
      // React Hooks rules
      ...reactHooks.configs.recommended.rules,

      // Vite HMR safety
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true }
      ],

      // Sensible TS strictness (keep signal high)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-explicit-any": "warn",

      // Prefer clarity
      "no-console": ["warn", { allow: ["warn", "error"] }]
    }
  }
];
