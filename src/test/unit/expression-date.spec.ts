import { ValueProxy } from "@antelopejs/interface-database";
import { QueryStage } from "@antelopejs/interface-database/common";
import { expect } from "chai";
import { DecodingContext } from "../../implementations/database/context";
import {
  CompileExpression,
  STAGES,
} from "../../implementations/database/expression";
import type { TableShape } from "../../implementations/database/fields";
import { Moment } from "../../implementations/database/readings";
import {
  AliasedColumns,
  ColumnRowSource,
} from "../../implementations/database/row-source";
import type { Compiled } from "../../implementations/database/sql";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import { Occurrences, RefusingCompilers } from "./spec-fixture";

const LAMBDA_ID_FLOOR = 0;
const ROW_ID = LAMBDA_ID_FLOOR - 1;

const users: TableShape = {
  fields: {
    createdAt: { column: "createdAt", type: TIMESTAMP },
    age: { column: "age", type: FLOAT },
    name: { column: "name", type: TEXT },
    active: { column: "active", type: BOOL },
    tags: { column: "tags", type: ArrayOf(TEXT) },
    metadata: { column: "metadata", type: JsonOf({ at: TIMESTAMP }) },
  },
};

type Builder = (doc: any) => any;

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

function LastStage(build: Builder): QueryStage {
  const stages = build(ValueProxy.arg(ROW_ID)).build();
  return stages[stages.length - 1];
}

const CREATED = `"t"."createdAt"`;
const AGE = `"t"."age"`;
const NAME = `"t"."name"`;
const ACTIVE = `"t"."active"`;
const TAGS = `"t"."tags"`;
const EXTRA = `("t"."_extra" -> 'nope')`;

const UTC = "'UTC'";
const NEW_YORK_NAME = "America/New_York";
const NEW_YORK = "'America/New_York'";
const PARIS_NAME = "Europe/Paris";
const PARIS = "'Europe/Paris'";
const MOMENT_PARAM = "($1::timestamptz)";
const SECOND_MOMENT_PARAM = "($2::timestamptz)";

const EARLIEST = "-210866803200000";
const LATEST = "8640000000000000";

function AsFloat(sql: string): string {
  return `((${sql})::double precision)`;
}

function FromEpoch(sql: string): string {
  const bounded = `(CASE WHEN ${sql} BETWEEN ${EARLIEST} AND ${LATEST} THEN ${sql} END)`;
  return `(to_timestamp(${bounded} / 1000))`;
}

function FromText(sql: string): string {
  return `(CASE WHEN pg_input_is_valid(${sql}, 'timestamptz') THEN ((${sql})::timestamptz) END)`;
}

function FromJson(sql: string): string {
  const parses = `pg_input_is_valid((${sql} #>> '{}'), 'timestamptz')`;
  return `(CASE WHEN jsonb_typeof(${sql}) = 'string' AND ${parses} THEN ((${sql} #>> '{}')::timestamptz) END)`;
}

function Local(sql: string, zone = UTC): string {
  return `(${sql} AT TIME ZONE ${zone})`;
}

function Part(field: string, sql: string, zone = UTC): string {
  return AsFloat(`EXTRACT(${field} FROM ${Local(sql, zone)})`);
}

function TimeOfDay(sql: string, zone = UTC): string {
  const local = Local(sql, zone);
  return AsFloat(
    `EXTRACT(EPOCH FROM (${local} - date_trunc('day', ${local})))`,
  );
}

const DATE_STAGE_NAMES = [
  "date_with_timezone",
  "date_during",
  "date_epoch",
  "date_tod",
  "date_year",
  "date_month",
  "date_day",
  "date_dow",
  "date_doy",
  "date_hours",
  "date_minutes",
  "date_seconds",
];

interface DatePart {
  build: Builder;
  field: string;
}

const DATE_PARTS: DatePart[] = [
  { build: (doc) => doc.key("createdAt").year(), field: "YEAR" },
  { build: (doc) => doc.key("createdAt").month(), field: "MONTH" },
  { build: (doc) => doc.key("createdAt").day(), field: "DAY" },
  { build: (doc) => doc.key("createdAt").dayofweek(), field: "ISODOW" },
  { build: (doc) => doc.key("createdAt").dayofyear(), field: "DOY" },
  { build: (doc) => doc.key("createdAt").hours(), field: "HOUR" },
  { build: (doc) => doc.key("createdAt").minutes(), field: "MINUTE" },
  { build: (doc) => doc.key("createdAt").seconds(), field: "SECOND" },
];

describe("date stage dispatch", () => {
  it("exposes every date stage it can dispatch", () => {
    expect(Object.keys(STAGES)).to.include.members(DATE_STAGE_NAMES);
  });

  it("clears the pending timezone in every date stage, reader or not", () => {
    const builders: Builder[] = [
      ...DATE_PARTS.map((part) => part.build),
      (doc) => doc.key("createdAt").timeofday(),
      (doc) => doc.key("createdAt").epoch(),
      (doc) => doc.key("createdAt").during(new Date(0), new Date(1)),
    ];
    for (const build of builders) {
      const stage = LastStage(build);
      const out = STAGES[stage.stage](
        { current: { sql: CREATED, type: TIMESTAMP }, timezone: NEW_YORK },
        stage,
        NewContext(),
      );
      expect(out.timezone, stage.stage).to.equal(undefined);
    }
  });
});

describe("date parts", () => {
  for (const part of DATE_PARTS) {
    it(`extracts ${part.field} in an explicitly named zone`, () => {
      const out = Compile(part.build);
      expect(out.sql).to.equal(Part(part.field, CREATED));
      expect(out.type).to.equal(FLOAT);
    });
  }

  it("names iso weekdays, so monday is 1 and sunday is 7", () => {
    expect(Compile((doc) => doc.key("createdAt").dayofweek()).sql).to.contain(
      "EXTRACT(ISODOW FROM",
    );
  });

  it("defaults to utc rather than the session zone", () => {
    for (const part of DATE_PARTS) {
      expect(Compile(part.build).sql, part.field).to.contain(
        `AT TIME ZONE ${UTC}`,
      );
    }
  });

  it("carries the fractional second, so 30.25 where getSeconds says 30", () => {
    const out = Compile((doc) => doc.key("createdAt").seconds());
    expect(out.sql).to.equal(Part("SECOND", CREATED));
    expect(out.sql).to.not.contain("floor");
    expect(out.sql).to.not.contain("trunc");
  });

  it("ends every part as double precision, since EXTRACT yields numeric", () => {
    for (const part of DATE_PARTS) {
      expect(Compile(part.build).sql, part.field).to.match(
        /\)::double precision\)$/,
      );
    }
  });
});

describe("date_with_timezone", () => {
  it("records the zone without transforming the value", () => {
    const stage = LastStage((doc) =>
      doc.key("createdAt").withTimezone(NEW_YORK_NAME),
    );
    const out = STAGES[stage.stage](
      { current: { sql: CREATED, type: TIMESTAMP } },
      stage,
      NewContext(),
    );
    expect((out.current as Compiled).sql).to.equal(CREATED);
    expect(out.timezone).to.equal(NEW_YORK);
  });

  it("leaves a row accumulator addressable, so a column keeps its index", () => {
    const stage = LastStage((doc) => doc.withTimezone(NEW_YORK_NAME));
    const source = new ColumnRowSource(AliasedColumns("t"), users);
    const out = STAGES[stage.stage]({ current: source }, stage, NewContext());
    expect(out.current).to.equal(source);
  });

  it("reaches a native column through a zone, not a materialized document", () => {
    const out = Compile((doc) =>
      doc.withTimezone(NEW_YORK_NAME).key("createdAt").day(),
    );
    expect(out.sql).to.equal(Part("DAY", CREATED));
    expect(out.sql).to.not.contain("jsonb_build_object");
  });

  it("reads the recorded zone from the following part", () => {
    const out = Compile((doc) => doc.key("createdAt").day(NEW_YORK_NAME));
    expect(out.sql).to.equal(Part("DAY", CREATED, NEW_YORK));
  });

  it("lets a second zone override the first", () => {
    const out = Compile((doc) =>
      doc.key("createdAt").withTimezone(NEW_YORK_NAME).year(PARIS_NAME),
    );
    expect(out.sql).to.equal(Part("YEAR", CREATED, PARIS));
    expect(out.sql).to.not.contain(NEW_YORK);
  });

  it("quotes the zone as a literal, so no parameter can be orphaned", () => {
    const context = NewContext();
    const out = CompileIn(context, (doc) =>
      doc.key("createdAt").hours(PARIS_NAME),
    );
    expect(out.sql).to.contain(`AT TIME ZONE ${PARIS}`);
    expect(context.params.all()).to.deep.equal([]);
    expect(out.sql).to.not.contain("$");
  });

  it("binds nothing when the zone is dropped unread", () => {
    const context = NewContext();
    const out = CompileIn(context, (doc) =>
      doc.key("createdAt").withTimezone(NEW_YORK_NAME).epoch(),
    );
    expect(context.params.all()).to.deep.equal([]);
    expect(out.sql).to.not.contain("$");
  });

  it("records no zone at all when the caller gives none", () => {
    const stages = ValueProxy.arg<any>(ROW_ID)
      .key("createdAt")
      .year()
      .build()
      .map((stage: QueryStage) => stage.stage);
    expect(stages).to.not.contain("date_with_timezone");
  });

  it("names the stage when the zone is absent", () => {
    expect(() =>
      CompileExpression(
        [
          QueryStage("arg", undefined, ROW_ID),
          QueryStage("date_with_timezone"),
        ],
        NewContext(),
      ),
    ).to.throw(/'date_with_timezone'/);
  });

  it("names the stage when the zone is empty or is not a name", () => {
    const dynamic = ValueProxy.arg<any>(ROW_ID).key("name");
    for (const zone of ["", 5, dynamic]) {
      expect(() =>
        CompileExpression(
          [
            QueryStage("arg", undefined, ROW_ID),
            QueryStage("date_with_timezone", undefined, zone),
          ],
          NewContext(),
        ),
      ).to.throw(/'date_with_timezone'/);
    }
  });

  it("is cleared by an unrelated stage between the zone and the part", () => {
    const context = NewContext();
    const out = CompileIn(context, (doc) =>
      doc
        .key("createdAt")
        .withTimezone(NEW_YORK_NAME)
        .default(new Date(0))
        .year(),
    );
    expect(out.sql).to.contain(`AT TIME ZONE ${UTC}`);
    expect(out.sql).to.not.contain(`AT TIME ZONE ${NEW_YORK}`);
    expect(context.params.all()).to.deep.equal([new Date(0)]);
    expect(out.sql).to.contain("$1");
    expect(out.sql).to.not.contain("$2");
  });
});

describe("date_tod", () => {
  it("measures seconds since the start of the local day", () => {
    const out = Compile((doc) => doc.key("createdAt").timeofday());
    expect(out.sql).to.equal(TimeOfDay(CREATED));
    expect(out.type).to.equal(FLOAT);
  });

  it("truncates the local naive timestamp, not the instant", () => {
    const out = Compile((doc) => doc.key("createdAt").timeofday());
    expect(out.sql).to.contain(`date_trunc('day', ${Local(CREATED)})`);
    expect(out.sql).to.not.contain(`date_trunc('day', ${CREATED})`);
  });

  it("truncates in the recorded zone", () => {
    const out = Compile((doc) => doc.key("createdAt").timeofday(NEW_YORK_NAME));
    expect(out.sql).to.equal(TimeOfDay(CREATED, NEW_YORK));
  });

  it("keeps the fractional second rather than flooring the elapsed time", () => {
    const out = Compile((doc) => doc.key("createdAt").timeofday());
    expect(out.sql).to.contain("EXTRACT(EPOCH FROM");
    expect(out.sql).to.not.contain("floor");
  });
});

describe("date_epoch", () => {
  it("reads the instant, in seconds, with no zone at all", () => {
    const out = Compile((doc) => doc.key("createdAt").epoch());
    expect(out.sql).to.equal(AsFloat(`EXTRACT(EPOCH FROM ${CREATED})`));
    expect(out.type).to.equal(FLOAT);
  });

  it("ignores a pending zone, since an instant does not have one", () => {
    const stage = LastStage((doc) => doc.key("createdAt").epoch());
    const out = STAGES[stage.stage](
      { current: { sql: CREATED, type: TIMESTAMP }, timezone: NEW_YORK },
      stage,
      NewContext(),
    );
    expect((out.current as Compiled).sql).to.not.contain("AT TIME ZONE");
  });
});

describe("date_during", () => {
  it("bounds low-inclusive and high-exclusive", () => {
    const out = Compile((doc) =>
      doc.key("createdAt").during(new Date(0), new Date(1)),
    );
    expect(out.sql).to.equal(
      `((${CREATED} >= ${MOMENT_PARAM}) AND (${CREATED} < ${SECOND_MOMENT_PARAM}))`,
    );
    expect(out.type).to.equal(BOOL);
  });

  it("ignores a pending zone, since both bounds are instants", () => {
    const stage = LastStage((doc) =>
      doc.key("createdAt").during(new Date(0), new Date(1)),
    );
    const out = STAGES[stage.stage](
      { current: { sql: CREATED, type: TIMESTAMP }, timezone: NEW_YORK },
      stage,
      NewContext(),
    );
    expect((out.current as Compiled).sql).to.not.contain("AT TIME ZONE");
  });

  it("reads both bounds as moments", () => {
    const out = Compile((doc) => doc.key("createdAt").during(0, 1));
    expect(out.sql).to.equal(
      `((${CREATED} >= ${FromEpoch("($1::double precision)")}) AND (${CREATED} < ${FromEpoch("($2::double precision)")}))`,
    );
  });

  it("names the stage when a bound is absent", () => {
    expect(() =>
      CompileExpression(
        [
          QueryStage("arg", undefined, ROW_ID),
          QueryStage("date_during", undefined, new Date(0)),
        ],
        NewContext(),
      ),
    ).to.throw(/'date_during'/);
  });
});

describe("reading a value as a moment", () => {
  it("leaves a declared timestamp column alone", () => {
    const column: Compiled = { sql: CREATED, type: TIMESTAMP };
    expect(Moment(column).sql).to.equal(CREATED);
  });

  it("reads a number as epoch milliseconds, which is new Date(n)", () => {
    const out = Compile((doc) => doc.key("age").epoch());
    expect(out.sql).to.equal(AsFloat(`EXTRACT(EPOCH FROM ${FromEpoch(AGE)})`));
  });

  it("nulls a number outside the range new Date(n) accepts", () => {
    const out = Compile((doc) => doc.key("age").year());
    expect(out.sql).to.contain(`BETWEEN ${EARLIEST} AND ${LATEST}`);
  });

  it("reads a boolean through the same number reading", () => {
    const out = Compile((doc) => doc.key("active").epoch());
    const number = `((${ACTIVE})::int::double precision)`;
    expect(out.sql).to.equal(
      AsFloat(`EXTRACT(EPOCH FROM ${FromEpoch(number)})`),
    );
  });

  it("parses text only where postgresql would accept it", () => {
    const out = Compile((doc) => doc.key("name").year());
    expect(out.sql).to.equal(Part("YEAR", FromText(NAME)));
  });

  it("reads an undeclared key through the guarded jsonb cast", () => {
    const out = Compile((doc) => doc.key("nope").year());
    expect(out.sql).to.equal(Part("YEAR", FromJson(EXTRA)));
  });

  it("nulls a declared array rather than raising", () => {
    const out = Compile((doc) => doc.key("tags").epoch());
    expect(out.sql).to.equal(AsFloat(`EXTRACT(EPOCH FROM ${FromJson(TAGS)})`));
  });

  it("keeps a shaped jsonb member typed, so it needs no reading at all", () => {
    const out = Compile((doc) => doc.key("metadata").key("at").epoch());
    const member = FromJson(`("t"."metadata" -> 'at')`);
    expect(out.sql).to.equal(AsFloat(`EXTRACT(EPOCH FROM ${member})`));
  });
});

describe("date operand emission", () => {
  it("emits the operand once for a part and twice for a time of day", () => {
    expect(
      Occurrences(Compile((doc) => doc.key("createdAt").year()).sql, CREATED),
    ).to.equal(1);
    expect(
      Occurrences(
        Compile((doc) => doc.key("createdAt").timeofday()).sql,
        CREATED,
      ),
    ).to.equal(2);
  });

  it("emits it twice for during, which tests both bounds", () => {
    const out = Compile((doc) =>
      doc.key("createdAt").during(new Date(0), new Date(1)),
    );
    expect(Occurrences(out.sql, CREATED)).to.equal(2);
  });
});
