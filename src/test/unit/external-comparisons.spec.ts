import { expect } from "chai";
import { SchemaInstance } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";

import { Render } from "../../implementations/database/relation";
import { BuildRoot } from "../../implementations/database/selection";
import { DecodingContext } from "../../implementations/database/context";
import { CompileSubquery } from "../../implementations/database/subquery";
import { CompileExpression } from "../../implementations/database/expression";
import {
  ParseFieldType,
  type SchemaModel,
} from "../../implementations/database/fields";
import type { CatalogColumn } from "../../implementations/database/external-catalog";
import {
  type ColumnDescriptor,
  Describe,
  DescribeKey,
} from "../../implementations/database/external-types";
import {
  ApplyStages,
  CompileRelation,
} from "../../implementations/database/pipeline";

interface NativeColumn {
  name: string;
  typname: string;
  castType?: string;
  typtype?: string;
}

interface Declared {
  column: NativeColumn;
  declared: string;
}

function Catalog(column: NativeColumn): CatalogColumn {
  return {
    name: column.name,
    native: column.castType ?? column.typname,
    typname: column.typname,
    castType: column.castType ?? column.typname,
    typtype: column.typtype ?? "b",
    category: "S",
    element: null,
    notNull: true,
    hasDefault: false,
    generated: false,
    identity: "",
    comment: null,
    enumLabels: null,
  };
}

function Field({ column, declared }: Declared) {
  const type = ParseFieldType(declared, column.name).type;
  return {
    column: column.name,
    type,
    native: Describe(column.name, type, Catalog(column), column.name),
  };
}

function Key(columns: NativeColumn[]): ColumnDescriptor[] {
  return columns.flatMap((column) => DescribeKey(Catalog(column)) ?? []);
}

const ID: NativeColumn = { name: "id", typname: "int8", castType: "bigint" };
const SCORE: NativeColumn = {
  name: "score",
  typname: "int4",
  castType: "integer",
};
const REVENUE: NativeColumn = { name: "revenue", typname: "numeric" };
const ACCOUNT_ID: NativeColumn = {
  name: "account_id",
  typname: "int8",
  castType: "bigint",
};
const CONTACT_ID: NativeColumn = { name: "contact_id", typname: "uuid" };
const ORDER_ID: NativeColumn = {
  name: "order_id",
  typname: "int4",
  castType: "integer",
};
const LINE_NO: NativeColumn = {
  name: "line_no",
  typname: "int4",
  castType: "integer",
};

const MODELS: SchemaModel = {
  accounts: {
    fields: {
      id: Field({ column: ID, declared: "string" }),
      score: Field({ column: SCORE, declared: "number" }),
      revenue: Field({ column: REVENUE, declared: "number" }),
    },
    external: { schema: "sales", table: "accounts", key: Key([ID]) },
  },
  contacts: {
    fields: { account_id: Field({ column: ACCOUNT_ID, declared: "string" }) },
    external: { schema: "sales", table: "contacts", key: Key([CONTACT_ID]) },
  },
  order_lines: {
    fields: {},
    external: {
      schema: "sales",
      table: "order_lines",
      key: Key([ORDER_ID, LINE_NO]),
    },
  },
};

interface Tables {
  accounts: { _id: string; score: number; revenue: number };
  contacts: { account_id: string };
  order_lines: { line_no: number };
}

function Table<K extends keyof Tables>(tableId: K) {
  const schema = new SchemaInstance<Tables>(
    QueryStage("schema", { id: "sales" }),
  );
  const instance = new SchemaInstance<Tables>(
    QueryStage("instance", { id: undefined }),
    schema,
  );
  return instance.table(tableId);
}

function Sql(query: StagedObject): string {
  const context = new DecodingContext(
    {
      expression: CompileExpression,
      subquery: CompileSubquery,
      relation: CompileRelation,
    },
    (schemaId, tableId) => ({
      schemaId,
      tableId,
      model: MODELS[tableId],
      index: (name) => [name],
    }),
  );
  const root = BuildRoot(query.build(), context);
  return Render(ApplyStages(root.relation, root.rest, context));
}

const ROUNDING: [string, "gt" | "ge" | "lt" | "le", string][] = [
  [">", "gt", "floor"],
  [">=", "ge", "ceil"],
  ["<", "lt", "ceil"],
  ["<=", "le", "floor"],
];

describe("comparisons against an external relation's own column types", () => {
  it("compares a uuid key bare, against a guarded cast whose cast sits outside the CASE", () => {
    expect(Sql(Table("contacts").get("k"))).to.contain(
      `("t0"."contact_id" = ((CASE WHEN pg_input_is_valid(($1::text), 'uuid') THEN ($1::text) END)::uuid))`,
    );
  });

  it("compares a bigint key bare, against a guarded bigint", () => {
    expect(Sql(Table("accounts").getAll(["1", "2"]))).to.contain(
      `"t0"."id" IN (((CASE WHEN pg_input_is_valid(($1::text), 'bigint') THEN ($1::text) END)::bigint)`,
    );
  });

  for (const [operator, method, rounding] of ROUNDING) {
    it(`rounds a number with ${rounding} for '${operator}' on an integer column, keeping the column bare`, () => {
      const sql = Sql(
        Table("accounts").filter((row) => row.key("score")[method](5.5)),
      );
      expect(sql).to.contain(
        `("t0"."score" ${operator} ((LEAST(GREATEST(${rounding}(`,
      );
    });
  }

  it("matches only a whole number for equality on an integer column", () => {
    const sql = Sql(Table("accounts").filter((row) => row.key("score").eq(5)));
    expect(sql).to.contain(
      `("t0"."score" = (CASE WHEN ($1::double precision) = trunc(`,
    );
  });

  it("compares a numeric column against the number read as numeric", () => {
    const sql = Sql(
      Table("accounts").filter((row) => row.key("revenue").ge(10)),
    );
    expect(sql).to.contain(
      `("t0"."revenue" >= (($1::double precision))::numeric)`,
    );
  });

  it("correlates a lookup between two bigint columns bare", () => {
    const sql = Sql(
      Table("contacts").lookup(Table("accounts"), "account_id", "_id"),
    );
    expect(sql).to.match(/\("t\d+"\."id" = "t0"\."account_id"\)/);
  });

  it("matches a composite _id as the row of its key columns", () => {
    expect(Sql(Table("order_lines").get("k"))).to.contain(
      `(ROW("t0"."order_id", "t0"."line_no") = ROW(`,
    );
  });

  it("sorts by a composite _id through its key columns, in key order", () => {
    expect(Sql(Table("order_lines").orderBy("_id"))).to.contain(
      `ORDER BY "t0"."order_id" ASC, "t0"."line_no" ASC`,
    );
  });

  it("sums a numeric column itself and converts the total once", () => {
    expect(Sql(Table("accounts").sum("revenue"))).to.contain(
      `sum("t0"."revenue")`,
    );
  });
});
