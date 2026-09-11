import { expect } from "chai";
import { SchemaInstance } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import { Schemas } from "../../implementations/database/schema";
import { ParamLedgerOf, WhileConfigured } from "./spec-fixture";
import { FLOAT, TEXT } from "../../implementations/database/types";
import type { TableShape } from "../../implementations/database/fields";
import { DecodingContext } from "../../implementations/database/context";
import { CompileSubquery } from "../../implementations/database/subquery";
import { CompileExpression } from "../../implementations/database/expression";
import type { OriginResolver } from "../../implementations/database/selection";
import {
  CompileRelation,
  REJECTED_STAGES,
} from "../../implementations/database/pipeline";
import {
  CountOpenCursors,
  type CursorOpener,
} from "../../implementations/database/cursors";
import {
  CloseCursor,
  CompileCursor,
  DecodeResult,
  DecodeRows,
} from "../../implementations/database/query";
import {
  type Relation,
  SetProjection,
  type TableOrigin,
  TableRelation,
} from "../../implementations/database/relation";

const PEOPLE: TableShape = {
  fields: {
    name: { column: "name", type: TEXT },
    age: { column: "age", type: FLOAT },
  },
};

const SCHEMA_ID = "directory";
const TABLE_ID = "people";
const TABLE = '"directory"."people"';
const ROOT_ALIAS = "t0";

const ALICE = { _id: "a", _instance: "", name: "Alice", age: 30, _extra: null };
const BOB = { _id: "b", _instance: "", name: "Bob", age: 41, _extra: null };

const DECODED_ALICE = { _id: "a", name: "Alice", age: 30 };

const StubOrigin: OriginResolver = (schemaId, tableId) => ({
  schemaId,
  tableId,
  shape: PEOPLE,
  index: (name) => [name],
});

function NewOrigin(): TableOrigin {
  return StubOrigin(SCHEMA_ID, TABLE_ID);
}

function RowMode(): Relation {
  return TableRelation(TABLE, ROOT_ALIAS, NewOrigin());
}

function ValueMode(): Relation {
  return SetProjection(RowMode(), { sql: '"t0"."name"', type: TEXT });
}

describe("DecodeResult in row mode", () => {
  it("decodes every row against the table's shape", () => {
    expect(DecodeResult(RowMode(), [ALICE, BOB])).to.deep.equal([
      { _id: "a", name: "Alice", age: 30 },
      { _id: "b", name: "Bob", age: 41 },
    ]);
  });

  it("hands back the row itself when the relation yields exactly one", () => {
    const relation = RowMode();
    relation.single = true;
    expect(DecodeResult(relation, [ALICE])).to.deep.equal({
      _id: "a",
      name: "Alice",
      age: 30,
    });
  });

  it("decodes an empty single-row read as null rather than undefined", () => {
    const relation = RowMode();
    relation.single = true;
    expect(DecodeResult(relation, [])).to.equal(null);
  });

  it("decodes an empty stream as an empty array", () => {
    expect(DecodeResult(RowMode(), [])).to.deep.equal([]);
  });

  it("answers the relation's own absent value, which get sets to undefined", () => {
    const relation = RowMode();
    relation.single = true;
    relation.absent = undefined;
    expect(DecodeResult(relation, [])).to.equal(undefined);
  });
});

describe("DecodeResult in value mode", () => {
  it("revives the output column against the projection's type", () => {
    expect(DecodeResult(ValueMode(), [{ value: "Alice" }])).to.deep.equal([
      "Alice",
    ]);
  });

  it("hands back the value itself when the relation yields exactly one", () => {
    const relation = ValueMode();
    relation.single = true;
    expect(DecodeResult(relation, [{ value: "Alice" }])).to.equal("Alice");
  });

  it("decodes an empty single-row read as null rather than undefined", () => {
    const relation = ValueMode();
    relation.single = true;
    expect(DecodeResult(relation, [])).to.equal(null);
  });

  it("keeps a NULL output column as null, which is what nth past the end is", () => {
    const relation = ValueMode();
    relation.single = true;
    expect(DecodeResult(relation, [{ value: null }])).to.equal(null);
  });

  it("distinguishes a row that decoded to null from a read that found none", () => {
    const relation = ValueMode();
    relation.single = true;
    relation.absent = undefined;
    expect(DecodeResult(relation, [{ value: null }])).to.equal(null);
    expect(DecodeResult(relation, [])).to.equal(undefined);
  });
});

/**
 * The two decoders over the relation that separates them, asserted side by side.
 *
 * A cursor over a `get` must be immediately done where a `get` answers its absent value, and
 * neither half says that alone.
 */
describe("DecodeRows over a relation that yields at most one row", () => {
  it("yields the row as one element where DecodeResult yields the row", () => {
    const relation = RowMode();
    relation.single = true;
    expect(DecodeRows(relation, [ALICE])).to.deep.equal([DECODED_ALICE]);
    expect(DecodeResult(relation, [ALICE])).to.deep.equal(DECODED_ALICE);
  });

  it("yields nothing where DecodeResult answers the relation's absent value", () => {
    const relation = RowMode();
    relation.single = true;
    relation.absent = undefined;
    expect(DecodeRows(relation, [])).to.deep.equal([]);
    expect(DecodeResult(relation, [])).to.equal(undefined);
  });
});

interface Person {
  name: string;
  age: number;
}

interface Directory {
  people: Person;
}

/** What a cursor's open asked the registry for: the roots it built. */
interface OpenLog {
  roots: number;
}

const GATED_SCHEMA_ID = "cursor-gate";
const UNPARSEABLE_TYPE = "uuid";

const BAD_SCHEMA = {
  [TABLE_ID]: { fields: { name: UNPARSEABLE_TYPE }, indexes: {} },
} as unknown as SchemaDefinition;

const WRITE_STAGE = "'insert'";
const CURSOR_HINT = "cursor";

const NEVER_REFUSED = "the compilation was expected to be refused";

/**
 * A `reqId` the interface's own counter can never allocate, in a range no sibling spec claims.
 *
 * `nextReqId` is a process-global counting up from 0, so the specs count down — and
 * `cursors.spec.ts` counts down from `-1` through the *same* registry, pinning the
 * first eviction the process makes. Nothing here is ever registered, so the two runs cannot meet,
 * and this id stays far below the other's reach in case that ever stops being true.
 */
const UNOPENED_REQ_ID = -1_000_000;

function OpenRecorder(): OpenLog {
  return { roots: 0 };
}

/** The stubbed registry a compilation reads its tables from, counting the roots it answers. */
function Recording(log: OpenLog): OriginResolver {
  return (schemaId, tableId) => {
    log.roots += 1;
    return StubOrigin(schemaId, tableId);
  };
}

function CursorContext(log: OpenLog): DecodingContext {
  return new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    Recording(log),
  );
}

/**
 * The opener `ReadCursor` hands the registry, against a stubbed table registry.
 *
 * It is driven directly rather than through `ReadCursorRow`, which would register a `reqId` and
 * retire it — and the endings a refusal leaves behind are evicted before `pipeline-cursors`' own,
 * which pins the process's first eviction to bound its forgotten range (a shared process, across
 * two spec files rather than within one).
 *
 * So these specs pin what the *compiler* does and nothing about what the registry does with it.
 * That a refused open takes no client is structural — a request that is never built is never
 * declared, and taking a client is the registry's first step — but it is a property of code this
 * file does not run, so the live harness is what measures it.
 */
function Opening(stages: QueryStage[], log: OpenLog): CursorOpener {
  return () => CompileCursor(stages, CursorContext(log));
}

function TableOf(schemaId: string) {
  const schema = new SchemaInstance<Directory>(
    QueryStage("schema", { id: schemaId }),
  );
  const instance = new SchemaInstance<Directory>(
    QueryStage("instance", { id: undefined }),
    schema,
  );
  return instance.table(TABLE_ID);
}

async function Refusal(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (err) {
    return err as Error;
  }
  throw new Error(NEVER_REFUSED);
}

describe("the statement a cursor declares", () => {
  let baseline = 0;

  beforeEach(() => {
    baseline = CountOpenCursors();
  });

  afterEach(() => {
    Schemas.unregister(GATED_SCHEMA_ID);
    expect(CountOpenCursors()).to.equal(baseline);
  });

  it("refuses a terminal write by name, having built its root", async () => {
    const log = OpenRecorder();
    const stages = TableOf(SCHEMA_ID).insert({ name: "Alice" }).build();
    const refused = await Refusal(WhileConfigured(Opening(stages, log)));
    expect(refused.message).to.contain(WRITE_STAGE);
    expect(refused.message).to.contain(CURSOR_HINT);
    expect(log.roots).to.equal(1);
  });

  /**
   * The refusal `changes` earns is the fold's own, and this is what says so.
   *
   * `for await (const doc of table.changes())` reaches `ReadCursor` before a stage is compiled, so
   * every change-feed case answered the cursor scaffold's message until now. Once the open compiles,
   * the stage reaches `REJECTED_STAGES` like any other — which is the first time that permanent
   * message is reachable through the contract's own suite, and the whole conformance signal of this
   * sub-plan.
   */
  it("raises the changes stage's own refusal rather than one about cursors", async () => {
    const log = OpenRecorder();
    const stages = TableOf(SCHEMA_ID).changes().build();
    const refused = await Refusal(WhileConfigured(Opening(stages, log)));
    expect(refused.message).to.equal(REJECTED_STAGES.changes);
    expect(refused.message).to.not.contain(CURSOR_HINT);
  });

  /**
   * A gate that rejects proves the ordering where a gate that resolves cannot.
   *
   * Compilation is synchronous and reads shapes a registration has not converged yet,
   * so the gate has to be awaited first. The stubbed registry answers any table, so a root built
   * before the gate would compile happily and the failure would surface nowhere.
   */
  it("awaits the readiness gate before it builds the root", async () => {
    const log = OpenRecorder();
    const gate = await Refusal(Schemas.register(GATED_SCHEMA_ID, BAD_SCHEMA));
    const stages = TableOf(GATED_SCHEMA_ID).build();
    const refused = await Refusal(WhileConfigured(Opening(stages, log)));
    expect(refused).to.equal(gate);
    expect(log.roots).to.equal(0);
  });

  it("hands the cursor a row decoder rather than a result decoder", async () => {
    const log = OpenRecorder();
    const stages = TableOf(SCHEMA_ID).get("a").build();
    const request = await WhileConfigured(Opening(stages, log));
    expect(request.decode([ALICE])).to.deep.equal([DECODED_ALICE]);
    expect(request.decode([])).to.deep.equal([]);
  });

  it("binds every parameter the declared statement names", async () => {
    const log = OpenRecorder();
    const stages = TableOf(SCHEMA_ID).get("a").build();
    const request = await WhileConfigured(Opening(stages, log));
    const ledger = ParamLedgerOf(request.sql, request.params.length);
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });

  it("closes a reqId that never opened, without throwing", async () => {
    await CloseCursor(UNOPENED_REQ_ID);
    await CloseCursor(UNOPENED_REQ_ID);
  });
});
