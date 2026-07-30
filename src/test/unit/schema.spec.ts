import type { SchemaDefinition } from "@antelopejs/interface-database/schema";
import { expect } from "chai";
import {
  GetSchema,
  GetTableShape,
  Schemas,
  WaitForSchemaReady,
} from "../../implementations/database/schema";

const BAD_SCHEMA = {
  orders: { fields: { ref: "uuid" }, indexes: {} },
} as unknown as SchemaDefinition;

async function Rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
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
    expect(() => GetTableShape("broken", "orders")).to.throw(/Unknown schema/);
  });
});
