import type { CROSS_INSTANCE } from "@antelopejs/interface-database/schema";
import { SchemaInstance } from "@antelopejs/interface-database";
import {
  QueryStage,
  type StagedObject,
} from "@antelopejs/interface-database/common";

import { RefusingCompilers, WithOptions } from "./spec-fixture";
import { FLOAT, TEXT } from "../../implementations/database/types";
import type { TableModel } from "../../implementations/database/fields";
import { DecodingContext } from "../../implementations/database/context";
import type { TableOrigin } from "../../implementations/database/relation";
import {
  BuildRoot,
  type RootSelection,
} from "../../implementations/database/selection";

interface Vehicle {
  car: string;
  price: number;
}

interface Shop {
  vehicles: Vehicle;
}

export const SCHEMA_ID = "shop";
export const TABLE_ID = "vehicles";

const VEHICLES: TableModel = {
  fields: {
    car: { column: "car", type: TEXT },
    price: { column: "price", type: FLOAT },
  },
};

const INDEXES = new Map<string, string[]>([["byCar", ["car", "price"]]]);

type InstanceId = string | typeof CROSS_INSTANCE | undefined;

function StubOrigin(schemaId: string, tableId: string): TableOrigin {
  return {
    schemaId,
    tableId,
    model: VEHICLES,
    index: (name) => INDEXES.get(name) ?? [name],
  };
}

export function NewContext(): DecodingContext {
  return new DecodingContext(RefusingCompilers(), StubOrigin);
}

export function Root(schemaId = SCHEMA_ID, instanceId?: InstanceId) {
  const schema = new SchemaInstance<Shop>(
    QueryStage("schema", { id: schemaId }),
  );
  const instance = new SchemaInstance<Shop>(
    QueryStage("instance", { id: instanceId }),
    schema,
  );
  return instance.table(TABLE_ID);
}

export function Build(
  query: StagedObject,
  context: DecodingContext,
): RootSelection {
  return WithOptions({}, () => BuildRoot(query.build(), context));
}
