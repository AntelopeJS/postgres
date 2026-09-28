import { expect } from "chai";

import { Occurrences, RefusingCompilers } from "./spec-fixture";
import type { TableShape } from "../../implementations/database/fields";
import { DecodingContext } from "../../implementations/database/context";
import {
  FLOAT,
  JsonOf,
  OPAQUE,
  TEXT,
} from "../../implementations/database/types";
import {
  AbsorbOrder,
  CurrentValue,
  type JoinClause,
  Nested,
  Prepare,
  type Relation,
  Render,
  ScanColumns,
  SetProjection,
  type TableOrigin,
  TableRelation,
  ValueRelation,
} from "../../implementations/database/relation";

const VEHICLES: TableShape = {
  fields: {
    car: { column: "car", type: TEXT },
    price: { column: "price", type: FLOAT },
  },
};

const TABLE = '"shop"."vehicles"';
const ROOT_ALIAS = "t0";
const LIMIT_TWO = "((2)::bigint)";
const OFFSET_ONE = "((1)::bigint)";

const EVERY_CLAUSE =
  'SELECT "t0"."_id", "t0"."_instance", "t0"."car", "t0"."price",' +
  ' "t0"."_extra" FROM "shop"."vehicles" AS "t0"' +
  ' WHERE ("t0"."price" > $1) ORDER BY "t0"."car" ASC' +
  " LIMIT ((2)::bigint) OFFSET ((1)::bigint)";

const OWNERS_JOIN: JoinClause = {
  kind: "JOIN",
  from: '"shop"."owners"',
  alias: "t1",
  on: '("t1"."_id" = "t0"."owner")',
};

const LATERAL_JOIN: JoinClause = {
  kind: "LEFT JOIN LATERAL",
  from: '(SELECT "t0"."car" AS "value")',
  alias: "t2",
  on: "true",
};

function NewOrigin(): TableOrigin {
  return {
    schemaId: "shop",
    tableId: "vehicles",
    shape: VEHICLES,
    index: (name) => [name],
  };
}

function NewContext(): DecodingContext {
  return new DecodingContext(RefusingCompilers());
}

function NewTable(): Relation {
  return TableRelation(TABLE, ROOT_ALIAS, NewOrigin());
}

function NestedContext(): DecodingContext {
  const context = NewContext();
  context.nextAlias();
  return context;
}

function ClauseCompleteTable(): Relation {
  const relation = NewTable();
  relation.where.push('("t0"."price" > $1)');
  relation.orderBy.push({ sql: '"t0"."car"', descending: false });
  relation.limit = LIMIT_TWO;
  relation.offset = OFFSET_ONE;
  return relation;
}

describe("Render", () => {
  it("selects the physical columns of a bare table relation", () => {
    expect(Render(NewTable())).to.equal(
      'SELECT "t0"."_id", "t0"."_instance", "t0"."car", "t0"."price",' +
        ' "t0"."_extra" FROM "shop"."vehicles" AS "t0"',
    );
  });

  it("joins absorbed predicates with AND", () => {
    const relation = NewTable();
    relation.where.push('("t0"."price" > $1)', '("t0"."car" = $2)');
    expect(Render(relation)).to.contain(
      'AS "t0" WHERE ("t0"."price" > $1) AND ("t0"."car" = $2)',
    );
  });

  it("spells both sort directions and keeps the term order", () => {
    const relation = NewTable();
    relation.orderBy.push(
      { sql: '"t0"."price"', descending: true },
      { sql: '"t0"."car"', descending: false },
    );
    expect(Render(relation)).to.contain(
      'ORDER BY "t0"."price" DESC, "t0"."car" ASC',
    );
  });

  it("emits limit and offset in that order", () => {
    const relation = NewTable();
    relation.limit = LIMIT_TWO;
    relation.offset = OFFSET_ONE;
    expect(Render(relation)).to.contain(
      'AS "t0" LIMIT ((2)::bigint) OFFSET ((1)::bigint)',
    );
  });

  it("emits DISTINCT before the select list", () => {
    const relation = NewTable();
    relation.distinct = true;
    expect(Render(relation)).to.contain('SELECT DISTINCT "t0"."_id"');
  });

  it("refuses to render a row-mode relation that has lost its origin", () => {
    const relation = NewTable();
    relation.origin = undefined;
    expect(() => Render(relation)).to.throw(
      "A row-mode relation must carry the origin of its table",
    );
  });

  it("renders every clause unchanged while the join list is empty", () => {
    const relation = ClauseCompleteTable();
    expect(relation.joins).to.deep.equal([]);
    expect(Render(relation)).to.equal(EVERY_CLAUSE);
  });

  it("emits the join clauses in array order", () => {
    const relation = NewTable();
    relation.joins.push(OWNERS_JOIN, LATERAL_JOIN);
    expect(Render(relation)).to.contain(
      'JOIN "shop"."owners" AS "t1" ON ("t1"."_id" = "t0"."owner")' +
        ' LEFT JOIN LATERAL (SELECT "t0"."car" AS "value") AS "t2" ON true',
    );
  });

  it("emits a join between the FROM and the WHERE", () => {
    const relation = NewTable();
    relation.where.push('("t0"."price" > $1)');
    relation.joins.push(OWNERS_JOIN);
    expect(Render(relation)).to.contain(
      'FROM "shop"."vehicles" AS "t0" JOIN "shop"."owners" AS "t1"' +
        ' ON ("t1"."_id" = "t0"."owner") WHERE ("t0"."price" > $1)',
    );
  });

  it("emits no group clause while the term list is empty", () => {
    const relation = ClauseCompleteTable();
    expect(relation.groupBy).to.deep.equal([]);
    expect(Render(relation)).to.not.contain("GROUP BY");
  });

  it("emits the group terms in order, between the WHERE and the ORDER BY", () => {
    const relation = ClauseCompleteTable();
    relation.groupBy.push(
      { sql: '"t0"."car"', type: TEXT },
      { sql: '"t0"."price"', type: FLOAT },
    );
    expect(Render(relation)).to.contain(
      'WHERE ("t0"."price" > $1) GROUP BY "t0"."car", "t0"."price"' +
        ' ORDER BY "t0"."car" ASC',
    );
  });

  it("selects a single named column in value mode", () => {
    const relation = NewTable();
    SetProjection(relation, { sql: '("t0"."price" * 2)', type: FLOAT });
    expect(Render(relation)).to.equal(
      'SELECT ("t0"."price" * 2) AS "value" FROM "shop"."vehicles" AS "t0"',
    );
  });
});

describe("TableRelation", () => {
  it("addresses the table's own columns", () => {
    const relation = NewTable();
    expect(relation.source.field("price").sql).to.equal('"t0"."price"');
    expect(relation.source.field("price").type).to.equal(FLOAT);
  });

  it("starts in row mode with the origin intact", () => {
    const relation = NewTable();
    expect(relation.projection).to.equal(undefined);
    expect(relation.origin?.tableId).to.equal("vehicles");
    expect(relation.single).to.equal(false);
    expect(relation.aggregated).to.equal(false);
  });
});

describe("the relation Prepare wraps", () => {
  it("renders the inner relation exactly once, parenthesised", () => {
    const relation = NewTable();
    relation.limit = LIMIT_TWO;
    const wrapped = Prepare(relation, ["limit"], NewContext());
    expect(
      Occurrences(wrapped.from, 'FROM "shop"."vehicles" AS "t0"'),
    ).to.equal(1);
    expect(Occurrences(wrapped.from, "SELECT ")).to.equal(1);
    expect(wrapped.from.startsWith("(")).to.equal(true);
    expect(wrapped.from.endsWith(")")).to.equal(true);
  });

  it("nests the inner select verbatim, clauses and all", () => {
    const context = NestedContext();
    expect(Render(Prepare(ClauseCompleteTable(), ["limit"], context))).to.equal(
      'SELECT "t1"."_id", "t1"."_instance", "t1"."car", "t1"."price",' +
        ` "t1"."_extra" FROM (${EVERY_CLAUSE}) AS "t1"`,
    );
  });

  it("takes a fresh alias from the context", () => {
    const context = NewContext();
    expect(context.nextAlias()).to.equal("t0");
    const relation = NewTable();
    relation.limit = LIMIT_TWO;
    expect(Prepare(relation, ["limit"], context).alias).to.equal("t1");
  });

  it("keeps a row-mode wrap addressing bare columns", () => {
    const context = NestedContext();
    const relation = NewTable();
    relation.limit = LIMIT_TWO;
    const wrapped = Prepare(relation, ["limit"], context);
    expect(wrapped.source.field("price").sql).to.equal('"t1"."price"');
    expect(wrapped.origin?.tableId).to.equal("vehicles");
    expect(Render(wrapped)).to.not.contain("jsonb_build_object");
  });

  it("carries the projection's type through a value-mode wrap", () => {
    const context = NestedContext();
    const relation = NewTable();
    SetProjection(relation, {
      sql: '("t0"."price" * 2)',
      type: JsonOf({ price: FLOAT }),
    });
    const wrapped = Prepare(relation, ["projection"], context);
    expect(wrapped.projection?.sql).to.equal('"t1"."value"');
    expect(wrapped.projection?.type).to.deep.equal(JsonOf({ price: FLOAT }));
    expect(wrapped.origin).to.equal(undefined);
    expect(wrapped.source.field("price").type).to.equal(FLOAT);
  });

  it("resets the clauses the rendered text already carries", () => {
    const relation = NewTable();
    relation.where.push("(true)");
    relation.orderBy.push({ sql: '"t0"."car"', descending: false });
    relation.limit = LIMIT_TWO;
    relation.offset = OFFSET_ONE;
    relation.distinct = true;
    const wrapped = Prepare(relation, ["limit"], NewContext());
    expect(wrapped.where).to.deep.equal([]);
    expect(wrapped.orderBy).to.deep.equal([]);
    expect(wrapped.limit).to.equal(undefined);
    expect(wrapped.offset).to.equal(undefined);
    expect(wrapped.distinct).to.equal(false);
  });

  it("carries single through and drops aggregated", () => {
    const relation = NewTable();
    relation.single = true;
    relation.aggregated = true;
    const wrapped = Prepare(relation, ["aggregated"], NewContext());
    expect(wrapped.single).to.equal(true);
    expect(wrapped.aggregated).to.equal(false);
  });

  it("keeps _instance selectable two levels deep", () => {
    const context = NestedContext();
    const relation = NewTable();
    relation.limit = LIMIT_TWO;
    const once = Prepare(relation, ["limit"], context);
    once.limit = LIMIT_TWO;
    const sql = Render(Prepare(once, ["limit"], context));
    expect(sql).to.contain('"t2"."_instance"');
    expect(sql).to.contain('"t1"."_instance"');
    expect(sql).to.contain('"t0"."_instance"');
  });
});

describe("Prepare", () => {
  it("leaves an unblocked relation untouched", () => {
    const relation = NewTable();
    expect(Prepare(relation, ["limit", "distinct"], NewContext())).to.equal(
      relation,
    );
  });

  it("wraps once any blocking flag holds", () => {
    const relation = NewTable();
    relation.offset = OFFSET_ONE;
    expect(Prepare(relation, ["offset"], NewContext())).to.not.equal(relation);
  });

  it("ignores a flag the stage does not declare", () => {
    const relation = NewTable();
    relation.orderBy.push({ sql: '"t0"."car"', descending: false });
    expect(Prepare(relation, ["limit"], NewContext())).to.equal(relation);
    expect(Prepare(relation, ["ordered"], NewContext())).to.not.equal(relation);
  });

  it("recognises a pending projection as blocking", () => {
    const relation = NewTable();
    SetProjection(relation, { sql: '"t0"."car"', type: TEXT });
    expect(Prepare(relation, ["projection"], NewContext())).to.not.equal(
      relation,
    );
  });

  it("recognises an aggregate as blocking", () => {
    const relation = NewTable();
    relation.aggregated = true;
    expect(Prepare(relation, ["aggregated"], NewContext())).to.not.equal(
      relation,
    );
  });
});

describe("Nested", () => {
  it("wraps a relation no flag blocks, re-addressing the physical columns", () => {
    const context = NestedContext();
    const relation = NewTable();
    relation.joins.push(OWNERS_JOIN);
    const nested = Nested(relation, context);
    expect(nested).to.not.equal(relation);
    expect(nested.alias).to.equal("t1");
    expect(nested.source.field("car").sql).to.equal('"t1"."car"');
    expect(nested.source.field("price").sql).to.equal('"t1"."price"');
    expect(nested.origin?.tableId).to.equal("vehicles");
    expect(nested.joins).to.deep.equal([]);
  });

  it("drops the group terms the rendered text already carries", () => {
    const relation = NewTable();
    relation.groupBy.push({ sql: '"t0"."car"', type: TEXT });
    const nested = Nested(relation, NewContext());
    expect(nested.from).to.contain('GROUP BY "t0"."car"');
    expect(nested.groupBy).to.deep.equal([]);
  });

  it("carries single and absent and drops aggregated", () => {
    const relation = NewTable();
    relation.single = true;
    relation.absent = undefined;
    relation.aggregated = true;
    const nested = Nested(relation, NewContext());
    expect(nested.single).to.equal(true);
    expect(nested.absent).to.equal(undefined);
    expect(nested.aggregated).to.equal(false);
  });
});

describe("AbsorbOrder", () => {
  it("hands back the terms it clears, spelled as the clause spells them", () => {
    const relation = ClauseCompleteTable();
    relation.orderBy.push({ sql: '"t0"."price"', descending: true });
    expect(AbsorbOrder(relation)).to.equal('"t0"."car" ASC, "t0"."price" DESC');
    expect(relation.orderBy).to.deep.equal([]);
  });

  it("hands back nothing for a relation that carries no ordering", () => {
    expect(AbsorbOrder(NewTable())).to.equal(undefined);
  });

  it("refuses a term carrying a parameter, which absorbing would unbind", () => {
    const relation = NewTable();
    relation.orderBy.push({ sql: '("t0"."car" = $1)', descending: false });
    expect(() => AbsorbOrder(relation)).to.throw(/order term/);
  });
});

describe("SetProjection", () => {
  it("swaps the source for a view over the projection and drops the origin", () => {
    const relation = NewTable();
    SetProjection(relation, { sql: "v", type: JsonOf({ car: TEXT }) });
    expect(relation.projection?.sql).to.equal("v");
    expect(relation.origin).to.equal(undefined);
    expect(relation.source.field("car").sql).to.equal(
      "(CASE WHEN jsonb_typeof((v -> 'car')) = 'string' THEN ((v -> 'car') #>> '{}') END)",
    );
  });

  it("does not wrap on its own", () => {
    const relation = NewTable();
    expect(SetProjection(relation, { sql: "v", type: OPAQUE })).to.equal(
      relation,
    );
  });
});

describe("CurrentValue", () => {
  it("materializes the row in row mode", () => {
    expect(CurrentValue(NewTable()).sql).to.contain("jsonb_build_object");
  });

  it("returns the projection in value mode", () => {
    const relation = NewTable();
    const projection = { sql: '("t0"."price" * 2)', type: FLOAT };
    SetProjection(relation, projection);
    expect(CurrentValue(relation)).to.equal(projection);
  });
});

describe("ValueRelation", () => {
  it("projects the named output column at the declared type", () => {
    const relation = ValueRelation("((a) UNION ALL (b))", "t3", TEXT);
    expect(relation.projection?.sql).to.equal('"t3"."value"');
    expect(relation.projection?.type).to.equal(TEXT);
    expect(relation.origin).to.equal(undefined);
    expect(Render(relation)).to.equal(
      'SELECT "t3"."value" AS "value" FROM ((a) UNION ALL (b)) AS "t3"',
    );
  });
});

describe("ScanColumns", () => {
  function Scanning(crossInstance: boolean): string[] {
    const scanned: string[] = [];
    const relation = TableRelation(TABLE, ROOT_ALIAS, {
      ...NewOrigin(),
      crossInstanceScan: (name) => scanned.push(name),
    });
    relation.crossInstance = crossInstance;
    ScanColumns(relation, "price");
    return scanned;
  }

  it("tells the origin about an index a cross-instance read scans", () => {
    expect(Scanning(true)).to.deep.equal(["price"]);
  });

  it("stays silent for a read scoped to one instance", () => {
    expect(Scanning(false)).to.deep.equal([]);
  });

  it("expands the index exactly as IndexColumns does", () => {
    const columns = ScanColumns(NewTable(), "price");
    expect(columns.map((column) => column.sql)).to.deep.equal(['"t0"."price"']);
  });
});
