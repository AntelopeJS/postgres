import { expect } from "chai";
import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";

import { RefusingCompilers } from "./spec-fixture";
import { AsValue } from "../../implementations/database/stage";
import type { Compiled } from "../../implementations/database/sql";
import type { TableModel } from "../../implementations/database/fields";
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
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

const LAMBDA_ID_FLOOR = 0;
const ROW_ID = LAMBDA_ID_FLOOR - 1;

const users: TableModel = {
  fields: {
    age: { column: "age", type: FLOAT },
    name: { column: "name", type: TEXT },
    isActive: { column: "isActive", type: BOOL },
    createdAt: { column: "createdAt", type: TIMESTAMP },
    tags: { column: "tags", type: ArrayOf(TEXT) },
    metadata: { column: "metadata", type: JsonOf({ level: FLOAT }) },
  },
};

type Builder = (doc: ValueProxy<any>) => ValueProxy<any>;

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

const AGE = `"t"."age"`;
const NAME = `"t"."name"`;
const ACTIVE = `"t"."isActive"`;
const CREATED = `"t"."createdAt"`;
const METADATA = `"t"."metadata"`;
const FLOAT_PARAM = "($1::double precision)";
const TEXT_PARAM = "($1::text)";
const SECONDS = "interval '1 second'";

function Extra(key: string): string {
  return `("t"."_extra" -> '${key}')`;
}

function AsNumber(sql: string): string {
  return `(CASE WHEN jsonb_typeof(${sql}) = 'number' THEN ((${sql} #>> '{}')::double precision) END)`;
}

function AsText(sql: string): string {
  return `(CASE WHEN jsonb_typeof(${sql}) = 'string' THEN (${sql} #>> '{}') END)`;
}

const NUMERIC_TEXT_PATTERN =
  "'^\\s*[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?\\s*$'";

function AsNumericText(sql: string): string {
  return `(CASE WHEN ${sql} ~ ${NUMERIC_TEXT_PATTERN} THEN ((${sql})::double precision) END)`;
}

function Finite(sql: string): string {
  return `NULLIF(NULLIF(NULLIF(${sql}, 'NaN'::float8), 'Infinity'::float8), '-Infinity'::float8)`;
}

function Int32(sql: string): string {
  return `(mod(trunc(${Finite(sql)})::numeric, 4294967296::numeric)::bigint::bit(32)::int)`;
}

function Uint32(sql: string): string {
  return `(${Int32(sql)}::bigint & 4294967295)`;
}

function ShiftCount(sql: string): string {
  return `(${Int32(sql)} & 31)`;
}

function AsFloat(sql: string): string {
  return `((${sql})::double precision)`;
}

describe("numeric stage dispatch", () => {
  it("exposes every numeric stage it can dispatch", () => {
    expect(Object.keys(STAGES)).to.include.members([
      "add",
      "sub",
      "mul",
      "div",
      "mod",
      "round",
      "ceil",
      "floor",
      "bit_and",
      "bit_or",
      "bit_xor",
      "bit_not",
      "bit_lshift",
      "bit_rshift",
    ]);
  });

  it("clears a pending timezone", () => {
    const out = STAGES.round(
      { current: { sql: AGE, type: FLOAT }, timezone: "'UTC'" },
      QueryStage("round"),
      NewContext(),
    );
    expect(out.timezone).to.equal(undefined);
  });

  it("names the stage when the second operand is absent", () => {
    const binary = [
      "add",
      "sub",
      "mul",
      "div",
      "mod",
      "bit_and",
      "bit_or",
      "bit_xor",
      "bit_lshift",
      "bit_rshift",
    ];
    for (const name of binary) {
      expect(() =>
        CompileExpression(
          // @ts-expect-error a binary stage with no operand, which each stage refuses by naming itself
          [QueryStage("arg", undefined, ROW_ID), QueryStage(name)],
          NewContext(),
        ),
      ).to.throw(`'${name}'`);
    }
  });
});

describe("add", () => {
  it("adds two numbers without materializing the row", () => {
    const out = Compile((doc) => doc.key("age").add(5));
    expect(out.sql).to.equal(`(${AGE} + ${FLOAT_PARAM})`);
    expect(out.type).to.equal(FLOAT);
    expect(out.sql).to.not.contain("jsonb");
  });

  it("reads a number added to a date as seconds", () => {
    const out = Compile((doc) => doc.key("createdAt").add(3600));
    expect(out.sql).to.equal(
      `("t"."createdAt" + (${FLOAT_PARAM}) * ${SECONDS})`,
    );
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("reads the same offset with the operands the other way round", () => {
    const out = CompileExpression(
      ValueProxy.constant(3600)
        .add(ValueProxy.arg<any>(ROW_ID).key("createdAt"))
        .build(),
      NewContext(),
    );
    expect(out.sql).to.equal(
      `("t"."createdAt" + (${FLOAT_PARAM}) * ${SECONDS})`,
    );
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("concatenates two strings", () => {
    const out = Compile((doc) => doc.key("name").add("!"));
    expect(out.sql).to.equal(`("t"."name" || ($1::text))`);
    expect(out.type).to.equal(TEXT);
  });

  it("concatenates two arrays and keeps the element type", () => {
    const out = Compile((doc) => doc.key("tags").add(["x"]));
    expect(out.sql).to.equal(
      `("t"."tags" || NULLIF(($1::jsonb), 'null'::jsonb))`,
    );
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("rejects two dates, naming the stage", () => {
    expect(() =>
      // @ts-expect-error two dates, which the add stage refuses by naming itself
      Compile((doc) => doc.key("createdAt").add(new Date())),
    ).to.throw(
      /Stage 'add' has no reading for a 'timestamp' and a 'timestamp'/,
    );
  });

  it("pulls an undeclared key toward the kind of the other operand", () => {
    expect(Compile((doc) => doc.key("nope").add("x")).sql).to.equal(
      `(${AsText(Extra("nope"))} || ${TEXT_PARAM})`,
    );
    expect(Compile((doc) => doc.key("nope").add(5)).sql).to.equal(
      `(${AsNumber(Extra("nope"))} + ${FLOAT_PARAM})`,
    );
  });

  it("reads an undeclared key added to a date as seconds, in either order", () => {
    const offset = `(${CREATED} + (${AsNumber(Extra("nope"))}) * ${SECONDS})`;
    const forward = Compile((doc) => doc.key("createdAt").add(doc.key("nope")));
    expect(forward.sql).to.equal(offset);
    expect(forward.type).to.equal(TIMESTAMP);
    expect(
      Compile((doc) => doc.key("nope").add(doc.key("createdAt"))).sql,
    ).to.equal(offset);
  });

  it("reads a null added to a date as seconds rather than rejecting the pair", () => {
    const out = Compile((doc) => doc.key("createdAt").add(null));
    expect(out.sql).to.equal(
      `(${CREATED} + (${AsNumber("'null'::jsonb")}) * ${SECONDS})`,
    );
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("pulls a shaped json operand toward the other kind, as it does an opaque one", () => {
    expect(Compile((doc) => doc.key("metadata").add("x")).sql).to.equal(
      `(${AsText(METADATA)} || ${TEXT_PARAM})`,
    );
    expect(
      Compile((doc) => doc.key("metadata").add(doc.key("createdAt"))).sql,
    ).to.equal(`(${CREATED} + (${AsNumber(METADATA)}) * ${SECONDS})`);
  });
});

describe("sub", () => {
  it("subtracts two numbers", () => {
    const out = Compile((doc) => doc.key("age").sub(5));
    expect(out.sql).to.equal(`(${AGE} - ${FLOAT_PARAM})`);
    expect(out.type).to.equal(FLOAT);
  });

  it("reads a number subtracted from a date as seconds", () => {
    const out = Compile((doc) => doc.key("createdAt").sub(3600));
    expect(out.sql).to.equal(
      `("t"."createdAt" - (${FLOAT_PARAM}) * ${SECONDS})`,
    );
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("reads the difference of two dates as seconds", () => {
    const out = Compile((doc) =>
      doc.key("createdAt").sub(new Date("2023-01-15T00:00:00Z")),
    );
    expect(out.sql).to.equal(
      `(EXTRACT(EPOCH FROM ("t"."createdAt" - ($1::timestamptz)))::double precision)`,
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("reads an undeclared key subtracted from a date as seconds", () => {
    const out = Compile((doc) => doc.key("createdAt").sub(doc.key("nope")));
    expect(out.sql).to.equal(
      `(${CREATED} - (${AsNumber(Extra("nope"))}) * ${SECONDS})`,
    );
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("names the kinds it dispatched on, not the kinds it was given", () => {
    expect(() =>
      Compile((doc) => doc.key("nope").sub(doc.key("createdAt"))),
    ).to.throw(/Stage 'sub' has no reading for a 'float' and a 'timestamp'/);
  });

  it("rejects the operand orders and kinds that have no reading", () => {
    expect(() =>
      CompileExpression(
        ValueProxy.constant(5)
          .sub(ValueProxy.arg<any>(ROW_ID).key("createdAt"))
          .build(),
        NewContext(),
      ),
    ).to.throw(/Stage 'sub' has no reading for a 'float' and a 'timestamp'/);
    expect(() => Compile((doc) => doc.key("name").sub("x"))).to.throw(
      /Stage 'sub' has no reading for a 'text' and a 'text'/,
    );
    expect(() => Compile((doc) => doc.key("tags").sub(["x"]))).to.throw(
      /Stage 'sub' has no reading for a 'array' and a 'array'/,
    );
  });
});

describe("mul, div and mod", () => {
  it("multiplies with the plain infix operator", () => {
    expect(Compile((doc) => doc.key("age").mul(2)).sql).to.equal(
      `(${AGE} * ${FLOAT_PARAM})`,
    );
  });

  it("reads a zero divisor as absent, since a bare / raises 22012 and loses the statement", () => {
    expect(Compile((doc) => doc.key("age").div(2)).sql).to.equal(
      `(${AGE} / NULLIF(${FLOAT_PARAM}, 0))`,
    );
  });

  it("routes the modulo through numeric, since double precision has no % operator", () => {
    const out = Compile((doc) => doc.key("age").mod(10));
    expect(out.sql).to.equal(
      `(mod((${AGE})::numeric, NULLIF((${FLOAT_PARAM})::numeric, 0))::double precision)`,
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("guards the modulo's divisor too, since mod() raises 22012 exactly as / does", () => {
    const out = Compile((doc) => doc.key("age").mod(0));
    expect(out.sql).to.contain("NULLIF(");
    expect(out.sql).to.equal(
      `(mod((${AGE})::numeric, NULLIF((${FLOAT_PARAM})::numeric, 0))::double precision)`,
    );
  });

  it("guards the divisor alone, leaving the dividend a bare indexable column", () => {
    const out = Compile((doc) => doc.key("age").div(2));
    expect(out.sql).to.equal(`(${AGE} / NULLIF(${FLOAT_PARAM}, 0))`);
    expect(out.sql.indexOf("NULLIF")).to.be.greaterThan(
      out.sql.indexOf(`${AGE} /`),
    );
  });

  it("wraps each modulo operand, since :: binds tighter than an infix operator", () => {
    const out = Compile((doc) => doc.key("name").mod(10));
    expect(out.sql).to.equal(
      `(mod((${AsNumericText(NAME)})::numeric, NULLIF((${FLOAT_PARAM})::numeric, 0))::double precision)`,
    );
  });
});

describe("the arithmetic fallback", () => {
  it("reads a boolean operand as one or zero rather than casting it", () => {
    const out = Compile((doc) => doc.key("isActive").add(1));
    expect(out.sql).to.equal(
      `(((${ACTIVE})::int::double precision) + ${FLOAT_PARAM})`,
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("reads a date operand as epoch milliseconds rather than casting it", () => {
    const out = Compile((doc) => doc.key("createdAt").mul(2));
    expect(out.sql).to.equal(
      `(((EXTRACT(EPOCH FROM ${CREATED}) * 1000)::double precision) * ${FLOAT_PARAM})`,
    );
  });

  it("guards a text operand rather than letting the data decide", () => {
    const out = Compile((doc) => doc.key("name").add(5));
    expect(out.sql).to.equal(`(${AsNumericText(NAME)} + ${FLOAT_PARAM})`);
    expect(out.type).to.equal(FLOAT);
  });

  it("reduces a boolean operand for a bitwise stage too", () => {
    expect(Compile((doc) => doc.key("isActive").band(1)).sql).to.equal(
      AsFloat(
        `${Int32(`((${ACTIVE})::int::double precision)`)} & ${Int32(FLOAT_PARAM)}`,
      ),
    );
  });
});

interface RoundingProbe {
  operand: string;
  value: number;
}

const ROUNDING_PROBES: RoundingProbe[] = [
  { operand: "2.5", value: 3 },
  { operand: "-2.5", value: -2 },
];

function RoundSql(operand: string): string {
  return AsValue(
    STAGES.round(
      { current: { sql: operand, type: FLOAT } },
      QueryStage("round"),
      NewContext(),
    ),
  ).sql;
}

describe("round, ceil and floor", () => {
  it("rounds half up, so 2.5 is 3 and -2.5 is -2", () => {
    for (const probe of ROUNDING_PROBES) {
      expect(RoundSql(probe.operand), probe.operand).to.equal(
        `(floor((${probe.operand}) + 0.5))`,
      );
      expect(Math.round(Number(probe.operand)), probe.operand).to.equal(
        probe.value,
      );
    }
  });

  it("emits the half-up spelling for a column, not round()", () => {
    const out = Compile((doc) => doc.key("age").round());
    expect(out.sql).to.equal(`(floor((${AGE}) + 0.5))`);
    expect(out.sql).to.not.contain("round(");
    expect(out.type).to.equal(FLOAT);
  });

  it("uses the sql functions for ceil and floor", () => {
    expect(Compile((doc) => doc.key("age").ceil()).sql).to.equal(
      `(ceil(${AGE}))`,
    );
    expect(Compile((doc) => doc.key("age").floor()).sql).to.equal(
      `(floor(${AGE}))`,
    );
  });
});

interface Int32Probe {
  javascript: string;
  compute: () => number;
  value: number;
  operand: number;
  stage: QueryStage;
  sql: string;
}

const ZERO = 0;
const ONE = 1;
const THIRTY_ONE = 31;
const PRESERVE_SIGN = { preserveSign: true };

const INT32_PROBES: Int32Probe[] = [
  {
    javascript: "1e20 | 0",
    compute: () => 1e20 | 0,
    value: 1661992960,
    operand: 1e20,
    stage: QueryStage("bit_or", undefined, ZERO),
    sql: AsFloat(`${Int32("100000000000000000000")} | ${Int32(FLOAT_PARAM)}`),
  },
  {
    javascript: "2147483648 | 0",
    compute: () => 2147483648 | 0,
    value: -2147483648,
    operand: 2147483648,
    stage: QueryStage("bit_or", undefined, ZERO),
    sql: AsFloat(`${Int32("2147483648")} | ${Int32(FLOAT_PARAM)}`),
  },
  {
    javascript: "-3.7 | 0",
    compute: () => -3.7 | 0,
    value: -3,
    operand: -3.7,
    stage: QueryStage("bit_or", undefined, ZERO),
    sql: AsFloat(`${Int32("-3.7")} | ${Int32(FLOAT_PARAM)}`),
  },
  {
    javascript: "1 << 31",
    compute: () => 1 << 31,
    value: -2147483648,
    operand: 1,
    stage: QueryStage("bit_lshift", undefined, THIRTY_ONE),
    sql: AsFloat(`${Int32("1")} << ${ShiftCount(FLOAT_PARAM)}`),
  },
  {
    javascript: "-8 >>> 1",
    compute: () => -8 >>> 1,
    value: 2147483644,
    operand: -8,
    stage: QueryStage("bit_rshift", undefined, ONE),
    sql: AsFloat(`${Uint32("-8")} >> ${ShiftCount(FLOAT_PARAM)}`),
  },
  {
    javascript: "-8 >> 1",
    compute: () => -8 >> 1,
    value: -4,
    operand: -8,
    stage: QueryStage("bit_rshift", PRESERVE_SIGN, ONE),
    sql: AsFloat(`${Int32("-8")} >> ${ShiftCount(FLOAT_PARAM)}`),
  },
];

function ProbeSql(probe: Int32Probe): string {
  return AsValue(
    STAGES[probe.stage.stage](
      { current: { sql: String(probe.operand), type: FLOAT } },
      probe.stage,
      NewContext(),
    ),
  ).sql;
}

describe("bitwise stages", () => {
  it("emits the int32 reduction for every case that distinguishes it from ::bigint", () => {
    for (const probe of INT32_PROBES) {
      expect(ProbeSql(probe), probe.javascript).to.equal(probe.sql);
      expect(probe.compute(), probe.javascript).to.equal(probe.value);
    }
  });

  it("reduces an operand through trunc and a modulus, never through ::bigint", () => {
    const out = Compile((doc) => doc.key("age").bnot());
    expect(out.sql).to.equal(AsFloat(`~${Int32(AGE)}`));
    expect(out.type).to.equal(FLOAT);
  });

  it("nulls a non-finite operand, which no bigint conversion accepts", () => {
    const out = Compile((doc) => doc.key("age").band(Number.POSITIVE_INFINITY));
    expect(out.sql).to.equal(AsFloat(`${Int32(AGE)} & ${Int32(FLOAT_PARAM)}`));
    expect(out.sql).to.contain(
      `NULLIF(NULLIF(NULLIF(${AGE}, 'NaN'::float8), 'Infinity'::float8), '-Infinity'::float8)`,
    );
  });

  it("maps each binary operator onto its sql spelling", () => {
    expect(Compile((doc) => doc.key("age").band(3)).sql).to.equal(
      AsFloat(`${Int32(AGE)} & ${Int32(FLOAT_PARAM)}`),
    );
    expect(Compile((doc) => doc.key("age").bor(3)).sql).to.equal(
      AsFloat(`${Int32(AGE)} | ${Int32(FLOAT_PARAM)}`),
    );
    expect(Compile((doc) => doc.key("age").bxor(3)).sql).to.equal(
      AsFloat(`${Int32(AGE)} # ${Int32(FLOAT_PARAM)}`),
    );
  });

  it("masks the shift count to five bits and lets the left shift wrap", () => {
    const out = Compile((doc) => doc.key("age").blshift(2));
    expect(out.sql).to.equal(
      AsFloat(`${Int32(AGE)} << ${ShiftCount(FLOAT_PARAM)}`),
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("shifts right logically unless the caller asked for the sign", () => {
    expect(Compile((doc) => doc.key("age").brshift(1)).sql).to.equal(
      AsFloat(`${Uint32(AGE)} >> ${ShiftCount(FLOAT_PARAM)}`),
    );
    expect(
      Compile((doc) => doc.key("age").brshiftPreserveSign(1)).sql,
    ).to.equal(AsFloat(`${Int32(AGE)} >> ${ShiftCount(FLOAT_PARAM)}`));
  });

  it("reads a nested json key through the guarded numeric projection", () => {
    const level = `(CASE WHEN jsonb_typeof(("t"."metadata" -> 'level')) = 'number' THEN ((("t"."metadata" -> 'level') #>> '{}')::double precision) END)`;
    expect(
      Compile((doc) => doc.key("metadata").key("level").band(3)).sql,
    ).to.equal(AsFloat(`${Int32(level)} & ${Int32(FLOAT_PARAM)}`));
  });
});
