import { ValueProxy } from "@antelopejs/interface-database";
import { expect } from "chai";
import { Render } from "../../implementations/database/relation";
import {
  BOOL,
  FLOAT,
  OPAQUE,
  TEXT,
  TIMESTAMP,
} from "../../implementations/database/types";
import {
  Apply,
  DOCUMENT,
  FROM_TABLE,
  Occurrences,
  Root,
  Sql,
} from "./pipeline-fixture";

const AGE_FROM_JSON =
  `(CASE WHEN jsonb_typeof(to_jsonb("t1"."value")) = 'number'` +
  ` THEN ((to_jsonb("t1"."value") #>> '{}')::double precision) END)`;

const MAPPED_AGE = `(SELECT "t0"."age" AS "value" ${FROM_TABLE})`;

describe("the key stage", () => {
  it("resolves a literal name to its own declared column", () => {
    expect(Sql(Root().key("name"))).to.equal(
      `SELECT "t0"."name" AS "value" ${FROM_TABLE}`,
    );
  });

  it("keeps the column bare rather than materializing a document", () => {
    expect(Sql(Root().key("age"))).to.not.contain("jsonb_build_object");
  });

  it("carries the field's own type into the projection", () => {
    expect(Apply(Root().key("joined")).relation.projection?.type).to.deep.equal(
      TIMESTAMP,
    );
  });

  it("binds the default as a parameter, since it is a value and not a name", () => {
    const { relation, context } = Apply(Root().key("name", "anonymous"));
    expect(Render(relation)).to.equal(
      `SELECT COALESCE("t0"."name", ($1::text)) AS "value" ${FROM_TABLE}`,
    );
    expect(context.params.all()).to.deep.equal(["anonymous"]);
  });

  it("reads an undeclared name out of the overflow column", () => {
    const undeclared = "nickname" as unknown as "name";
    expect(Sql(Root().key(undeclared))).to.equal(
      `SELECT ("t0"."_extra" -> 'nickname') AS "value" ${FROM_TABLE}`,
    );
  });

  it("falls to a dynamic lookup only for a key that is an expression", () => {
    const key = ValueProxy.constant("name") as unknown as "name";
    const { relation, context } = Apply(Root().key(key));
    expect(Render(relation)).to.equal(
      `SELECT (${DOCUMENT} -> ($1::text)) AS "value" ${FROM_TABLE}`,
    );
    expect(context.params.all()).to.deep.equal(["name"]);
  });

  it("wraps a second key, so the first is emitted once", () => {
    const { relation } = Apply(Root().key("meta").key("owner"));
    expect(relation.alias).to.equal("t1");
    expect(relation.from).to.equal(
      `(SELECT "t0"."meta" AS "value" ${FROM_TABLE})`,
    );
  });

  it("drops the origin, so a later write has nothing to target", () => {
    expect(Apply(Root().key("name")).relation.origin).to.equal(undefined);
  });
});

describe("the default stage", () => {
  it("defaults the materialized document while the relation is row-shaped", () => {
    const { relation, context } = Apply(Root().default(1));
    expect(Render(relation)).to.equal(
      `SELECT COALESCE(NULLIF(${DOCUMENT}, 'null'::jsonb),` +
        ` to_jsonb(($1::double precision))) AS "value" ${FROM_TABLE}`,
    );
    expect(context.params.all()).to.deep.equal([1]);
  });

  it("defaults the pending projection through a wrap", () => {
    expect(Sql(Root().key("age").default(0))).to.equal(
      `SELECT COALESCE("t1"."value", ($1::double precision)) AS "value"` +
        ` FROM ${MAPPED_AGE} AS "t1"`,
    );
  });

  it("unifies the default with what it defaults", () => {
    expect(
      Apply(Root().key("age").default(0)).relation.projection?.type,
    ).to.deep.equal(FLOAT);
  });

  it("reads an absent value to default to as a null one, which defaults nothing", () => {
    const projection = Apply(Root().default(undefined)).relation.projection;
    expect(projection?.sql).to.contain("'null'::jsonb");
  });
});

describe("the map stage", () => {
  it("binds the relation's own source, so a declared column is read bare", () => {
    expect(Sql(Root().map((doc) => doc.key("age")))).to.equal(
      `SELECT "t0"."age" AS "value" ${FROM_TABLE}`,
    );
  });

  it("wraps before a filter, so the projection appears exactly once", () => {
    const sql = Sql(
      Root()
        .map((doc) => doc.key("age"))
        .filter((age) => age.gt(25)),
    );
    expect(sql).to.equal(
      `SELECT "t1"."value" AS "value" FROM ${MAPPED_AGE} AS "t1"` +
        ` WHERE ((${AGE_FROM_JSON} > ($1::double precision)))`,
    );
    expect(Occurrences(sql, '"t0"."age"')).to.equal(1);
  });

  it("wraps before a second map, so neither projection is inlined into the other", () => {
    const sql = Sql(
      Root()
        .map((doc) => doc.key("age"))
        .map((age) => age.add(1)),
    );
    expect(sql).to.equal(
      `SELECT (${AGE_FROM_JSON} + ($1::double precision)) AS "value"` +
        ` FROM ${MAPPED_AGE} AS "t1"`,
    );
    expect(Occurrences(sql, '"t0"."age"')).to.equal(1);
  });

  it("keeps the text linear across a chain of three maps", () => {
    const sql = Sql(
      Root()
        .map((doc) => doc.key("age"))
        .map((age) => age.add(1))
        .map((age) => age.add(2)),
    );
    expect(Occurrences(sql, '"t0"."age"')).to.equal(1);
    expect(Occurrences(sql, "SELECT")).to.equal(3);
  });

  it("takes the body's type", () => {
    expect(
      Apply(Root().map((doc) => doc.key("name"))).relation.projection?.type,
    ).to.deep.equal(TEXT);
  });

  it("requires a body rather than projecting nothing", () => {
    expect(() => Apply(Root().map(() => undefined))).to.throw(
      "Stage 'map' requires an operand at position 0",
    );
  });
});

describe("the pluck stage", () => {
  it("builds one stripped document from the named scalar fields", () => {
    expect(Sql(Root().pluck("name", "age"))).to.equal(
      `SELECT (jsonb_strip_nulls(jsonb_build_object('name', "t0"."name",` +
        ` 'age', "t0"."age"))) AS "value" ${FROM_TABLE}`,
    );
  });

  it("references none of the fields it was not asked for", () => {
    const sql = Sql(Root().pluck("name", "age"));
    expect(sql).to.not.contain('"t0"."isActive"');
    expect(sql).to.not.contain('"t0"."_extra"');
    expect(sql).to.not.contain('"t0"."_id"');
  });

  it("routes a declared jsonb field through the container branch", () => {
    expect(Sql(Root().pluck("name", "meta"))).to.equal(
      `SELECT (jsonb_strip_nulls(jsonb_build_object('name', "t0"."name"))` +
        ` || (CASE WHEN "t0"."meta" IS NULL THEN '{}'::jsonb` +
        ` ELSE jsonb_build_object('meta', "t0"."meta") END)) AS "value" ${FROM_TABLE}`,
    );
  });

  it("keeps a plucked jsonb member out of the null stripping", () => {
    expect(Sql(Root().pluck("meta"))).to.equal(
      `SELECT (jsonb_strip_nulls(jsonb_build_object())` +
        ` || (CASE WHEN "t0"."meta" IS NULL THEN '{}'::jsonb` +
        ` ELSE jsonb_build_object('meta', "t0"."meta") END))` +
        ` AS "value" ${FROM_TABLE}`,
    );
  });

  it("routes an undeclared name through the container branch, out of the overflow", () => {
    const undeclared = "nickname" as unknown as "name";
    expect(Sql(Root().pluck(undeclared))).to.equal(
      `SELECT (jsonb_strip_nulls(jsonb_build_object())` +
        ` || (CASE WHEN ("t0"."_extra" -> 'nickname') IS NULL THEN '{}'::jsonb` +
        ` ELSE jsonb_build_object('nickname', ("t0"."_extra" -> 'nickname')) END))` +
        ` AS "value" ${FROM_TABLE}`,
    );
  });

  it("includes _id only when it was asked for", () => {
    expect(Sql(Root().pluck("_id", "name"))).to.equal(
      `SELECT (jsonb_strip_nulls(jsonb_build_object('_id', "t0"."_id",` +
        ` 'name', "t0"."name"))) AS "value" ${FROM_TABLE}`,
    );
  });

  it("never decodes the field list, so it binds no parameter", () => {
    expect(
      Apply(Root().pluck("name", "age")).context.params.all(),
    ).to.deep.equal([]);
  });

  it("types the projection as the plucked fields alone", () => {
    expect(
      Apply(Root().pluck("name", "age")).relation.projection?.type,
    ).to.deep.equal({ kind: "json", shape: { name: TEXT, age: FLOAT } });
  });

  it("rejects a field list that is not a list of names", () => {
    expect(() => Apply(Root().pluck(1 as unknown as string))).to.throw(
      "Stage 'pluck' requires a list of field names",
    );
  });
});

describe("the without stage", () => {
  it("subtracts the named keys from the materialized document", () => {
    expect(Sql(Root().without("age"))).to.equal(
      `SELECT (SELECT "t1"."kept" - array['age']::text[]` +
        ` FROM (SELECT ${DOCUMENT} AS "kept") AS "t1"` +
        ` WHERE jsonb_typeof("t1"."kept") IN ('object', 'array'))` +
        ` AS "value" ${FROM_TABLE}`,
    );
  });

  it("emits the document it subtracts from exactly once", () => {
    expect(Occurrences(Sql(Root().without("age")), '"t0"."name"')).to.equal(1);
  });

  it("guards the subtraction, since deleting from a jsonb scalar raises 22023", () => {
    expect(Sql(Root().key("name").without("age"))).to.equal(
      `SELECT (SELECT "t2"."kept" - array['age']::text[]` +
        ` FROM (SELECT to_jsonb("t1"."value") AS "kept") AS "t2"` +
        ` WHERE jsonb_typeof("t2"."kept") IN ('object', 'array'))` +
        ` AS "value" FROM (SELECT "t0"."name" AS "value" ${FROM_TABLE}) AS "t1"`,
    );
  });

  it("never decodes the field list, so it binds no parameter", () => {
    expect(
      Apply(Root().without("age", "meta")).context.params.all(),
    ).to.deep.equal([]);
  });

  it("types a row-mode result as the declared members minus the removed key", () => {
    expect(
      Apply(Root().without("age")).relation.projection?.type,
    ).to.deep.equal({
      kind: "json",
      shape: {
        _id: TEXT,
        _instance: TEXT,
        name: TEXT,
        isActive: BOOL,
        joined: TIMESTAMP,
        meta: OPAQUE,
      },
    });
  });

  it("types the projection as the shape minus the removed keys", () => {
    const type = Apply(Root().pluck("name", "age").without("age")).relation
      .projection?.type;
    expect(type).to.deep.equal({ kind: "json", shape: { name: TEXT } });
  });

  it("rejects a field list that is not a list of names", () => {
    expect(() => Apply(Root().without(2 as unknown as string))).to.throw(
      "Stage 'without' requires a list of field names",
    );
  });
});
