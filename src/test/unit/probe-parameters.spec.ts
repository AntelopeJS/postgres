import { expect } from "chai";
import { Client } from "pg";

import { CONNECTION_PARAMETERS } from "../../probe-parameters";

describe("the probe's connection parameter table", () => {
  it("names every parameter pg reads from a connection string, and nothing else", () => {
    const client = new Client({
      connectionString: "postgres://reader:secret@client-db:6543/erp",
      keepAlive: true,
      keepAliveInitialDelayMillis: 1000,
    });
    const read = Object.getOwnPropertyNames(client.connectionParameters);
    expect([...read].sort()).to.deep.equal(
      [...CONNECTION_PARAMETERS.keys()].sort(),
    );
  });
});
