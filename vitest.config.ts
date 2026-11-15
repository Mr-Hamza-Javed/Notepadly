import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      // Pure logic runs in node; files that need a DOM opt in with `// @vitest-environment jsdom`.
      environment: "node",
      setupFiles: ["src/test/dom.ts"],
      // The app-level tests boot the real editor and load multi-megabyte files.
      testTimeout: 20_000,
      restoreMocks: true,
      coverage: {
        provider: "v8",
        include: ["src/**/*.ts"],
        exclude: ["src/test/**", "src/**/*.test.ts"],
      },
    },
  }),
);
