import { expect } from "chai";

import { ParseFieldType } from "../../implementations/database/fields";
import type { CatalogColumn } from "../../implementations/database/external-catalog";
import { AcceptedDeclarations } from "../../implementations/database/external-declarations";
import {
  Describe,
  DescribeKey,
} from "../../implementations/database/external-types";

const COLUMN = '"t"."c"';

interface NativeType {
  typname: string;
  native?: string;
  typtype?: string;
  category?: string;
  element?: string;
}

interface Accepted {
  declared: string | string[];
  type: NativeType;
  value: string;
  lossy?: RegExp;
}

interface Refused {
  declared: string | string[];
  type: NativeType;
  hint: RegExp;
}

function Column(type: NativeType): CatalogColumn {
  return {
    name: "c",
    native: type.native ?? type.typname,
    typname: type.typname,
    castType: type.native ?? type.typname,
    typtype: type.typtype ?? "b",
    category: type.category ?? "S",
    element: type.element ?? null,
    notNull: false,
    hasDefault: false,
    generated: false,
    identity: "",
    comment: null,
    enumLabels: null,
  };
}

function DescribeDeclared(declared: string | string[], type: NativeType) {
  const kind = ParseFieldType(declared, "sales.t.c").type;
  return Describe("c", kind, Column(type), "sales.t.c");
}

const ARRAY = { category: "A" };

const ACCEPTED: Accepted[] = [
  { declared: "string", type: { typname: "text" }, value: COLUMN },
  {
    declared: "string",
    type: { typname: "varchar", native: "character varying(200)" },
    value: COLUMN,
  },
  { declared: "string", type: { typname: "citext" }, value: COLUMN },
  {
    declared: "string",
    type: { typname: "bpchar", native: "character(2)" },
    value: `(${COLUMN})::text`,
  },
  { declared: "string", type: { typname: "uuid" }, value: `(${COLUMN})::text` },
  {
    declared: "string",
    type: { typname: "status", typtype: "e" },
    value: `(${COLUMN})::text`,
  },
  { declared: "string", type: { typname: "int8" }, value: `(${COLUMN})::text` },
  {
    declared: "string",
    type: { typname: "numeric" },
    value: `(${COLUMN})::text`,
  },
  { declared: "string", type: { typname: "inet" }, value: `(${COLUMN})::text` },
  {
    declared: "number",
    type: { typname: "int4" },
    value: `(${COLUMN})::double precision`,
  },
  { declared: "number", type: { typname: "float8" }, value: COLUMN },
  {
    declared: "number",
    type: { typname: "int8" },
    value: `(${COLUMN})::double precision`,
    lossy: /2\^53/,
  },
  {
    declared: "number",
    type: { typname: "numeric" },
    value: `(${COLUMN})::double precision`,
    lossy: /precision/,
  },
  {
    declared: "number",
    type: { typname: "float4" },
    value: `(${COLUMN})::double precision`,
    lossy: /real/,
  },
  { declared: "boolean", type: { typname: "bool" }, value: COLUMN },
  {
    declared: "date",
    type: { typname: "timestamptz" },
    value: COLUMN,
    lossy: /microseconds/,
  },
  {
    declared: "date",
    type: { typname: "timestamp" },
    value: `(${COLUMN} AT TIME ZONE 'UTC')`,
    lossy: /read as UTC/,
  },
  {
    declared: "date",
    type: { typname: "date" },
    value: `((${COLUMN})::timestamp AT TIME ZONE 'UTC')`,
  },
  { declared: "object", type: { typname: "jsonb" }, value: COLUMN },
  {
    declared: "any",
    type: { typname: "json" },
    value: `(${COLUMN})::jsonb`,
    lossy: /duplicate keys/,
  },
  {
    declared: "string[]",
    type: { typname: "_text", element: "text", ...ARRAY },
    value: `to_jsonb(${COLUMN})`,
  },
  {
    declared: "number[]",
    type: { typname: "_int4", element: "int4", ...ARRAY },
    value: `to_jsonb(${COLUMN})`,
  },
  {
    declared: "number[]",
    type: { typname: "_int8", element: "int8", ...ARRAY },
    value: `to_jsonb(${COLUMN})`,
    lossy: /2\^53/,
  },
];

const REFUSED: Refused[] = [
  {
    declared: "number",
    type: { typname: "uuid" },
    hint: /declare it as string/,
  },
  {
    declared: "boolean",
    type: { typname: "int4" },
    hint: /declare it as string or number/,
  },
  { declared: "date", type: { typname: "text" }, hint: /declare it as string/ },
  {
    declared: "string",
    type: { typname: "float8" },
    hint: /declare it as number/,
  },
  {
    declared: "string",
    type: { typname: "bytea" },
    hint: /no field type reads it/,
  },
  {
    declared: "string",
    type: { typname: "jsonb" },
    hint: /declare it as object/,
  },
  {
    declared: "date[]",
    type: { typname: "_timestamptz", element: "timestamptz", ...ARRAY },
    hint: /no field type reads it/,
  },
  {
    declared: "string[]",
    type: { typname: "_int8", element: "int8", ...ARRAY },
    hint: /no field type reads it/,
  },
];

describe("external column readings", () => {
  for (const { declared, type, value, lossy } of ACCEPTED) {
    const name = `a ${String(declared)} field over ${type.native ?? type.typname}`;

    it(`reads ${name} as ${value}`, () => {
      expect(DescribeDeclared(declared, type).value(COLUMN)).to.equal(value);
    });

    it(
      lossy
        ? `accepts ${name} and reports what it loses`
        : `accepts ${name} losslessly`,
      () => {
        const reported = DescribeDeclared(declared, type).lossy;
        if (lossy) {
          expect(reported).to.match(lossy);
        } else {
          expect(reported).to.equal(undefined);
        }
      },
    );
  }

  for (const { declared, type, hint } of REFUSED) {
    it(`refuses a ${String(declared)} field over ${type.typname}, naming field, column and the fix`, () => {
      expect(() => DescribeDeclared(declared, type))
        .to.throw("sales.t.c")
        .and.to.match(hint);
    });
  }
});

describe("declarations a catalog offers for a column", () => {
  const types = [...ACCEPTED, ...REFUSED].map((entry) => entry.type);

  for (const type of types) {
    const label = type.native ?? type.typname;

    it(`offers only declarations registration takes over ${label}, with their losses`, () => {
      for (const offered of AcceptedDeclarations(Column(type))) {
        const described = DescribeDeclared(offered.declared, type);
        expect(described.lossy).to.equal(offered.lossy);
      }
    });
  }

  for (const { declared, type } of REFUSED) {
    it(`never offers ${String(declared)} over ${type.typname}, which registration refuses`, () => {
      const offered = AcceptedDeclarations(Column(type)).map(
        (entry) => entry.declared,
      );
      expect(offered).to.not.include(declared);
    });
  }

  it("proposes number over a bigint, and offers string beside it", () => {
    const offered = AcceptedDeclarations(Column({ typname: "int8" })).map(
      (entry) => entry.declared,
    );
    expect(offered[0]).to.equal("number");
    expect(offered).to.include("string");
  });

  it("proposes date over a timestamp and string over an enum", () => {
    expect(
      AcceptedDeclarations(Column({ typname: "timestamp" }))[0].declared,
    ).to.equal("date");
    expect(
      AcceptedDeclarations(Column({ typname: "status", typtype: "e" }))[0]
        .declared,
    ).to.equal("string");
  });

  it("proposes the element's kind for an array", () => {
    expect(
      AcceptedDeclarations(
        Column({ typname: "_int4", element: "int4", ...ARRAY }),
      )[0].declared,
    ).to.equal("number[]");
  });

  it("offers nothing over a type no field type reads", () => {
    expect(AcceptedDeclarations(Column({ typname: "bytea" }))).to.deep.equal(
      [],
    );
  });
});

describe("external key columns", () => {
  it("reads a date key as its ISO text for _id", () => {
    expect(DescribeKey(Column({ typname: "date" }))?.value(COLUMN)).to.equal(
      `(${COLUMN})::text`,
    );
  });

  it("offers no _id over a float column, which is no identity", () => {
    expect(DescribeKey(Column({ typname: "float8" }))).to.equal(undefined);
  });
});
