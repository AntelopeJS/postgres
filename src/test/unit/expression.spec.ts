import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";

import { RefusingCompilers } from "./spec-fixture";

import { DecodingContext } from "../../implementations/database/context";
import {
  CompileExpression,
  STAGES,
} from "../../implementations/database/expression";

import {
  AliasedColumns,
  ColumnRowSource,
} from "../../implementations/database/row-source";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  ROW_ID,
  VALUE_ID,
  SUBQUERY_ID,
  users,
  FALSEHOOD,
  ELEMENT,
  SUBQUERY,
  NewContext,
  Compile,
} from "./expression-fixture";
import { UntypedStage } from "./invalid-fixture";

describe("CompileExpression dispatch", () => {
  it("rejects a stage it does not know", () => {
    expect(() =>
      CompileExpression([UntypedStage("not_a_stage")], NewContext()),
    ).to.throw(/Unsupported expression stage 'not_a_stage'/);
  });

  it("does not dispatch a stage name inherited from Object.prototype", () => {
    expect(() =>
      CompileExpression([UntypedStage("constructor")], NewContext()),
    ).to.throw(/Unsupported expression stage 'constructor'/);
    expect(() =>
      CompileExpression([UntypedStage("__proto__")], NewContext()),
    ).to.throw(/Unsupported expression stage '__proto__'/);
  });

  it("rejects an expression that never produced a value", () => {
    expect(() => CompileExpression([], NewContext())).to.throw(
      /Expression has no value/,
    );
  });

  it("starts from the source it was handed", () => {
    const context = new DecodingContext({
      ...RefusingCompilers(),
      expression: CompileExpression,
    });
    const out = CompileExpression(
      ValueProxy.constant(1).build(),
      context,
      new ColumnRowSource(AliasedColumns("t"), users),
    );
    expect(out.sql).to.equal("($1::double precision)");
  });

  it("exposes every core stage it can dispatch", () => {
    expect(Object.keys(STAGES)).to.include.members([
      "arg",
      "constant",
      "default",
      "and",
      "or",
      "not",
      "eq",
      "ne",
      "cmp_gt",
      "cmp_ge",
      "cmp_lt",
      "cmp_le",
    ]);
  });
});

describe("arg", () => {
  it("keeps a bound row a row until a value is demanded", () => {
    const out = CompileExpression(ValueProxy.arg(ROW_ID).build(), NewContext());
    expect(out.sql).to.contain(`jsonb_strip_nulls(jsonb_build_object('_id'`);
    expect(out.type).to.deep.equal(
      JsonOf({
        _id: TEXT,
        _instance: TEXT,
        age: FLOAT,
        name: TEXT,
        createdAt: TIMESTAMP,
        metadata: JsonOf({ level: FLOAT }),
      }),
    );
  });

  it("accepts a plain value binding", () => {
    const context = NewContext();
    const out = CompileExpression(
      ValueProxy.arg(VALUE_ID).eq("x").build(),
      context,
    );
    expect(out.sql).to.equal(`(e."value" = ($1::text))`);
    expect(out.type).to.equal(BOOL);
  });

  it("invokes a subquery provider binding", () => {
    const out = CompileExpression(
      ValueProxy.arg(SUBQUERY_ID).build(),
      NewContext(),
    );
    expect(out).to.equal(SUBQUERY);
  });

  it("rejects an unbound parameter", () => {
    expect(() =>
      CompileExpression(ValueProxy.arg(99).build(), NewContext()),
    ).to.throw(/Unbound lambda parameter 99/);
  });

  it("does not resolve a binding inherited from Object.prototype", () => {
    for (const key of ["valueOf", "constructor", "__proto__", "toString"]) {
      expect(() => NewContext().arg(key)).to.throw(
        `Unbound lambda parameter ${key}`,
      );
    }
  });

  it("reads a text parameter id as unbound rather than refusing it", () => {
    expect(() =>
      CompileExpression(
        [UntypedStage("arg", undefined, "valueOf")],
        NewContext(),
      ),
    ).to.throw("Unbound lambda parameter valueOf");
  });

  it("reads an arg stage whose parameter id is neither a number nor a text as unbound", () => {
    expect(() =>
      CompileExpression([UntypedStage("arg", undefined, true)], NewContext()),
    ).to.throw("Unbound lambda parameter true");
  });

  it("clears a pending timezone", () => {
    const out = STAGES.arg(
      { timezone: "'UTC'" },
      QueryStage("arg", undefined, VALUE_ID),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
    expect(out.current).to.equal(ELEMENT);
  });
});

describe("constant", () => {
  it("decodes an array through the shared value decoder", () => {
    const out = CompileExpression(
      ValueProxy.constant([1, 2]).build(),
      NewContext(),
    );
    expect(out.sql).to.equal("($1::jsonb)");
    expect(out.type).to.deep.equal(ArrayOf(FLOAT));
  });

  it("names the stage when the value is absent", () => {
    expect(() =>
      CompileExpression(ValueProxy.constant(undefined).build(), NewContext()),
    ).to.throw(/'constant'/);
  });

  it("clears a pending timezone", () => {
    const out = STAGES.constant(
      { timezone: "'UTC'" },
      QueryStage("constant", undefined, 1),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
  });
});

describe("obj_index", () => {
  it("reaches a native column from a literal key", () => {
    const out = Compile((doc) => doc.key("age"));
    expect(out.sql).to.equal(`"t"."age"`);
    expect(out.type).to.equal(FLOAT);
  });

  it("falls to a dynamic lookup when the key is a value proxy", () => {
    const out = Compile((doc) =>
      doc.key("metadata").key(ValueProxy.constant("level")),
    );
    expect(out.sql).to.equal(`("t"."metadata" -> ($1::text))`);
    expect(out.type).to.equal(OPAQUE);
  });

  it("materializes the whole row for a dynamic key over a column source", () => {
    const out = Compile((doc) => doc.key(ValueProxy.constant("age")));
    expect(out.sql).to.contain("jsonb_strip_nulls(jsonb_build_object('_id'");
    expect(out.sql).to.contain(`-> ($1::text))`);
    expect(out.type).to.equal(OPAQUE);
  });

  it("applies a default to a dynamic key", () => {
    const out = Compile((doc) =>
      doc.key("metadata").key(ValueProxy.constant("level"), 0),
    );
    expect(out.sql).to.equal(
      `COALESCE(NULLIF(("t"."metadata" -> ($2::text)), 'null'::jsonb), to_jsonb(($1::double precision)))`,
    );
    expect(out.type).to.equal(OPAQUE);
  });

  it("clears a pending timezone", () => {
    const out = STAGES.obj_index(
      {
        current: new ColumnRowSource(AliasedColumns("t"), users),
        timezone: "'UTC'",
      },
      QueryStage("obj_index", undefined, "age"),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
  });
});

describe("default", () => {
  it("coalesces a declared column against its fallback", () => {
    const out = Compile((doc) => doc.key("age").default(0));
    expect(out.sql).to.equal(`COALESCE("t"."age", ($1::double precision))`);
    expect(out.type).to.equal(FLOAT);
  });

  it("fires on an undeclared key holding a stored json null", () => {
    const out = Compile((doc) => doc.key("meta").default({}));
    expect(out.sql).to.equal(
      `COALESCE(NULLIF(("t"."_extra" -> 'meta'), 'null'::jsonb), jsonb_build_object())`,
    );
    expect(out.type).to.deep.equal({ kind: "json", keys: {} });
  });

  /**
   * The stage's default is an *alternative value* and not a value of the column's type, which the
   * contract's own suite relies on: `key("status").eq("completed").default("pending")` substitutes
   * a string for a boolean. Unifying to the bottom type is what makes that work.
   */
  it("unifies a mismatched default with the value, rather than reading it as its type", () => {
    const out = Compile((doc) => doc.key("age").default("30"));
    expect(out.sql).to.contain("to_jsonb");
    expect(out.type).to.equal(OPAQUE);
  });

  /**
   * A *field's* default is the other promise, and the difference is the column: a mismatched one
   * unified the column itself to jsonb, so a comparison over it stopped reaching the btree index and
   * a `timestamp` column stopped being revived as a `Date` — a default nothing ever returned still
   * changing how every row was read.
   */
  it("reads a two-argument key's default as the column's type, leaving the column alone", () => {
    const out = Compile((doc) => doc.key("age", "30"));
    expect(out.sql).to.contain(`COALESCE("t"."age",`);
    expect(out.sql).to.not.contain("to_jsonb");
    expect(out.type).to.equal(FLOAT);
  });
});

describe("boolean stages", () => {
  it("joins two predicates with AND", () => {
    const out = Compile((doc) =>
      doc.key("age").gt(25).and(doc.key("age").lt(40)),
    );
    expect(out.sql).to.equal(
      `(("t"."age" > ($1::double precision)) AND ("t"."age" < ($2::double precision)))`,
    );
    expect(out.type).to.equal(BOOL);
  });

  it("joins two predicates with OR", () => {
    const out = Compile((doc) =>
      doc.key("age").gt(25).or(doc.key("age").lt(40)),
    );
    expect(out.sql).to.equal(
      `(("t"."age" > ($1::double precision)) OR ("t"."age" < ($2::double precision)))`,
    );
  });

  it("reads a numeric operand as javascript truthiness", () => {
    const out = Compile((doc) => doc.key("age").and(true));
    expect(out.sql).to.equal(`(("t"."age" <> 0) AND ($1::boolean))`);
    expect(out.type).to.equal(BOOL);
  });

  it("reads a text operand as javascript truthiness", () => {
    expect(Compile((doc) => doc.key("name").not()).sql).to.equal(
      `(("t"."name" <> '') IS NOT TRUE)`,
    );
  });

  it("reads a timestamp operand as present or absent", () => {
    expect(Compile((doc) => doc.key("createdAt").not()).sql).to.equal(
      `(("t"."createdAt" IS NOT NULL) IS NOT TRUE)`,
    );
  });

  it("reads a jsonb operand as javascript truthiness", () => {
    const out = Compile((doc) => doc.key("flagged").not());
    expect(out.sql).to.equal(
      `((("t"."_extra" -> 'flagged') ${FALSEHOOD}) IS NOT TRUE)`,
    );
    expect(out.type).to.equal(BOOL);
  });

  it("does not assert a truthy jsonb operand into a negation", () => {
    const out = Compile((doc) => doc.key("flagged").not());
    expect(out.sql).to.not.contain("jsonb_typeof");
    expect(out.sql).to.not.contain("#>>");
  });

  it("answers true for an operand that is null, where NOT answers null", () => {
    const truthy = `(("t"."_extra" -> 'missing') ${FALSEHOOD})`;
    const out = Compile((doc) => doc.key("missing").not());
    expect(out.sql).to.equal(`(${truthy} IS NOT TRUE)`);
    expect(out.sql).to.not.contain("(NOT ");
  });

  it("negates a declared column through the same three-valued test", () => {
    expect(Compile((doc) => doc.key("age").not()).sql).to.equal(
      `(("t"."age" <> 0) IS NOT TRUE)`,
    );
  });

  it("rejects a missing operand naming the stage", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), UntypedStage("and")],
        NewContext(),
      ),
    ).to.throw(/'and'/);
  });

  it("leaves a null operand null rather than reading it as false", () => {
    const truthy = `(("t"."_extra" -> 'missing') ${FALSEHOOD})`;
    expect(Compile((doc) => doc.key("missing").and(true)).sql).to.equal(
      `(${truthy} AND ($1::boolean))`,
    );
    expect(Compile((doc) => doc.key("missing").or(true)).sql).to.equal(
      `(${truthy} OR ($1::boolean))`,
    );
  });
});
