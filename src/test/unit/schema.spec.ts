import { expect } from "chai";
import type { SchemaDefinition } from "@antelopejs/interface-database/schema";

import {
  GetSchema,
  GetTableNames,
  GetTableModel,
  Schemas,
  WaitForSchemaReady,
} from "../../implementations/database/schema";

const INHERITED = "constructor";

const BAD_SCHEMA = {
  orders: { fields: { ref: "uuid" }, indexes: {} },
} as unknown as SchemaDefinition;

async function Rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }
    return err;
  }
  throw new Error("expected the promise to reject");
}

describe("Schemas.register", () => {
  afterEach(() => {
    Schemas.unregister("broken");
  });

  it("keeps the parse failure in the readiness gate", async () => {
    const registered = await Rejection(Schemas.register("broken", BAD_SCHEMA));
    expect(registered.message).to.match(/uuid/);

    const gated = await Rejection(WaitForSchemaReady("broken"));
    expect(gated).to.equal(registered);
  });

  it("rolls back the definition and the parsed shape", async () => {
    await Rejection(Schemas.register("broken", BAD_SCHEMA));

    expect(() => GetSchema("broken")).to.throw(/Unknown schema/);
    expect(() => GetTableModel("broken", "orders")).to.throw(/Unknown schema/);
  });
});

describe("the registry accessors", () => {
  it("declines a schema named after an inherited member", () => {
    expect(() => GetSchema(INHERITED)).to.throw(
      `Unknown schema '${INHERITED}'`,
    );
    expect(() => GetTableModel(INHERITED, "orders")).to.throw(
      `Unknown schema '${INHERITED}'`,
    );
    expect(() => GetTableNames(INHERITED)).to.throw(
      `Unknown schema '${INHERITED}'`,
    );
  });

  it("gates a schema named after an inherited member on a real promise", () => {
    expect(WaitForSchemaReady(INHERITED)).to.be.an.instanceOf(Promise);
  });
});
