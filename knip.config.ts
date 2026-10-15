import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  // The unit suites are `*.spec.ts`, which `pnpm test:unit` runs with Mocha over
  // the compiled output; the shared preset only knows about `*.test.ts`.
  entry: ["src/test/**/*.spec.ts", "src/test-external/**/*.test.ts"],
  ignoreDependencies: [
    // Mocha's globals, supplied to the suites `ajs module test` runs.
    "@types/mocha",
  ],
});
