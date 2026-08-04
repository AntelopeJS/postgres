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
import { WRITE_STAGES } from "../../implementations/database/writes";

const VOCABULARY: readonly string[] = [
  "avg",
  "between",
  "count",
  "default",
  "distinct",
  "filter",
  "get",
  "getAll",
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

const STAGE_COUNT = 19;

const WRITE_VOCABULARY: readonly string[] = [
  "delete",
  "insert",
  "replace",
  "update",
];

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

/**
 * The maps that compile a stage, named so a collision reports which one it was in.
 *
 * A terminal write is not a pipeline stage — it produces a statement rather than a relation — so
 * the accounting reads both dispatch maps, and a name in either one may not also be declined.
 */
function DispatchedStages(): Record<string, string[]> {
  return {
    pipeline: Object.keys(PipelineStages()),
    write: Object.keys(WRITE_STAGES),
  };
}

function DeclinedStages(): string[] {
  return [...Object.keys(DEFERRED_STAGES), ...Object.keys(REJECTED_STAGES)];
}

function AnsweredStages(): string[] {
  return [...Object.values(DispatchedStages()).flat(), ...DeclinedStages()];
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

  it("compiles exactly the writes this backend implements, and no others", () => {
    expect(Sorted(Object.keys(WRITE_STAGES))).to.deep.equal(
      Sorted(WRITE_VOCABULARY),
    );
  });

  it("binds every write to a callable compiler", () => {
    for (const name of WRITE_VOCABULARY) {
      expect(WRITE_STAGES[name].compile, name).to.be.a("function");
    }
  });

  it("records for every write whether it reads the relation it follows", () => {
    const reading = Object.entries(WRITE_STAGES)
      .filter(([, spec]) => !spec.readsRelation)
      .map(([name]) => name);
    expect(reading).to.deep.equal(["insert"]);
  });

  it("declines a stage either permanently or for now, never both", () => {
    expect(
      Intersection(Object.keys(DEFERRED_STAGES), Object.keys(REJECTED_STAGES)),
    ).to.deep.equal([]);
  });

  it("never both dispatches and declines the same stage", () => {
    for (const [map, dispatched] of Object.entries(DispatchedStages())) {
      expect(Intersection(dispatched, DeclinedStages()), map).to.deep.equal([]);
    }
  });

  it("never dispatches a terminal write through the pipeline as well", () => {
    expect(
      Intersection(Object.keys(WRITE_STAGES), Object.keys(PipelineStages())),
    ).to.deep.equal([]);
  });

  it("accounts for every stage the interface records", () => {
    expect(Sorted(ContractStages())).to.deep.equal(Sorted(AnsweredStages()));
  });
});

const DATABASE_DIR = join(__dirname, "..", "..", "implementations", "database");

/**
 * One dispatch map, how a fresh process reads it, and the family modules loaded ahead of it.
 *
 * `dispatch` is the expression that reaches a family's own handler out of one entry, which is what
 * a half-written family binds to `undefined`: the pipeline's entries are the handlers themselves,
 * while a write's entry states a second fact beside its compiler.
 */
interface MergedVocabulary {
  merger: string;
  access: string;
  dispatch: string;
  families: readonly string[];
  expected: readonly string[];
}

const MERGED_VOCABULARIES: readonly MergedVocabulary[] = [
  {
    merger: "pipeline",
    access: "PipelineStages()",
    dispatch: "entry",
    families: [
      "stages-rows",
      "stages-selection",
      "stages-projection",
      "stages-aggregate",
      "selection",
    ],
    expected: VOCABULARY,
  },
  {
    merger: "writes",
    access: "WRITE_STAGES",
    dispatch: "entry?.compile",
    families: ["writes-identity", "writes-insert"],
    expected: WRITE_VOCABULARY,
  },
];

/**
 * A dispatch map as a fresh process sees it when a family module is loaded before the module that
 * assembles it.
 *
 * `union` compiles through `ApplyStages`, so `pipeline.ts` and its families are mutually dependent
 * whichever way the process loads them, and an eagerly merged map reads a half-written module as
 * `undefined` — measured the day `union` landed at 11 of the 16 stages it then had, with no error.
 * Mocha loads every spec into one registry and every one of them reaches the merger first, so the
 * order that exposes this can only be forced from outside; `delete require.cache` would instead
 * leave duplicate module instances behind for later specs.
 *
 * The write half has no such cycle to expose — its families reach sideways into `writes-shared.ts`,
 * which leads nowhere back — and is kept as the assertion that would notice one being introduced:
 * `WRITE_STAGES` is a module-scope constant, which is exactly the form that binds `undefined` and
 * dispatches nothing the day a compiler reaches back for the seam that called it.
 *
 * The names are filtered by what they dispatch to rather than read off the keys, because the two
 * failures differ: a spread of a half-written family drops its keys entirely, while a named member
 * of one keeps its key and binds it to `undefined`.
 */
function StagesAfterRequiring(
  vocabulary: MergedVocabulary,
  familyModule: string,
): string[] {
  const script =
    `require("./${familyModule}"); ` +
    `const merged = require("./${vocabulary.merger}").${vocabulary.access}; ` +
    `console.log(Object.entries(merged)` +
    `.filter(([, entry]) => typeof (${vocabulary.dispatch}) === "function")` +
    `.map(([name]) => name).sort().join(","))`;
  const printed = execFileSync(process.execPath, ["-e", script], {
    cwd: DATABASE_DIR,
    encoding: "utf8",
  }).trim();
  return printed.split(",");
}

describe("the stage vocabularies under an adversarial require order", () => {
  for (const vocabulary of MERGED_VOCABULARIES) {
    for (const familyModule of vocabulary.families) {
      it(`merges every family of '${vocabulary.merger}' when '${familyModule}' is required first`, () => {
        expect(StagesAfterRequiring(vocabulary, familyModule)).to.deep.equal(
          Sorted(vocabulary.expected),
        );
      });
    }
  }
});
