import { WaitForAllIndexes } from "../implementations/database/schema";

/**
 * How long the convergence of every schema the suites register may take: it ended within 9.1 s of
 * the module's construction in every Windows CI log measured, and the first query of a run otherwise
 * queues behind it for a pool client, past mocha's 2 s default.
 */
const STARTUP_CONVERGENCE_MS = 30_000;

before(async function () {
  this.timeout(STARTUP_CONVERGENCE_MS);
  await WaitForAllIndexes();
});
