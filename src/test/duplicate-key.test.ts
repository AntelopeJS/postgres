import { expect } from "chai";
import {
  DuplicateKeyError,
  IsDuplicateKeyError,
} from "@antelopejs/interface-database";
import {
  Schema,
  type SchemaDefinition,
} from "@antelopejs/interface-database/schema";

import { Query } from "../connection";
import { QuoteIdentifier } from "../implementations/database/sql";
import { SchemaName } from "../implementations/database/identifier";
import { WaitForIndexes } from "../implementations/database/schema";

interface Account {
  _id?: string;
  email: string;
  team: string;
  seat: number;
}

interface Tables {
  accounts: Account;
}

const DEFINITION: SchemaDefinition = {
  accounts: {
    fields: { email: "string", team: "string", seat: "number" },
    indexes: {
      email: { unique: true, crossInstance: true },
      teamSeat: { fields: ["team", "seat"], unique: true },
      team: {},
    },
  },
};

const ALPHA = "alpha";
const BETA = "beta";

async function Fresh(schemaId: string): Promise<Schema<Tables>> {
  await Query(
    `DROP SCHEMA IF EXISTS ${QuoteIdentifier(SchemaName(schemaId))} CASCADE`,
  );
  const schema = new Schema<Tables>(schemaId, DEFINITION);
  await WaitForIndexes(schemaId);
  await schema.createInstance(ALPHA);
  await schema.createInstance(BETA);
  return schema;
}

function Accounts(schema: Schema<Tables>, instance: string = ALPHA) {
  return schema.instance(instance).table("accounts");
}

function Row(id: string, email: string, seat: number): Account {
  return { _id: id, email, team: "core", seat };
}

/** The error a write was refused with, failing the test when it was not refused. */
async function Refusal(write: PromiseLike<unknown>): Promise<unknown> {
  try {
    await write;
  } catch (err) {
    return err;
  }
  return expect.fail("the write should have been refused");
}

async function ExpectDuplicate(
  write: PromiseLike<unknown>,
  index: string,
  fields: string[],
): Promise<void> {
  const err = await Refusal(write);
  expect(IsDuplicateKeyError(err), String(err)).to.equal(true);
  expect(err).to.be.instanceOf(DuplicateKeyError);
  const duplicate = err as DuplicateKeyError;
  expect(duplicate.index).to.equal(index);
  expect(duplicate.fields).to.deep.equal(fields);
}

describe("duplicate keys", () => {
  let schema: Schema<Tables>;

  beforeEach(async () => {
    schema = await Fresh("duplicate_keys");
  });

  it("refuses a second row with the same _id as a duplicate of _id", async () => {
    await Accounts(schema).insert(Row("a", "a@x", 1));
    await ExpectDuplicate(
      Accounts(schema).insert(Row("a", "other@x", 2)),
      "_id",
      ["_id"],
    );
  });

  it("upserts on _id under a conflict mode instead of refusing", async () => {
    await Accounts(schema).insert(Row("a", "a@x", 1));
    await Accounts(schema).insert(Row("a", "b@x", 2), { conflict: "update" });
    const row = await Accounts(schema).get("a");
    expect(row?.email).to.equal("b@x");
  });

  it("refuses an insert that clashes on a unique secondary index, conflict mode or not", async () => {
    await Accounts(schema).insert(Row("a", "a@x", 1));
    await ExpectDuplicate(
      Accounts(schema).insert(Row("b", "a@x", 2)),
      "email",
      ["email"],
    );
    await ExpectDuplicate(
      Accounts(schema).insert(Row("b", "a@x", 2), { conflict: "update" }),
      "email",
      ["email"],
    );
    expect(await Accounts(schema).count()).to.equal(1);
  });

  it("refuses an update and a replace that clash on a unique index", async () => {
    await Accounts(schema).insert([Row("a", "a@x", 1), Row("b", "b@x", 2)]);
    await ExpectDuplicate(
      Accounts(schema).get("b").update({ email: "a@x" }),
      "email",
      ["email"],
    );
    await ExpectDuplicate(
      Accounts(schema)
        .get("b")
        .replace(Row("b", "b@x", 1)),
      "teamSeat",
      ["team", "seat"],
    );
    const row = await Accounts(schema).get("b");
    expect(row).to.include({ email: "b@x", seat: 2 });
  });

  it("refuses a compound key only when every field matches", async () => {
    await Accounts(schema).insert(Row("a", "a@x", 1));
    await Accounts(schema).insert(Row("b", "b@x", 2));
    await Accounts(schema).insert({
      _id: "c",
      email: "c@x",
      team: "ops",
      seat: 1,
    });
    await ExpectDuplicate(
      Accounts(schema).insert(Row("d", "d@x", 1)),
      "teamSeat",
      ["team", "seat"],
    );
  });

  it("accepts the same key in two instances, crossInstance included", async () => {
    await Accounts(schema, ALPHA).insert(Row("a", "a@x", 1));
    await Accounts(schema, BETA).insert(Row("a", "a@x", 1));
    expect(await Accounts(schema, BETA).count()).to.equal(1);
  });
});
