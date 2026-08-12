import { expect } from "chai";
import {
  Cast,
  Unify,
  UnifyAll,
  UnifyOperands,
  Widen,
  WithDefault,
} from "../../implementations/database/coerce";
import {
  ArrayOf,
  BOOL,
  FLOAT,
  JsonOf,
  type JsonType,
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

describe("Widen", () => {
  it("keeps a key only one side declares", () => {
    expect(
      Widen(
        JsonOf({ name: TEXT, createdAt: TIMESTAMP }),
        JsonOf({ name: TEXT }),
      ),
    ).to.deep.equal(JsonOf({ name: TEXT, createdAt: TIMESTAMP }));
  });

  it("takes the union where Unify takes the intersection", () => {
    const left = JsonOf({ a: TEXT });
    const right = JsonOf({ b: FLOAT });
    expect(Unify(left, right)).to.equal(OPAQUE);
    expect(Widen(left, right)).to.deep.equal(JsonOf({ a: TEXT, b: FLOAT }));
  });

  it("unifies a colliding key", () => {
    expect(Widen(JsonOf({ a: TEXT }), JsonOf({ a: FLOAT }))).to.deep.equal(
      JsonOf({ a: OPAQUE }),
    );
    expect(Widen(JsonOf({ a: OPAQUE }), JsonOf({ a: FLOAT }))).to.deep.equal(
      JsonOf({ a: FLOAT }),
    );
  });

  it("keeps a concrete kind that both sides agree on", () => {
    expect(Widen(TIMESTAMP, TIMESTAMP)).to.equal(TIMESTAMP);
    expect(Widen(TEXT, TEXT)).to.equal(TEXT);
    expect(Widen(ArrayOf(TEXT), ArrayOf(TEXT))).to.deep.equal(ArrayOf(TEXT));
  });

  it("falls back to the bottom type for distinct concrete kinds", () => {
    expect(Widen(TEXT, FLOAT)).to.equal(OPAQUE);
    expect(Widen(TEXT, JsonOf({ a: TEXT }))).to.equal(OPAQUE);
  });

  it("takes the shaped side when the other is unshaped", () => {
    const shaped = JsonOf({ a: TEXT });
    expect(Widen(OPAQUE, shaped)).to.equal(shaped);
    expect(Widen(shaped, OPAQUE)).to.equal(shaped);
  });

  it("does not treat a key inherited from Object.prototype as a collision", () => {
    const widened = Widen(JsonOf({ a: TEXT }), JsonOf({ toString: FLOAT }));
    expect(widened.kind).to.equal("json");
    expect((widened as JsonType).shape?.toString).to.equal(FLOAT);
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
  it("lifts the default to jsonb rather than narrowing a jsonb-backed value", () => {
    const out = WithDefault(
      { sql: "v", type: OPAQUE },
      { sql: "$1", type: TEXT },
    );
    expect(out.sql).to.equal(
      "COALESCE(NULLIF(v, 'null'::jsonb), to_jsonb($1))",
    );
    expect(out.type).to.equal(OPAQUE);
  });

  it("puts no type guard on the value, since a default answers absence and not a type", () => {
    for (const type of [TEXT, FLOAT]) {
      const out = WithDefault({ sql: "v", type: OPAQUE }, { sql: "$1", type });
      expect(out.sql).to.not.contain("jsonb_typeof");
    }
  });

  it("keeps a declared scalar's own reading, which carries no such guard", () => {
    const out = WithDefault(
      { sql: "v", type: FLOAT },
      { sql: "$1", type: FLOAT },
    );
    expect(out.sql).to.equal("COALESCE(v, $1)");
    expect(out.type).to.equal(FLOAT);
  });

  it("fires on a stored json null when the unified type is jsonb-backed", () => {
    const out = WithDefault(
      { sql: "v", type: OPAQUE },
      { sql: "jsonb_build_object()", type: OPAQUE },
    );
    expect(out.sql).to.equal(
      "COALESCE(NULLIF(v, 'null'::jsonb), jsonb_build_object())",
    );
    expect(out.type).to.equal(OPAQUE);
  });

  it("fires on a stored json null under an array-typed default too", () => {
    const out = WithDefault(
      { sql: "v", type: OPAQUE },
      { sql: "jsonb_build_array()", type: ArrayOf(TEXT) },
    );
    expect(out.sql).to.equal(
      "COALESCE(NULLIF(v, 'null'::jsonb), jsonb_build_array())",
    );
  });

  it("returns the value untouched when no default is given", () => {
    expect(WithDefault({ sql: "v", type: OPAQUE }).sql).to.equal("v");
  });
});
