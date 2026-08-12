import { expect } from "chai";
import { GetOptions, type Options, SetOptions } from "../../config";
import { WithOptions } from "./spec-fixture";

const DEFAULT_CURSOR_BATCH_SIZE = 100;
const DEFAULT_CURSOR_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CHANGE_RETENTION_MS = 300_000;
const DEFAULT_CHANGE_BATCH_SIZE = 256;
const DEFAULT_CHANGE_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CHANGE_BUFFER_LIMIT = 4_096;

const VALIDATED = [
  "cursorBatchSize",
  "cursorIdleTimeoutMs",
  "changeRetentionMs",
  "changeBatchSize",
  "changePollIntervalMs",
  "changeBufferLimit",
] as const;

type ValidatedOption = (typeof VALIDATED)[number];

const DEFAULTS: Record<ValidatedOption, number> = {
  cursorBatchSize: DEFAULT_CURSOR_BATCH_SIZE,
  cursorIdleTimeoutMs: DEFAULT_CURSOR_IDLE_TIMEOUT_MS,
  changeRetentionMs: DEFAULT_CHANGE_RETENTION_MS,
  changeBatchSize: DEFAULT_CHANGE_BATCH_SIZE,
  changePollIntervalMs: DEFAULT_CHANGE_POLL_INTERVAL_MS,
  changeBufferLimit: DEFAULT_CHANGE_BUFFER_LIMIT,
};

const REFUSED: readonly unknown[] = [
  0,
  -1,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 2,
  1e21,
  "100",
  null,
  {},
];

function Setting(option: ValidatedOption, value: unknown): Options {
  return { [option]: value } as unknown as Options;
}

describe("SetOptions", () => {
  for (const option of VALIDATED) {
    it(`accepts a positive integer ${option}`, () => {
      WithOptions(Setting(option, 7), () => {
        expect(GetOptions()[option]).to.equal(7);
      });
    });

    it(`defaults ${option} when it is omitted`, () => {
      WithOptions({}, () => {
        expect(GetOptions()[option]).to.equal(DEFAULTS[option]);
      });
    });

    it(`refuses a ${option} that is not a positive safe integer`, () => {
      for (const value of REFUSED) {
        expect(() => SetOptions(Setting(option, value))).to.throw(option);
        expect(() => SetOptions(Setting(option, value))).to.throw(
          String(value),
        );
      }
    });
  }

  it("leaves the configuration in place when it refuses", () => {
    WithOptions({ cursorBatchSize: 7 }, () => {
      expect(() => SetOptions({ cursorBatchSize: 0 })).to.throw();
      expect(GetOptions().cursorBatchSize).to.equal(7);
    });
  });

  it("resolves the options the cursor validation does not touch", () => {
    WithOptions(
      {
        url: "postgres://someone@elsewhere:5432/other",
        schemaPrefix: "app_",
        migrations: "destructive",
        statementTimeoutMs: 0,
      },
      () => {
        const options = GetOptions();
        expect(options.url).to.equal("postgres://someone@elsewhere:5432/other");
        expect(options.schemaPrefix).to.equal("app_");
        expect(options.migrations).to.equal("destructive");
        expect(options.statementTimeoutMs).to.equal(0);
      },
    );
  });
});
