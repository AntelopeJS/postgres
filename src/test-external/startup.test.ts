import { expect } from "chai";

import { Query } from "../connection";
import { IsReaperRunning } from "../implementations/database/reaper";

interface Present {
  present: boolean;
}

describe("an external instance at startup", () => {
  it("starts no reaper, since it keeps no change log on the client's database", () => {
    expect(IsReaperRunning()).to.equal(false);
  });

  it("creates no bookkeeping schema in the client's database", async () => {
    const result = await Query<Present>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = '__antelope') AS present",
    );
    expect(result.rows[0].present).to.equal(false);
  });
});
