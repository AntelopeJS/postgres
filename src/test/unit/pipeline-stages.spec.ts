import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { SingleSelection, Table } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";
import { expect } from "chai";
import {
  DEFERRED_STAGES,
  PipelineStages,
  REJECTED_STAGES,
} from "../../implementations/database/pipeline";

const VOCABULARY: readonly string[] = [
  "avg",
  "count",
  "default",
  "distinct",
  "filter",
  "key",
  "map",
  "max",
  "min",
  "nth",
  "orderBy",
  "pluck",
  "slice",
  "sum",
  "union",
  "without",
];

const STAGE_COUNT = 16;

const NON_STAGE_METHODS: readonly string[] = [
  "constructor",
  "build",
  "callfunc",
  "cast",
  "cursor",
  "run",
  "stage",
  "then",
];

const PROBE_TABLE_ID = "probe";
const MAX_STAGE_ARITY = 3;

type ProbeRow = Record<string, unknown>;
type StageMethod = (...args: unknown[]) => StagedObject;
type MethodBag = Record<string, StageMethod>;
type BuilderFactory = () => StagedObject;

const BUILDER_ROOTS: readonly BuilderFactory[] = [
  () => new Table<ProbeRow>(QueryStage("table", { id: PROBE_TABLE_ID })),
  () =>
    new SingleSelection<ProbeRow>(QueryStage("table", { id: PROBE_TABLE_ID })),
];

function Sorted(names: readonly string[]): string[] {
  return [...names].sort();
}

function Intersection(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const other = new Set(right);
  return left.filter((name) => other.has(name));
}

function Identity(value: unknown): unknown {
  return value;
}

/**
 * An argument vector every contract method accepts.
 *
 * A function satisfies `callfunc`, which invokes it with the proxies it allocates, and `Identity`
 * hands one back as the recorded body; every other parameter is stored verbatim, so one vector as
 * wide as the widest method serves all of them.
 */
function ProbeArguments(): unknown[] {
  return Array.from({ length: MAX_STAGE_ARITY }, () => Identity);
}

function OwnStageMethods(level: object): string[] {
  const members = level as Record<string, unknown>;
  return Object.getOwnPropertyNames(level).filter(
    (name) =>
      typeof members[name] === "function" && !NON_STAGE_METHODS.includes(name),
  );
}

function ChainMethods(builder: StagedObject): string[] {
  const names = new Set<string>();
  let level: object | null = Object.getPrototypeOf(builder);
  while (level !== null && level !== Object.prototype) {
    for (const name of OwnStageMethods(level)) {
      names.add(name);
    }
    level = Object.getPrototypeOf(level);
  }
  return [...names];
}

function RecordedStage(
  make: BuilderFactory,
  method: string,
): string | undefined {
  const root = make();
  const depth = root.build().length;
  const methods = root as unknown as MethodBag;
  const stages = methods[method](...ProbeArguments()).build();
  return stages.length > depth ? stages[stages.length - 1].stage : undefined;
}

/**
 * Every stage name the interface's own builders record, read off the builders rather than listed.
 *
 * The method name and the stage name are not the same thing — `do` records `map` and `joinInner`
 * records `join` — and a stage the contract gains is one this adapter neither dispatches nor
 * declines, which is the case a transcribed list can never notice.
 */
function ContractStages(): string[] {
  const names = new Set<string>();
  for (const make of BUILDER_ROOTS) {
    for (const method of ChainMethods(make())) {
      const stage = RecordedStage(make, method);
      if (stage !== undefined) {
        names.add(stage);
      }
    }
  }
  return [...names];
}

describe("the pipeline stage vocabulary", () => {
  it("dispatches exactly the stages this backend reads, and no others", () => {
    expect(Sorted(Object.keys(PipelineStages()))).to.deep.equal(
      Sorted(VOCABULARY),
    );
  });

  it("pins the vocabulary at the size the sub-plan declares", () => {
    expect(VOCABULARY).to.have.lengthOf(STAGE_COUNT);
    expect(new Set(VOCABULARY).size).to.equal(STAGE_COUNT);
  });

  it("binds every stage to a callable handler", () => {
    const stages = PipelineStages();
    for (const name of VOCABULARY) {
      expect(stages[name], name).to.be.a("function");
    }
  });

  it("rebuilds the merged map rather than memoizing it", () => {
    expect(PipelineStages()).to.not.equal(PipelineStages());
  });

  it("declines a stage either permanently or for now, never both", () => {
    expect(
      Intersection(Object.keys(DEFERRED_STAGES), Object.keys(REJECTED_STAGES)),
    ).to.deep.equal([]);
  });

  it("never both dispatches and declines the same stage", () => {
    const declined = [
      ...Object.keys(DEFERRED_STAGES),
      ...Object.keys(REJECTED_STAGES),
    ];
    expect(Intersection(Object.keys(PipelineStages()), declined)).to.deep.equal(
      [],
    );
  });

  it("accounts for every stage the interface records", () => {
    const answered = [
      ...Object.keys(PipelineStages()),
      ...Object.keys(DEFERRED_STAGES),
      ...Object.keys(REJECTED_STAGES),
    ];
    expect(Sorted(ContractStages())).to.deep.equal(Sorted(answered));
  });
});

const DATABASE_DIR = join(__dirname, "..", "..", "implementations", "database");

const FAMILY_MODULES: readonly string[] = [
  "stages-rows",
  "stages-projection",
  "stages-aggregate",
  "selection",
];

/**
 * The merged vocabulary as a fresh process sees it when a family module is loaded before
 * `pipeline`.
 *
 * `union` compiles through `ApplyStages`, so `pipeline` and the family modules form a require
 * cycle, and an eagerly merged map spreads a half-written module as `undefined` — measured at 11
 * keys instead of 16, with no error. Mocha loads every spec into one registry and every one of
 * them reaches `pipeline` first, so the order that exposes this can only be forced from outside;
 * `delete require.cache` would instead leave duplicate module instances behind for later specs.
 */
function StagesAfterRequiring(familyModule: string): string[] {
  const script =
    `require("./${familyModule}"); ` +
    `console.log(Object.keys(require("./pipeline").PipelineStages()).sort().join(","))`;
  const printed = execFileSync(process.execPath, ["-e", script], {
    cwd: DATABASE_DIR,
    encoding: "utf8",
  }).trim();
  return printed.split(",");
}

describe("the pipeline stage vocabulary under an adversarial require order", () => {
  for (const familyModule of FAMILY_MODULES) {
    it(`merges every family when '${familyModule}' is required first`, () => {
      expect(StagesAfterRequiring(familyModule)).to.deep.equal(
        Sorted(VOCABULARY),
      );
    });
  }
});
