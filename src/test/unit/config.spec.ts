import { expect } from "chai";

import { WithOptions } from "./spec-fixture";
import { GetOptions, type Mode, type Options, SetOptions } from "../../config";

const DEFAULT_CURSOR_BATCH_SIZE = 100;
const DEFAULT_CURSOR_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CHANGE_RETENTION_MS = 300_000;
const DEFAULT_CHANGE_BATCH_SIZE = 256;
const DEFAULT_CHANGE_POLL_INTERVAL_MS = 5_000;

const VALIDATED = [
  "cursorBatchSize",
  "cursorIdleTimeoutMs",
  "changeRetentionMs",
  "changeBatchSize",
  "changePollIntervalMs",
] as const;

type ValidatedOption = (typeof VALIDATED)[number];

const DEFAULTS: Record<ValidatedOption, number> = {
  cursorBatchSize: DEFAULT_CURSOR_BATCH_SIZE,
  cursorIdleTimeoutMs: DEFAULT_CURSOR_IDLE_TIMEOUT_MS,
  changeRetentionMs: DEFAULT_CHANGE_RETENTION_MS,
  changeBatchSize: DEFAULT_CHANGE_BATCH_SIZE,
  changePollIntervalMs: DEFAULT_CHANGE_POLL_INTERVAL_MS,
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

const EXTERNAL_REFUSED: readonly Options[] = [
  { schemaPrefix: "app_" },
  { migrations: "safe" },
  { changeRetentionMs: 1000 },
  { changeBatchSize: 10 },
  { changePollIntervalMs: 1000 },
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

  it("serves owned tables when no mode is given", () => {
    WithOptions({}, () => {
      expect(GetOptions().mode).to.equal("owned");
    });
  });

  it("refuses a mode it does not know", () => {
    expect(() => SetOptions({ mode: "readonly" as Mode })).to.throw("readonly");
  });

  for (const refused of EXTERNAL_REFUSED) {
    const [option] = Object.keys(refused);
    it(`refuses ${option} in external mode, naming it`, () => {
      expect(() => SetOptions({ ...refused, mode: "external" })).to.throw(
        option,
      );
    });
  }

  it("refuses external mode without a url, naming the option", () => {
    expect(() => SetOptions({ mode: "external" })).to.throw("config.url");
  });

  it("refuses external mode with a blank url, as an unset variable in .env leaves it", () => {
    expect(() => SetOptions({ mode: "external", url: "" })).to.throw("config.url");
    expect(() => SetOptions({ mode: "external", url: "  " })).to.throw("config.url");
  });

  it("falls back to the default url in owned mode", () => {
    WithOptions({}, () => {
      expect(GetOptions().url).to.equal(
        "postgres://postgres@localhost:5432/antelopejs",
      );
    });
  });

  it("accepts an external mode with only the options that apply to it", () => {
    WithOptions(
      {
        mode: "external",
        url: "postgres://reader@client/erp",
        statementTimeoutMs: 5000,
      },
      () => {
        expect(GetOptions().mode).to.equal("external");
      },
    );
  });
});
