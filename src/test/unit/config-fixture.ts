/** The options `SetOptions` requires to be positive safe integers. */
export const VALIDATED = [
  "cursorBatchSize",
  "cursorIdleTimeoutMs",
  "changeRetentionMs",
  "changeBatchSize",
  "changePollIntervalMs",
] as const;

export type ValidatedOption = (typeof VALIDATED)[number];
