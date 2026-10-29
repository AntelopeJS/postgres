import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  entry: ["src/test/**/*.spec.ts", "src/test-external/**/*.test.ts"],
  ignoreDependencies: ["@types/mocha"],
});
