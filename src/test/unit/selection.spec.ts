import { SchemaInstance, ValueProxy } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";
import { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";
import { expect } from "chai";
import { DecodingContext } from "../../implementations/database/context";
import type { TableShape } from "../../implementations/database/fields";
import type { TableOrigin } from "../../implementations/database/relation";
import {
  BuildRoot,
  CollectSchemaIds,
  RegisteredOrigin,
  type RootSelection,
} from "../../implementations/database/selection";
import { FLOAT, TEXT } from "../../implementations/database/types";
import { RefusingCompilers, WithOptions } from "./spec-fixture";

interface Vehicle {
  car: string;
  price: number;
}

interface Shop {
  vehicles: Vehicle;
}

const SCHEMA_ID = "shop";
const OTHER_SCHEMA_ID = "warehouse";
const TABLE_ID = "vehicles";
const LAMBDA_ID_FLOOR = 0;
const ROW_ID = LAMBDA_ID_FLOOR - 1;

const VEHICLES: TableShape = {
  fields: {
    car: { column: "car", type: TEXT },
    price: { column: "price", type: FLOAT },
  },
};

const INDEXES: Record<string, string[]> = {
  byCar: ["car", "price"],
};

type InstanceId = string | typeof CROSS_INSTANCE | undefined;

function StubOrigin(schemaId: string, tableId: string): TableOrigin {
  return {
    schemaId,
    tableId,
    shape: VEHICLES,
    index: (name) => (Object.hasOwn(INDEXES, name) ? INDEXES[name] : [name]),
  };
}

function NewContext(): DecodingContext {
  const context = new DecodingContext(RefusingCompilers());
  context.resolveOrigin = StubOrigin;
  return context;
}

function Root(schemaId = SCHEMA_ID, instanceId: InstanceId = undefined) {
  const schema = new SchemaInstance<Shop>(
    QueryStage("schema", { id: schemaId }),
  );
  const instance = new SchemaInstance<Shop>(
    QueryStage("instance", { id: instanceId }),
    schema,
  );
  return instance.table(TABLE_ID);
}

function Build(query: StagedObject, context: DecodingContext): RootSelection {
  return WithOptions({}, () => BuildRoot(query.build(), context));
}

type TableQuery = ReturnType<typeof Root>;

interface CyclicPayload {
  nested: TableQuery;
  self?: CyclicPayload;
}

function Cyclic(): CyclicPayload {
  const payload: CyclicPayload = { nested: Root(OTHER_SCHEMA_ID) };
  payload.self = payload;
  return payload;
}

describe("BuildRoot", () => {
  it("reads the table the prefix names", () => {
    const { relation } = Build(Root(), NewContext());
    expect(relation.from).to.equal('"shop"."vehicles"');
    expect(relation.alias).to.equal("t0");
  });

  it("takes its alias from the context rather than assuming one", () => {
    const context = NewContext();
    expect(context.nextAlias()).to.equal("t0");
    expect(Build(Root(), context).relation.alias).to.equal("t1");
  });

  it("returns the stages that follow the prefix", () => {
    const { rest } = Build(Root().orderBy("price", "asc"), NewContext());
    expect(rest.map((stage) => stage.stage)).to.deep.equal(["orderBy"]);
  });

  it("returns no stages for a bare table read", () => {
    expect(Build(Root(), NewContext()).rest).to.deep.equal([]);
  });

  it("restricts an unnamed instance to the empty instance id", () => {
    const context = NewContext();
    const { relation } = Build(Root(), context);
    expect(relation.where).to.deep.equal(['("t0"."_instance" = ($1::text))']);
    expect(context.params.all()).to.deep.equal([""]);
  });

  it("restricts a named instance to its id", () => {
    const context = NewContext();
    const { relation } = Build(Root(SCHEMA_ID, "tenant-a"), context);
    expect(relation.where).to.deep.equal(['("t0"."_instance" = ($1::text))']);
    expect(context.params.all()).to.deep.equal(["tenant-a"]);
  });

  it("reads across instances under CROSS_INSTANCE, burning no parameter", () => {
    const context = NewContext();
    const { relation } = Build(Root(SCHEMA_ID, CROSS_INSTANCE), context);
    expect(relation.where).to.deep.equal([]);
    expect(context.params.all()).to.deep.equal([]);
  });

  it("rejects an instance id that is neither a string nor the sentinel", () => {
    const query = Root(SCHEMA_ID, 7 as unknown as string);
    expect(() => Build(query, NewContext())).to.throw(
      "An instance id must be a string or CROSS_INSTANCE, received number",
    );
  });

  it("starts in row mode addressing the origin's own columns", () => {
    const { relation } = Build(Root(), NewContext());
    expect(relation.projection).to.equal(undefined);
    expect(relation.origin?.schemaId).to.equal(SCHEMA_ID);
    expect(relation.origin?.tableId).to.equal(TABLE_ID);
    expect(relation.source.field("price").sql).to.equal('"t0"."price"');
  });

  it("carries the injected index resolver onto the origin", () => {
    const { relation } = Build(Root(), NewContext());
    expect(relation.origin?.index("byCar")).to.deep.equal(["car", "price"]);
    expect(relation.origin?.index("price")).to.deep.equal(["price"]);
  });

  it("names the stage that was expected when the prefix is short", () => {
    const stages = Root().build().slice(0, 2);
    expect(() =>
      WithOptions({}, () => BuildRoot(stages, NewContext())),
    ).to.throw("stage 2 is 'missing'");
  });

  it("names the stage that was expected when the prefix is wrong", () => {
    const stages = Root().build().slice(1);
    expect(() =>
      WithOptions({}, () => BuildRoot(stages, NewContext())),
    ).to.throw("stage 0 is 'instance'");
  });

  it("rejects a prefix stage carrying no id", () => {
    const stages = Root().build();
    stages[0] = QueryStage("schema");
    expect(() =>
      WithOptions({}, () => BuildRoot(stages, NewContext())),
    ).to.throw("The 'schema' stage of a table query is missing its id");
  });
});

describe("RegisteredOrigin", () => {
  it("answers out of the live registry, not a stub", () => {
    expect(() => RegisteredOrigin("no-such-schema", TABLE_ID)).to.throw(
      "Unknown schema 'no-such-schema'",
    );
  });
});

describe("CollectSchemaIds", () => {
  it("collects the schema a plain table query names", () => {
    expect(CollectSchemaIds(Root().build())).to.deep.equal([SCHEMA_ID]);
  });

  it("walks into a query passed as a stage argument", () => {
    const query = Root().union(Root(OTHER_SCHEMA_ID));
    expect(CollectSchemaIds(query.build())).to.deep.equal([
      SCHEMA_ID,
      OTHER_SCHEMA_ID,
    ]);
  });

  it("reaches a query nested two levels deep", () => {
    const query = Root().union(Root(OTHER_SCHEMA_ID).union(Root("depot")));
    expect(CollectSchemaIds(query.build())).to.deep.equal([
      SCHEMA_ID,
      OTHER_SCHEMA_ID,
      "depot",
    ]);
  });

  it("de-duplicates a schema read twice", () => {
    const query = Root().union(Root());
    expect(CollectSchemaIds(query.build())).to.deep.equal([SCHEMA_ID]);
  });

  it("ignores a stage argument that is not a query", () => {
    const query = Root().pluck("car", "price");
    expect(CollectSchemaIds(query.build())).to.deep.equal([SCHEMA_ID]);
  });

  it("reaches a query in the document a lambda returns", () => {
    const query = Root().map(() => ({ other: Root(OTHER_SCHEMA_ID) }));
    expect(CollectSchemaIds(query.build())).to.deep.equal([
      SCHEMA_ID,
      OTHER_SCHEMA_ID,
    ]);
  });

  it("reaches a query inside an array inside a lambda's document", () => {
    const query = Root().map(() => ({ others: [Root(OTHER_SCHEMA_ID)] }));
    expect(CollectSchemaIds(query.build())).to.deep.equal([
      SCHEMA_ID,
      OTHER_SCHEMA_ID,
    ]);
  });

  it("reaches a query carried by a recorded expression's own stage", () => {
    const compared = ValueProxy.arg<number>(ROW_ID).eq(Root(OTHER_SCHEMA_ID));
    expect(CollectSchemaIds(Root().default(compared).build())).to.deep.equal([
      SCHEMA_ID,
      OTHER_SCHEMA_ID,
    ]);
  });

  it("does not walk a date as a document of its own keys", () => {
    const dated = Object.assign(new Date(), { hidden: Root(OTHER_SCHEMA_ID) });
    expect(CollectSchemaIds(Root().default(dated).build())).to.deep.equal([
      SCHEMA_ID,
    ]);
  });

  it("terminates on a cyclic payload and still reads past the cycle", () => {
    const query = Root().default(Cyclic());
    expect(CollectSchemaIds(query.build())).to.deep.equal([
      SCHEMA_ID,
      OTHER_SCHEMA_ID,
    ]);
  });
});
