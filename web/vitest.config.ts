// vitest.config.ts
//
// Deliberately minimal: this config exists to test pure data/logic
// modules (web/src/lib/profileFieldOptions.ts, the validation-detail
// extraction in web/src/lib/dom.ts's errorMessage) that need no browser
// environment at all. It does NOT set up jsdom, component rendering, or
// any DOM testing capability — that's a separate, larger decision this
// repository hasn't made, and is out of scope for the regression tests
// this config was added to support. Tests that need `document`/`window`
// are not something this config is meant to enable.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
