// vitest.config.ts
// Test-infrastructure config, not product config. Two goals:
//   1. Force LOG_LEVEL=silent for the whole run so pino/pino-http/
//      pino-pretty output doesn't spam CI logs on every request made in
//      app.test.ts (createApp() builds a real logger — this is the
//      cross-platform way to quiet it, versus relying on a shell env var
//      prefix in package.json's "test" script, which behaves differently
//      on Windows PowerShell vs bash).
//   2. Force NODE_ENV=test so createLogger() picks the JSON (non-
//      pino-pretty) transport path deterministically in CI, regardless
//      of what NODE_ENV happens to be set to in the host shell.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      LOG_LEVEL: "silent",
      NODE_ENV: "test",
    },
  },
});
