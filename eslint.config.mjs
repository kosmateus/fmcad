import importPlugin, { createNodeResolver } from "eslint-plugin-import-x";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.test-artifacts/**",
      "src/**/*.d.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts", "src/opencode/*.ts"],
    plugins: { "import-x": importPlugin },
    settings: {
      "import-x/parsers": { "@typescript-eslint/parser": [".ts"] },
      "import-x/resolver-next": [
        createTypeScriptImportResolver({
          project: ["packages/*/tsconfig.json"],
          noWarnOnMultipleProjects: true,
        }),
        createNodeResolver({ extensions: [".js", ".mjs", ".cjs", ".ts"] }),
      ],
    },
    rules: {
      "import-x/no-cycle": "error",
    },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "import-x/no-nodejs-modules": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@fmcad/node-adapters",
                "@fmcad/node-adapters/**",
                "@fmcad/opencode-adapter",
                "@fmcad/opencode-adapter/**",
                "@fmcad/control-center",
                "@fmcad/control-center/**",
                "terminal-kit",
                "@opencode-ai/plugin",
                "**/node-adapters/**",
                "**/opencode-adapter/**",
                "**/control-center/**",
              ],
              message:
                "Core must remain host-independent; inject effects through ports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/composition/library*.ts", "src/composition/opencode.ts"],
    rules: {
      // Lazy composition of transitional CommonJS adapters is intentional:
      // importing the public API must not load effectful adapter dependencies.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["src/entrypoints/cli.ts", "src/entrypoints/cli/**/*.ts"],
    rules: {
      // This private CommonJS compatibility edge delegates to retained JS
      // command/help/pipeline adapters and does not create another service.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["src/opencode/execution.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "prefer-const": "off",
    },
  },
);
