import { expect } from "chai";
import {
  Cast,
  Unify,
  UnifyAll,
  UnifyOperands,
  WithDefault,
} from "../../implementations/database/coerce";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";

const MOMENT_FROM_JSON =
  "(CASE WHEN jsonb_typeof(v) = 'string' AND pg_input_is_valid((v #>> '{}'), 'timestamptz')" +
  " THEN ((v #>> '{}')::timestamptz) END)";

describe("Unify", () => {
  it("pulls the bottom type toward a concrete operand", () => {
    expect(Unify(OPAQUE, TIMESTAMP)).to.equal(TIMESTAMP);
    expect(Unify(TIMESTAMP, OPAQUE)).to.equal(TIMESTAMP);
  });

  it("keeps a shaped json when unified against the bottom", () => {
    const shaped = JsonOf({ a: TEXT });
    expect(Unify(OPAQUE, shaped)).to.equal(shaped);
    expect(Unify(shaped, OPAQUE)).to.equal(shaped);
  });

  it("falls back to the bottom for distinct concrete kinds", () => {
    expect(Unify(TEXT, FLOAT)).to.equal(OPAQUE);
    expect(Unify(JsonOf({ a: TEXT }), TIMESTAMP)).to.equal(OPAQUE);
  });

  it("keeps a concrete array when unified against the bottom", () => {
    expect(Unify(ArrayOf(TEXT), OPAQUE)).to.deep.equal(ArrayOf(TEXT));
  });

  it("reduces disjoint json shapes to the bottom", () => {
    expect(Unify(JsonOf({ a: TEXT }), JsonOf({ b: FLOAT }))).to.equal(OPAQUE);
  });

  it("unifies arrays elementwise and intersects json shapes", () => {
    expect(Unify(ArrayOf(OPAQUE), ArrayOf(FLOAT))).to.deep.equal(
      ArrayOf(FLOAT),
    );
    expect(
      Unify(JsonOf({ a: TEXT, b: FLOAT }), JsonOf({ a: TEXT, c: BOOL })),
    ).to.deep.equal(JsonOf({ a: TEXT }));
  });
});

describe("UnifyAll", () => {
  it("treats the bottom type as absorbing", () => {
    expect(UnifyAll([FLOAT, TEXT, FLOAT])).to.equal(OPAQUE);
    expect(UnifyAll([TEXT, FLOAT, TIMESTAMP])).to.equal(OPAQUE);
  });

  it("absorbs the bottom type in either operand position", () => {
    expect(UnifyAll([FLOAT, OPAQUE])).to.equal(OPAQUE);
    expect(UnifyAll([OPAQUE, FLOAT])).to.equal(OPAQUE);
    expect(UnifyAll([FLOAT, OPAQUE, FLOAT])).to.equal(OPAQUE);
  });

  it("keeps a uniform element type", () => {
    expect(UnifyAll([FLOAT, FLOAT, FLOAT])).to.equal(FLOAT);
  });

  it("returns the bottom type for an empty collection", () => {
    expect(UnifyAll([])).to.equal(OPAQUE);
  });
});

describe("UnifyOperands", () => {
  it("casts both sides to the unified type", () => {
    const pair = UnifyOperands(
      { sql: "v", type: OPAQUE },
      { sql: "$1", type: TIMESTAMP },
    );
    expect(pair.type).to.equal(TIMESTAMP);
    expect(pair.left.sql).to.equal(MOMENT_FROM_JSON);
    expect(pair.right.sql).to.equal("$1");
  });
});

describe("Cast", () => {
  it("extracts a scalar out of jsonb", () => {
    const out = Cast({ sql: "v", type: OPAQUE }, TIMESTAMP);
    expect(out.sql).to.equal(MOMENT_FROM_JSON);
    expect(out.type).to.equal(TIMESTAMP);
  });

  it("yields null rather than failing when a jsonb value is the wrong type", () => {
    const out = Cast({ sql: "v", type: OPAQUE }, FLOAT);
    expect(out.sql).to.equal(
      "(CASE WHEN jsonb_typeof(v) = 'number' THEN ((v #>> '{}')::double precision) END)",
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("guards a timestamp projection on the parse, not only on the json type", () => {
    expect(Cast({ sql: "v", type: OPAQUE }, TIMESTAMP).sql).to.contain(
      "pg_input_is_valid((v #>> '{}'), 'timestamptz')",
    );
  });

  it("guards a boolean projection on the json boolean type", () => {
    expect(Cast({ sql: "v", type: OPAQUE }, BOOL).sql).to.equal(
      "(CASE WHEN jsonb_typeof(v) = 'boolean' THEN ((v #>> '{}')::boolean) END)",
    );
  });

  it("guards the text projection so a stored number is not read as its text form", () => {
    expect(Cast({ sql: "v", type: OPAQUE }, TEXT).sql).to.equal(
      "(CASE WHEN jsonb_typeof(v) = 'string' THEN (v #>> '{}') END)",
    );
  });

  it("wraps a scalar into jsonb", () => {
    expect(Cast({ sql: "t.price", type: FLOAT }, OPAQUE).sql).to.equal(
      "to_jsonb(t.price)",
    );
  });

  it("does not claim a shape when wrapping a scalar", () => {
    expect(Cast({ sql: "t.name", type: TEXT }, ArrayOf(TEXT)).type).to.equal(
      OPAQUE,
    );
    expect(
      Cast({ sql: "t.name", type: TEXT }, JsonOf({ a: TEXT })).type,
    ).to.equal(OPAQUE);
  });

  it("retypes between jsonb-backed kinds without touching the sql", () => {
    const out = Cast({ sql: "v", type: OPAQUE }, ArrayOf(TEXT));
    expect(out.sql).to.equal("v");
    expect(out.type).to.deep.equal(ArrayOf(TEXT));
  });

  it("fully parenthesises a scalar-to-scalar cast", () => {
    expect(Cast({ sql: "t.name", type: TEXT }, FLOAT).sql).to.equal(
      "((t.name)::double precision)",
    );
  });

  it("is a no-op for a matching kind", () => {
    const value = { sql: "t.name", type: TEXT };
    expect(Cast(value, TEXT).sql).to.equal("t.name");
  });
});

describe("WithDefault", () => {
  it("coalesces both sides at the unified type", () => {
    const out = WithDefault(
      { sql: "v", type: OPAQUE },
      { sql: "$1", type: TEXT },
    );
    expect(out.sql).to.equal(
      "COALESCE((CASE WHEN jsonb_typeof(v) = 'string' THEN (v #>> '{}') END), $1)",
    );
    expect(out.type).to.equal(TEXT);
  });

  it("falls back to the default when the guard rejects the stored type", () => {
    const out = WithDefault(
      { sql: "v", type: OPAQUE },
      { sql: "$1", type: FLOAT },
    );
    expect(out.sql).to.equal(
      "COALESCE((CASE WHEN jsonb_typeof(v) = 'number' THEN ((v #>> '{}')::double precision) END), $1)",
    );
    expect(out.type).to.equal(FLOAT);
  });

  it("returns the value untouched when no default is given", () => {
    expect(WithDefault({ sql: "v", type: OPAQUE }).sql).to.equal("v");
  });
});
