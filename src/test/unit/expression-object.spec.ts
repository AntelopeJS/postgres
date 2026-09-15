import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";

import { Occurrences, RefusingCompilers } from "./spec-fixture";
import type { Compiled } from "../../implementations/database/sql";
import type { TableShape } from "../../implementations/database/fields";
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

const LAMBDA_ID_FLOOR = 0;
const ROW_ID = LAMBDA_ID_FLOOR - 1;
const OTHER_ROW_ID = LAMBDA_ID_FLOOR - 2;

const users: TableShape = {
  fields: {
    age: { column: "age", type: FLOAT },
    name: { column: "name", type: TEXT },
    createdAt: { column: "createdAt", type: TIMESTAMP },
    tags: { column: "tags", type: ArrayOf(TEXT) },
    metadata: {
      column: "metadata",
      type: JsonOf({ level: FLOAT, since: TIMESTAMP }),
    },
  },
};

type Builder = (doc: ValueProxy<any>) => any;

function NewContext(): DecodingContext {
  const context = new DecodingContext({
    ...RefusingCompilers(),
    expression: CompileExpression,
  });
  context.bind(ROW_ID, new ColumnRowSource(AliasedColumns("t"), users));
  return context;
}

function Compile(build: Builder): Compiled {
  return CompileExpression(build(ValueProxy.arg(ROW_ID)).build(), NewContext());
}

const METADATA = `"t"."metadata"`;
const NAME = `"t"."name"`;
const FLOAT_PARAM = "($1::double precision)";

function Guarded(operand: string, body: string): string {
  return `(CASE WHEN jsonb_typeof(${operand}) = 'object' THEN ${body} END)`;
}

function HasFields(operand: string, fields: string): string {
  return `((${operand} @> '{}'::jsonb) AND (${operand} ?& ${fields}))`;
}

function Merged(left: string, right: string, alias: string): string {
  const column = `"${alias}"."merged"`;
  return `(SELECT ${column} FROM (SELECT ${left} || ${right} AS "merged") AS "${alias}" WHERE jsonb_typeof(${column}) = 'object')`;
}

function Keys(operand: string, alias: string): string {
  return `(SELECT COALESCE(jsonb_agg("${alias}"."key" ORDER BY "${alias}"."ord"), '[]'::jsonb) FROM jsonb_object_keys(${operand}) WITH ORDINALITY AS "${alias}"("key", "ord"))`;
}

function Values(operand: string, alias: string): string {
  return `(SELECT COALESCE(jsonb_agg("${alias}"."value" ORDER BY "${alias}"."ord"), '[]'::jsonb) FROM jsonb_each(${operand}) WITH ORDINALITY AS "${alias}"("key", "value", "ord"))`;
}

describe("object stage dispatch", () => {
  it("exposes every object stage it can dispatch", () => {
    expect(Object.keys(STAGES)).to.include.members([
      "obj_index",
      "obj_merge",
      "obj_keys",
      "obj_values",
      "obj_has",
    ]);
  });

  it("clears a pending timezone", () => {
    const stages = [
      QueryStage("obj_merge", undefined, {}),
      QueryStage("obj_keys"),
      QueryStage("obj_values"),
      QueryStage("obj_has", undefined, ["a"]),
    ];
    for (const stage of stages) {
      const out = STAGES[stage.stage](
        { current: { sql: METADATA, type: OPAQUE }, timezone: "'UTC'" },
        stage,
        NewContext(),
      );
      expect(out.timezone, stage.stage).to.equal(undefined);
    }
  });
});

describe("obj_merge", () => {
  it("merges two objects shallowly with the jsonb concatenation operator", () => {
    const out = Compile((doc) => doc.key("metadata").merge({ level: 9 }));
    const right = `jsonb_build_object('level', to_jsonb(${FLOAT_PARAM}))`;
    expect(out.sql).to.equal(Merged(METADATA, right, "t0"));
  });

  it("merges the shapes so a date survives the merge as a date", () => {
    const out = Compile((doc) =>
      doc.key("metadata").merge({ level: 9, extra: "x" }),
    );
    expect(out.type).to.deep.equal(
      JsonOf({ level: FLOAT, since: TIMESTAMP, extra: TEXT }),
    );
  });

  it("keeps the left shape when the right side declares no member", () => {
    const out = Compile((doc) => doc.key("metadata").merge({}));
    expect(out.type).to.deep.equal(JsonOf({ level: FLOAT, since: TIMESTAMP }));
  });

  it("lets the right shape win on a key both sides declare", () => {
    const out = Compile((doc) =>
      doc.key("metadata").merge({ level: "nine" as never }),
    );
    expect(out.type).to.deep.equal(JsonOf({ level: TEXT, since: TIMESTAMP }));
  });

  it("falls to the bottom type when either shape is unknown", () => {
    expect(
      Compile((doc) => doc.key("nope").merge({ level: 9 })).type,
    ).to.deep.equal(OPAQUE);
    expect(
      Compile((doc) => doc.key("metadata").merge(doc.key("nope") as never))
        .type,
    ).to.deep.equal(OPAQUE);
  });

  it("guards the merged result, since || wraps a non-object into an array", () => {
    const out = Compile((doc) => doc.key("metadata").merge([1] as never));
    const right = `jsonb_build_array(to_jsonb(${FLOAT_PARAM}))`;
    expect(out.sql).to.equal(Merged(METADATA, right, "t0"));
  });

  it("reads a scalar operand as jsonb rather than emitting a || postgresql rejects", () => {
    const out = Compile((doc) => doc.key("name").merge({ level: 9 }));
    const right = `jsonb_build_object('level', to_jsonb(${FLOAT_PARAM}))`;
    expect(out.sql).to.equal(Merged(`to_jsonb(${NAME})`, right, "t0"));
  });

  it("merges a bound row, which is the only form a join projection builds", () => {
    const context = NewContext();
    context.bind(OTHER_ROW_ID, new ColumnRowSource(AliasedColumns("r"), users));
    const out = CompileExpression(
      ValueProxy.arg<any>(ROW_ID)
        .merge({ customer: ValueProxy.arg(OTHER_ROW_ID) })
        .build(),
      context,
    );
    const left = new ColumnRowSource(AliasedColumns("t"), users).toJson().sql;
    const right = new ColumnRowSource(AliasedColumns("r"), users).toJson().sql;
    expect(out.sql).to.equal(
      Merged(left, `jsonb_build_object('customer', ${right})`, "t0"),
    );
    expect(out.type).to.deep.equal(
      JsonOf({
        ...new ColumnRowSource(AliasedColumns("t"), users).shape(),
        customer: JsonOf(
          new ColumnRowSource(AliasedColumns("r"), users).shape(),
        ),
      }),
    );
  });

  it("emits each operand once, so chained merges grow linearly", () => {
    const context = NewContext();
    context.bind(OTHER_ROW_ID, new ColumnRowSource(AliasedColumns("r"), users));
    const out = CompileExpression(
      ValueProxy.arg<any>(ROW_ID)
        .merge({ customer: ValueProxy.arg(OTHER_ROW_ID) })
        .merge({ level: 9 })
        .build(),
      context,
    );
    expect(Occurrences(out.sql, NAME)).to.equal(1);
    expect(Occurrences(out.sql, `"r"."name"`)).to.equal(1);
  });

  it("takes a fresh alias for every merge in one expression", () => {
    const out = Compile((doc) =>
      doc.key("metadata").merge({ level: 9 }).merge({ other: 1 }),
    );
    expect(out.sql).to.contain(`AS "t0"`);
    expect(out.sql).to.contain(`AS "t1"`);
  });

  it("names the stage when the other object is absent", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("obj_merge")],
        NewContext(),
      ),
    ).to.throw(/'obj_merge'/);
  });
});

describe("obj_keys", () => {
  it("aggregates the keys of a shaped column in jsonb's own stored order", () => {
    const out = Compile((doc) => doc.key("metadata").keys());
    expect(out.sql).to.equal(Guarded(METADATA, Keys(METADATA, "t0")));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("gives two walks in one expression different aliases", () => {
    const out = Compile((doc) =>
      doc.key("metadata").keys().eq(doc.key("metadata").keys()),
    );
    const aliases = [...out.sql.matchAll(/AS "(t\d+)"/g)].map(
      (match) => match[1],
    );
    expect(aliases).to.deep.equal(["t0", "t1"]);
  });

  it("reads a scalar operand as jsonb, so the guard nulls it instead of failing", () => {
    const left = `to_jsonb(${NAME})`;
    expect(Compile((doc) => doc.key("name").keys()).sql).to.equal(
      Guarded(left, Keys(left, "t0")),
    );
  });

  it("materializes a row before walking it", () => {
    const out = CompileExpression(
      ValueProxy.arg<any>(ROW_ID).keys().build(),
      NewContext(),
    );
    expect(out.sql).to.contain("jsonb_strip_nulls(jsonb_build_object('_id'");
    expect(out.sql).to.contain("jsonb_object_keys(");
  });
});

describe("obj_values", () => {
  it("aggregates the values in the same order as the keys", () => {
    const out = Compile((doc) => doc.key("metadata").values());
    expect(out.sql).to.equal(Guarded(METADATA, Values(METADATA, "t0")));
  });

  it("keeps the element type at the bottom, since a shape is not exhaustive", () => {
    expect(Compile((doc) => doc.key("metadata").values()).type).to.deep.equal(
      ArrayOf(OPAQUE),
    );
  });

  it("never orders by the key, which would depend on the collation", () => {
    const keys = Compile((doc) => doc.key("metadata").keys()).sql;
    const values = Compile((doc) => doc.key("metadata").values()).sql;
    expect(keys).to.not.contain(`ORDER BY "t0"."key"`);
    expect(values).to.not.contain(`ORDER BY "t0"."key"`);
  });

  it("coalesces an empty object to an empty array rather than null", () => {
    const empty = "jsonb_build_object()";
    const out = CompileExpression(
      ValueProxy.constant({}).values().build(),
      NewContext(),
    );
    expect(out.sql).to.equal(Guarded(empty, Values(empty, "t0")));
  });
});

describe("obj_has", () => {
  it("builds a text array of literal keys, not a decoded parameter", () => {
    const context = NewContext();
    const out = CompileExpression(
      ValueProxy.arg<any>(ROW_ID)
        .key("metadata")
        .hasfields("level", "since")
        .build(),
      context,
    );
    expect(out.sql).to.equal(
      HasFields(METADATA, `array['level', 'since']::text[]`),
    );
    expect(out.type).to.equal(BOOL);
    expect(context.params.all()).to.deep.equal([]);
  });

  it("reads an empty field list as vacuously true, but only of an object", () => {
    const out = Compile((doc) => doc.key("metadata").hasfields());
    expect(out.sql).to.equal(HasFields(METADATA, `array[]::text[]`));
  });

  it("escapes a quote in a field name", () => {
    const out = Compile((doc) => doc.key("metadata").hasfields("o'clock"));
    expect(out.sql).to.equal(HasFields(METADATA, `array['o''clock']::text[]`));
  });

  it("tests an array as an object first, where ?& alone tests elements", () => {
    const tags = `"t"."tags"`;
    const out = Compile((doc) => doc.key("tags").hasfields("urgent"));
    expect(out.sql).to.equal(HasFields(tags, `array['urgent']::text[]`));
  });

  it("spells the object test as a conjunction, which a gin index sees through", () => {
    const out = Compile((doc) => doc.key("metadata").hasfields("level"));
    expect(out.sql).to.not.contain("CASE");
    expect(out.sql).to.contain(`(${METADATA} @> '{}'::jsonb) AND `);
  });

  it("reads a scalar operand as jsonb, since ?& has no double precision form", () => {
    const age = `to_jsonb("t"."age")`;
    const out = Compile((doc) => doc.key("age").hasfields("a"));
    expect(out.sql).to.equal(HasFields(age, `array['a']::text[]`));
  });

  it("names the stage when the field list is not a list", () => {
    expect(() =>
      CompileExpression(
        [QueryStage("arg", undefined, ROW_ID), QueryStage("obj_has")],
        NewContext(),
      ),
    ).to.throw(/'obj_has'/);
  });

  it("names the stage when a field name is not a string", () => {
    expect(() =>
      CompileExpression(
        [
          QueryStage("arg", undefined, ROW_ID),
          QueryStage("obj_has", undefined, [5]),
        ],
        NewContext(),
      ),
    ).to.throw(/'obj_has'/);
  });
});
