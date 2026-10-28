import type { TableDefinition } from "@antelopejs/interface-database/schema";

import { ParseTable } from "../../implementations/database/fields";
import {
  BuildTablePlan,
  type TablePlan,
} from "../../implementations/database/ddl";

export const vehicles: TableDefinition = {
  fields: { car: "string", price: "number", tags: "string[]" },
  indexes: {
    price: {},
    tags: { multi: true },
    byCar: { fields: ["car", "price"] },
  },
};

export const VEHICLES_PLAN = BuildTablePlan(
  "vehicles",
  vehicles,
  ParseTable(vehicles, "s.vehicles"),
);

export function PlanFor(
  tableId: string,
  definition: TableDefinition,
): TablePlan {
  return BuildTablePlan(
    tableId,
    definition,
    ParseTable(definition, `s.${tableId}`),
  );
}
