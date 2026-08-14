import { QueryStage } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import { Render } from "../../implementations/database/relation";
import {
  Apply,
  ApplyRaw,
  NewProfiles,
  NewTable,
  ReadParamLedger,
  Root,
  Sql,
  Stages,
  TABLE_ID,
} from "./pipeline-fixture";

const ID_KEY = '("t0"."_id" = ($1::text))';
const AGE_KEYS =
  '("t0"."age" IN (($1::double precision), ($2::double precision)))';
const ONE_AGE_KEY = '("t0"."age" IN (($1::double precision)))';
const ID_KEYS = '("t0"."_id" IN (($1::text), ($2::text)))';
const ACTIVE_KEY = '("t0"."isActive" IN (($1::boolean)))';
const COMPOUND_KEY =
  '(("t0"."name", "t0"."age") IN ((($1::text), ($2::double precision))))';
const OVERFLOW_KEY = `(("t0"."_extra" -> 'nickname') IN (to_jsonb(($1::text))))`;
const NO_MATCH = "(FALSE)";
const LOW_BOUND = '("t0"."age" >= ($1::double precision))';
const HIGH_BOUND = '("t0"."age" < ($2::double precision))';
const NUMERIC_TEXT_PATTERN = `'^\\s*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$'`;

/** The guarded reading a text key gets against a `number` column, which a cast would refuse. */
function AsNumber(param: string): string {
  return (
    `(CASE WHEN (${param}::text) ~ ${NUMERIC_TEXT_PATTERN}` +
    ` THEN (((${param}::text))::double precision) END)`
  );
}

const NUMERIC_TEXT_KEY = `("t0"."age" IN (${AsNumber("$1")}))`;
const LOW_TEXT_BOUND = `("t0"."age" >= ${AsNumber("$1")})`;
const HIGH_TEXT_BOUND = `("t0"."age" < ${AsNumber("$2")})`;

const COMPOUND_INDEX = "byNameAge";
const ARRAY_FIELD = "skills";
const COMPOUND_ARRAY_INDEX = "byNameSkills";

/** One key of a `multi` index, matched against the list the column holds. */
function Contains(param: string): string {
  return `("t0"."skills" @> to_jsonb((${param}::text)))`;
}

const ONE_SKILL = `(${Contains("$1")})`;
const TWO_SKILLS = `(${Contains("$1")} OR ${Contains("$2")})`;

/**
 * A selection stage the typed builders cannot spell.
 *
 * `getAll`'s key is typed `string | number | boolean`, so a compound key — an array per key — has
 * no typed spelling at all, and `between` types both bounds as required. Recorded through the
 * interface's own {@link QueryStage} rather than transcribed as an object literal; neither stage
 * takes a lambda, so no argument id is invented here.
 */
function Recorded(
  stage: string,
  index: string | undefined,
  ...args: unknown[]
): QueryStage[] {
  return [QueryStage(stage, { index }, ...args)];
}

describe("the get stage", () => {
  it("absorbs a primary-key comparison into WHERE", () => {
    const { relation, context } = Apply(Root().get("k"));
    expect(relation.where).to.deep.equal([ID_KEY]);
    expect(context.params.all()).to.deep.equal(["k"]);
  });

  it("reads the primary-key column rather than the overflow one", () => {
    const sql = Sql(Root().get("k"));
    expect(sql).to.contain(`WHERE ${ID_KEY}`);
    expect(sql).to.not.contain("-> '_id'");
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("requires the key, naming the stage", () => {
    expect(() => ApplyRaw(Recorded("get", undefined))).to.throw(
      "Stage 'get' requires an operand at position 0",
    );
  });

  it("marks the relation as yielding exactly one row", () => {
    const { relation } = Apply(Root().get("k"));
    expect(relation.single).to.equal(true);
    expect(relation.origin?.tableId).to.equal(TABLE_ID);
  });

  it("answers undefined rather than null for a row that is not there", () => {
    expect(Apply(Root().get("k")).relation.absent).to.equal(undefined);
  });

  it("leaves every other relation answering null", () => {
    expect(NewTable().absent).to.equal(null);
    expect(Apply(Root().nth(0)).relation.absent).to.equal(null);
  });

  it("keeps single and the absent value through a projection", () => {
    const { relation } = Apply(Root().get("k").pluck("name", "age"));
    expect(relation.single).to.equal(true);
    expect(relation.absent).to.equal(undefined);
    expect(Render(relation)).to.contain(`WHERE ${ID_KEY}`);
  });
});

describe("the getAll stage", () => {
  it("matches a key list against one declared column", () => {
    const { relation, context } = Apply(Root().getAll([25, 30], "age"));
    expect(relation.where).to.deep.equal([AGE_KEYS]);
    expect(context.params.all()).to.deep.equal([25, 30]);
  });

  it("names the bare column, so the btree index over it stays reachable", () => {
    const sql = Sql(Root().getAll([25, 30], "age"));
    expect(sql).to.contain(`WHERE ${AGE_KEYS}`);
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("treats a single key as a list of one", () => {
    expect(Apply(Root().getAll(30, "age")).relation.where).to.deep.equal([
      ONE_AGE_KEY,
    ]);
  });

  it("compares a boolean key without a guard or a second cast", () => {
    expect(
      Apply(Root().getAll(false, "isActive")).relation.where,
    ).to.deep.equal([ACTIVE_KEY]);
  });

  it("reads a null key against a boolean column as no answer, not as false", () => {
    const { relation, context } = ApplyRaw(
      Recorded("getAll", "isActive", null),
    );
    expect(relation.where).to.deep.equal([
      `("t0"."isActive" IN ((CASE WHEN jsonb_typeof('null'::jsonb) = 'boolean' THEN (('null'::jsonb #>> '{}')::boolean) END)))`,
    ]);
    expect(context.params.all()).to.deep.equal([]);
  });

  it("reads a document key against a boolean column as no answer, not as true", () => {
    const { relation } = ApplyRaw(Recorded("getAll", "isActive", { a: 1 }));
    expect(relation.where[0]).to.contain("jsonb_typeof");
    expect(relation.where[0]).to.not.contain("<> ALL");
  });

  it("reads a key as the column's type rather than casting it", () => {
    expect(Apply(Root().getAll("3000", "age")).relation.where).to.deep.equal([
      NUMERIC_TEXT_KEY,
    ]);
  });

  it("resolves the primary key when no index is named", () => {
    expect(Apply(Root().getAll(["a", "b"])).relation.where).to.deep.equal([
      ID_KEYS,
    ]);
  });

  it("matches nothing rather than emitting an empty IN", () => {
    const { relation, context } = Apply(Root().getAll([], "age"));
    expect(relation.where).to.deep.equal([NO_MATCH]);
    expect(context.params.all()).to.deep.equal([]);
  });

  it("matches a compound index row-wise, in its declared field order", () => {
    const { relation, context } = ApplyRaw(
      Recorded("getAll", COMPOUND_INDEX, [["Alice", 30]]),
    );
    expect(relation.where).to.deep.equal([COMPOUND_KEY]);
    expect(context.params.all()).to.deep.equal(["Alice", 30]);
  });

  it("rejects a compound key of the wrong arity, naming the index", () => {
    expect(() =>
      ApplyRaw(Recorded("getAll", COMPOUND_INDEX, "Alice")),
    ).to.throw(
      "The 'byNameAge' index takes a key of 2 values, received a string",
    );
    expect(() =>
      ApplyRaw(Recorded("getAll", COMPOUND_INDEX, [["Alice"]])),
    ).to.throw(
      "The 'byNameAge' index takes a key of 2 values, received 1 values",
    );
  });

  it("names the index and the position of a hole inside a compound key", () => {
    expect(() =>
      ApplyRaw(Recorded("getAll", COMPOUND_INDEX, [["Alice", undefined]])),
    ).to.throw(
      "The 'byNameAge' index takes a value for every field, and has none at position 1",
    );
  });

  it("falls back to the overflow column for an undeclared field", () => {
    const { relation, context } = Apply(Root().getAll("Al", "nickname"));
    expect(relation.where).to.deep.equal([OVERFLOW_KEY]);
    expect(context.params.all()).to.deep.equal(["Al"]);
  });

  it("leaves the relation a row-shaped stream", () => {
    const { relation } = Apply(Root().getAll(["a"], "name"));
    expect(relation.single).to.equal(false);
    expect(relation.projection).to.equal(undefined);
    expect(relation.origin?.tableId).to.equal(TABLE_ID);
  });

  it("composes with a filter as a second conjunct", () => {
    const { relation } = Apply(
      Root()
        .getAll([25, 30], "age")
        .filter((doc) => doc.key("isActive").eq(true)),
    );
    expect(relation.where).to.have.lengthOf(2);
    expect(relation.where[0]).to.equal(AGE_KEYS);
  });

  it("wraps after a slice and still reaches the column", () => {
    const stages = [
      ...Stages(Root().slice(0, 2)),
      ...Stages(Root().getAll([30], "age")),
    ];
    const sql = Render(ApplyRaw(stages).relation);
    expect(sql).to.contain('WHERE ("t1"."age" IN (($3::double precision)))');
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("references every parameter it binds, and binds every one it references", () => {
    const ledgers = [
      ReadParamLedger(Apply(Root().getAll(["a", "b", "c"]))),
      ReadParamLedger(Apply(Root().getAll([], "age"))),
      ReadParamLedger(
        ApplyRaw(
          Recorded("getAll", COMPOUND_INDEX, [
            ["Alice", 30],
            ["Bob", 41],
          ]),
        ),
      ),
      ReadParamLedger(Apply(Root().get("k").pluck("name"))),
    ];
    for (const ledger of ledgers) {
      expect(ledger.referenced).to.deep.equal(ledger.bound);
    }
  });
});

describe("the getAll stage over a field declared as an array", () => {
  it("matches by containment, which is what a multi index is created for", () => {
    const { relation, context } = ApplyRaw(
      Recorded("getAll", ARRAY_FIELD, "laptop"),
      NewProfiles(),
    );
    expect(relation.where).to.deep.equal([ONE_SKILL]);
    expect(context.params.all()).to.deep.equal(["laptop"]);
  });

  it("disjoins a key list, which the planner reads as a bitmap OR", () => {
    const { relation, context } = ApplyRaw(
      Recorded("getAll", ARRAY_FIELD, ["laptop", "phone"]),
      NewProfiles(),
    );
    expect(relation.where).to.deep.equal([TWO_SKILLS]);
    expect(context.params.all()).to.deep.equal(["laptop", "phone"]);
  });

  it("wraps the containment in no case, which a gin index cannot see through", () => {
    const sql = Render(
      ApplyRaw(Recorded("getAll", ARRAY_FIELD, "laptop"), NewProfiles())
        .relation,
    );
    expect(sql).to.not.contain("CASE");
    expect(sql).to.not.contain("jsonb_build_object");
  });

  it("still matches nothing rather than emitting an empty disjunction", () => {
    const { relation } = ApplyRaw(
      Recorded("getAll", ARRAY_FIELD, []),
      NewProfiles(),
    );
    expect(relation.where).to.deep.equal([NO_MATCH]);
  });

  it("refuses a compound index that keys on an array field beside others", () => {
    expect(() =>
      ApplyRaw(
        Recorded("getAll", COMPOUND_ARRAY_INDEX, [["Alice", "laptop"]]),
        NewProfiles(),
      ),
    ).to.throw(
      `The '${COMPOUND_ARRAY_INDEX}' index keys on an array field beside others`,
    );
  });

  it("references every parameter it binds, and binds every one it references", () => {
    const ledger = ReadParamLedger(
      ApplyRaw(
        Recorded("getAll", ARRAY_FIELD, ["laptop", "phone"]),
        NewProfiles(),
      ),
    );
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });
});

describe("the between stage", () => {
  it("bounds one field low-inclusive and high-exclusive, in that order", () => {
    const { relation, context } = Apply(Root().between("age", 0, 10));
    expect(relation.where).to.deep.equal([LOW_BOUND, HIGH_BOUND]);
    expect(context.params.all()).to.deep.equal([0, 10]);
  });

  it("joins the two bounds as separate conjuncts", () => {
    expect(Sql(Root().between("age", 0, 10))).to.contain(
      `WHERE ${LOW_BOUND} AND ${HIGH_BOUND}`,
    );
  });

  it("reads a date bound as an instant", () => {
    const low = new Date("2023-01-01T00:00:00.000Z");
    const high = new Date("2023-02-01T00:00:00.000Z");
    const { relation, context } = Apply(Root().between("joined", low, high));
    expect(relation.where).to.deep.equal([
      '("t0"."joined" >= ($1::timestamptz))',
      '("t0"."joined" < ($2::timestamptz))',
    ]);
    expect(context.params.all()).to.deep.equal([low, high]);
  });

  it("ranges over an undeclared field through the overflow column", () => {
    const { relation } = ApplyRaw(Recorded("between", "nickname", "a", "b"));
    expect(relation.where).to.deep.equal([
      `(("t0"."_extra" -> 'nickname') >= to_jsonb(($1::text)))`,
      `(("t0"."_extra" -> 'nickname') < to_jsonb(($2::text)))`,
    ]);
  });

  it("refuses a compound index by name", () => {
    expect(() => ApplyRaw(Recorded("between", COMPOUND_INDEX, 1, 2))).to.throw(
      `The 'between' stage ranges over one field, but '${COMPOUND_INDEX}' names 2`,
    );
  });

  it("requires both bounds, naming the stage and the missing one", () => {
    expect(() => ApplyRaw(Recorded("between", "age", 0))).to.throw(
      "Stage 'between' requires an operand at position 1",
    );
    expect(() => ApplyRaw(Recorded("between", "age"))).to.throw(
      "Stage 'between' requires an operand at position 0",
    );
  });

  it("requires the field to range over", () => {
    expect(() => ApplyRaw(Recorded("between", undefined, 0, 10))).to.throw(
      "The 'between' stage is missing its field name",
    );
  });

  it("reads a text bound as the column's type rather than casting it", () => {
    expect(
      ApplyRaw(Recorded("between", "age", "0", "10")).relation.where,
    ).to.deep.equal([LOW_TEXT_BOUND, HIGH_TEXT_BOUND]);
  });

  it("reads a null bound as a stored value, not as an open bound", () => {
    const { relation, context } = ApplyRaw(Recorded("between", "age", 0, null));
    expect(relation.where).to.have.lengthOf(2);
    expect(relation.where[1]).to.contain("'null'::jsonb");
    expect(context.params.all()).to.deep.equal([0]);
  });

  it("references every parameter it binds, and binds every one it references", () => {
    const ledger = ReadParamLedger(Apply(Root().between("age", 0, 10)));
    expect(ledger.referenced).to.deep.equal(ledger.bound);
  });

  it("leaves the relation a row-shaped stream", () => {
    const { relation } = Apply(Root().between("age", 0, 10));
    expect(relation.single).to.equal(false);
    expect(relation.origin?.tableId).to.equal(TABLE_ID);
  });

  it("refuses a field declared as an array, which no range orders", () => {
    expect(() =>
      ApplyRaw(Recorded("between", ARRAY_FIELD, "a", "b"), NewProfiles()),
    ).to.throw(
      `The 'between' stage ranges over one value, but '${ARRAY_FIELD}' holds a list`,
    );
  });
});
