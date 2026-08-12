import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import { DecodingContext } from "../../implementations/database/context";
import {
  CompileExpression,
  STAGES,
} from "../../implementations/database/expression";
import type { TableShape } from "../../implementations/database/fields";
import {
  AliasedColumns,
  ColumnRowSource,
} from "../../implementations/database/row-source";
import type { Compiled } from "../../implementations/database/sql";
import { STRING_STAGES } from "../../implementations/database/stages-string";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import { RefusingCompilers } from "./spec-fixture";

const LAMBDA_ID_FLOOR = 0;
const ROW_ID = LAMBDA_ID_FLOOR - 1;

const users: TableShape = {
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

function CompileIn(context: DecodingContext, build: Builder): Compiled {
  return CompileExpression(build(ValueProxy.arg(ROW_ID)).build(), context);
}

function Compile(build: Builder): Compiled {
  return CompileIn(NewContext(), build);
}

const NAME = `"t"."name"`;
const AGE = `"t"."age"`;
const METADATA = `"t"."metadata"`;
const CREATED_AT = `"t"."createdAt"`;
const TEXT_PARAM = "($1::text)";
const SECOND_TEXT_PARAM = "($2::text)";
const DEFAULT_SEPARATOR = " ";
const ISO_UTC = `(to_char(${CREATED_AT} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`;
const INT32_MAX = "2147483647";
const INT32_MIN = "-2147483648";

function Extra(key: string): string {
  return `("t"."_extra" -> '${key}')`;
}

function AsText(sql: string): string {
  return `(CASE WHEN jsonb_typeof(${sql}) = 'string' THEN (${sql} #>> '{}') END)`;
}

function Split(value: string, separator: string, bounds?: string): string {
  const array = `string_to_array(${value}, ${separator})`;
  return `(to_jsonb(${bounds ? `(${array})[${bounds}]` : array}))`;
}

describe("string stage dispatch", () => {
  it("exposes every string stage it can dispatch", () => {
    expect(Object.keys(STAGES)).to.include.members([
      "str_split",
      "str_concat",
      "str_upcase",
      "str_downcase",
      "str_len",
      "str_match",
    ]);
  });

  it("clears a pending timezone on every stage the family declares", () => {
    const current = { sql: NAME, type: TEXT };
    for (const name of Object.keys(STRING_STAGES)) {
      const out = STAGES[name](
        { current, timezone: "'UTC'" },
        QueryStage(name, undefined, "x"),
        NewContext(),
      );
      expect(out.timezone, name).to.equal(undefined);
    }
  });

  it("names the stage when the operand is absent", () => {
    for (const name of ["str_concat", "str_match"]) {
      expect(() =>
        CompileExpression(
          [QueryStage("arg", undefined, ROW_ID), QueryStage(name)],
          NewContext(),
        ),
      ).to.throw(`'${name}'`);
    }
  });
});

describe("str_upcase and str_downcase", () => {
  it("maps each case stage onto its sql function", () => {
    const upper = Compile((doc) => doc.key("name").upcase());
    expect(upper.sql).to.equal(`(upper(${NAME}))`);
    expect(upper.type).to.equal(TEXT);
    const lower = Compile((doc) => doc.key("name").downcase());
    expect(lower.sql).to.equal(`(lower(${NAME}))`);
    expect(lower.type).to.equal(TEXT);
  });

  it("reads an undeclared key through the guarded text projection", () => {
    const out = Compile((doc) => doc.key("nope").upcase());
    expect(out.sql).to.equal(`(upper(${AsText(Extra("nope"))}))`);
    expect(out.type).to.equal(TEXT);
  });

  it("yields null for a json value that is not a string, rather than its text form", () => {
    const out = Compile((doc) => doc.key("metadata").key("other").upcase());
    expect(out.sql).to.equal(`(upper(${AsText(`(${METADATA} -> 'other')`)}))`);
    expect(out.sql).to.contain("jsonb_typeof");
  });

  it("casts a declared number column, where nothing is heterogeneous to guard", () => {
    const out = Compile((doc) => doc.key("age").upcase());
    expect(out.sql).to.equal(`(upper(((${AGE})::text)))`);
  });
});

describe("str_len", () => {
  it("counts codepoints and hands the driver a double precision", () => {
    const out = Compile((doc) => doc.key("name").strlen());
    expect(out.sql).to.equal(`((length(${NAME}))::double precision)`);
    expect(out.type).to.equal(FLOAT);
  });

  it("wraps the whole call before the cast, since :: binds tighter", () => {
    const out = Compile((doc) => doc.key("nope").strlen());
    expect(out.sql).to.equal(
      `((length(${AsText(Extra("nope"))}))::double precision)`,
    );
    expect(out.sql.endsWith(")::double precision)")).to.equal(true);
  });

  it("renders a timestamp in utc, not under the session's TimeZone and DateStyle", () => {
    const out = Compile((doc) => doc.key("createdAt").strlen());
    expect(out.sql).to.equal(`((length(${ISO_UTC}))::double precision)`);
    expect(out.sql).to.not.contain("::text");
  });
});

describe("str_concat", () => {
  it("concatenates two strings", () => {
    const out = Compile((doc) => doc.key("name").concat("!"));
    expect(out.sql).to.equal(`(${NAME} || ${TEXT_PARAM})`);
    expect(out.type).to.equal(TEXT);
  });

  it("lets a null operand poison the result rather than dropping it", () => {
    const out = Compile((doc) => doc.key("name").concat(doc.key("nope")));
    expect(out.sql).to.equal(`(${NAME} || ${AsText(Extra("nope"))})`);
    expect(out.sql).to.not.contain("COALESCE");
    expect(out.sql).to.not.contain("concat(");
  });

  it("concatenates a timestamp as the iso 8601 string javascript would write", () => {
    const out = Compile((doc) => doc.key("createdAt").concat("!"));
    expect(out.sql).to.equal(`(${ISO_UTC} || ${TEXT_PARAM})`);
  });
});

describe("str_match", () => {
  it("compiles to a posix match and yields a boolean, not a match object", () => {
    const out = Compile((doc) => doc.key("name").match("^a.*@example\\.com$"));
    expect(out.sql).to.equal(`(${NAME} ~ ${TEXT_PARAM})`);
    expect(out.type).to.equal(BOOL);
  });

  it("reads both sides through the guarded text projection", () => {
    const out = Compile((doc) => doc.key("nope").match(doc.key("other")));
    expect(out.sql).to.equal(
      `(${AsText(Extra("nope"))} ~ ${AsText(Extra("other"))})`,
    );
  });
});

/**
 * `\b` is a backspace in ARE and `\y` is the word boundary, so the pattern every JavaScript author
 * writes matched nothing on every input — accepted, and silently always false.
 */
describe("str_match's pattern, which is a different regex language", () => {
  function Bound(pattern: string): unknown[] {
    const context = NewContext();
    CompileIn(context, (doc) => doc.key("name").match(pattern));
    return context.params.all();
  }

  it("rewrites both word boundaries", () => {
    expect(Bound("\\bfoo\\b")).to.deep.equal(["\\yfoo\\y"]);
    expect(Bound("\\Bfoo\\B")).to.deep.equal(["\\Yfoo\\Y"]);
  });

  it("leaves an escaped backslash alone, which a text replacement would not", () => {
    expect(Bound("\\\\bfoo")).to.deep.equal(["\\\\bfoo"]);
    expect(Bound("\\\\\\bfoo")).to.deep.equal(["\\\\\\yfoo"]);
  });

  it("leaves a character class alone, where both flavours already agree", () => {
    expect(Bound("[\\b]")).to.deep.equal(["[\\b]"]);
    expect(Bound("[a\\]\\b]\\bx")).to.deep.equal(["[a\\]\\b]\\yx"]);
  });

  /**
   * ARE's `.` matches a newline and JavaScript's does not without the `s` flag, so `^a.*z$` answered
   * rows a caller expects it to skip. All four codepoints JavaScript's dot declines are excluded,
   * since they cost the same in a bound parameter.
   */
  it("rewrites an unescaped dot to the class JavaScript's dot means", () => {
    expect(Bound("a.z")).to.deep.equal(["a[^\n\r\u2028\u2029]z"]);
  });

  it("leaves an escaped dot alone, which a text replacement would not", () => {
    expect(Bound("a\\.z")).to.deep.equal(["a\\.z"]);
  });

  it("leaves a dot inside a character class alone, where it is already ordinary", () => {
    expect(Bound("[.]")).to.deep.equal(["[.]"]);
    expect(Bound("[a.]z.")).to.deep.equal(["[a.]z[^\n\r\u2028\u2029]"]);
  });

  it("touches nothing else, including the constructs the two flavours share", () => {
    const shared = "^(?=a)\\d+[a-z]*?\\s(x|y)$";
    expect(Bound(shared)).to.deep.equal([shared]);
  });

  it("binds a computed pattern untranslated, having no text to scan", () => {
    const out = Compile((doc) => doc.key("name").match(doc.key("other")));
    expect(out.sql).to.contain("~");
  });
});

describe("str_split", () => {
  it("takes its separator from the options, never from an argument", () => {
    const built = ValueProxy.arg<any>(ROW_ID)
      .key("name")
      .split(",")
      .build()
      .at(-1) as QueryStage;
    expect(built.stage).to.equal("str_split");
    expect(built.args).to.deep.equal([]);
    expect(built.options.separator).to.equal(",");
  });

  it("splits on a space when the caller named no separator", () => {
    const context = NewContext();
    const out = CompileIn(context, (doc) => doc.key("name").split());
    expect(out.sql).to.equal(Split(NAME, TEXT_PARAM));
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
    expect(context.params.all()).to.deep.equal([DEFAULT_SEPARATOR]);
  });

  it("binds the separator as a parameter", () => {
    const context = NewContext();
    const out = CompileIn(context, (doc) => doc.key("name").split(", "));
    expect(out.sql).to.equal(Split(NAME, TEXT_PARAM));
    expect(context.params.all()).to.deep.equal([", "]);
  });

  it("truncates to maxSplits rather than keeping a remainder", () => {
    const out = Compile((doc) => doc.key("name").split(",", 2));
    expect(out.sql).to.equal(Split(NAME, TEXT_PARAM, "1:2"));
  });

  it("truncates a fractional maxSplits rather than ignoring it", () => {
    const out = Compile((doc) => doc.key("name").split(",", 2.7));
    expect(out.sql).to.equal(Split(NAME, TEXT_PARAM, "1:2"));
  });

  it("reads a negative maxSplits as an empty slice", () => {
    const out = Compile((doc) => doc.key("name").split(",", -3));
    expect(out.sql).to.equal(Split(NAME, TEXT_PARAM, "1:-3"));
  });

  it("clamps a bound past int4 to its range, which a slice subscript is", () => {
    const out = Compile((doc) => doc.key("name").split(",", 3e9));
    expect(out.sql).to.equal(Split(NAME, TEXT_PARAM, `1:${INT32_MAX}`));
  });

  it("clamps an infinite maxSplits to the whole array at either end", () => {
    const up = Compile((doc) =>
      doc.key("name").split(",", Number.POSITIVE_INFINITY),
    );
    expect(up.sql).to.equal(Split(NAME, TEXT_PARAM, `1:${INT32_MAX}`));
    const down = Compile((doc) =>
      doc.key("name").split(",", Number.NEGATIVE_INFINITY),
    );
    expect(down.sql).to.equal(Split(NAME, TEXT_PARAM, `1:${INT32_MIN}`));
  });

  it("ignores a maxSplits that is not a number at all", () => {
    const out = Compile((doc) => doc.key("name").split(",", Number.NaN));
    expect(out.sql).to.equal(Split(NAME, TEXT_PARAM));
  });

  it("splits an undeclared key through the guarded text projection", () => {
    const out = Compile((doc) => doc.key("nope").split());
    expect(out.sql).to.equal(Split(AsText(Extra("nope")), TEXT_PARAM));
  });

  it("keeps the separator parameter after the operand's own", () => {
    const context = NewContext();
    const out = CompileIn(context, (doc) =>
      doc.key("name").concat("!").split(","),
    );
    expect(out.sql).to.equal(
      Split(`(${NAME} || ${TEXT_PARAM})`, SECOND_TEXT_PARAM),
    );
    expect(context.params.all()).to.deep.equal(["!", ","]);
  });
});
