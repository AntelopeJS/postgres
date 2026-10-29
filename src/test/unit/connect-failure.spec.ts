import { expect } from "chai";

import { DescribeConnectFailure } from "../../connect-failure";

const URL = "postgres://reader:secret@client-db:6543/erp";
const URL_WITHOUT_PORT = "postgres://reader:secret@client-db/erp";

function Coded(code: string, message = "driver message"): Error {
  return Object.assign(new Error(message), { code });
}

describe("DescribeConnectFailure", () => {
  const CASES = [
    { code: "28P01", expected: "wrong user or password (28P01)" },
    { code: "3D000", expected: "the database does not exist (3D000)" },
    {
      code: "ECONNREFUSED",
      expected: "the server is not answering at client-db:6543 (ECONNREFUSED)",
    },
    {
      code: "ENOTFOUND",
      expected: "the server is not answering at client-db:6543 (ENOTFOUND)",
    },
    {
      code: "ETIMEDOUT",
      expected: "the server is not answering at client-db:6543 (ETIMEDOUT)",
    },
  ];

  for (const { code, expected } of CASES) {
    it(`words ${code} as one sentence and keeps the code`, () => {
      expect(DescribeConnectFailure(Coded(code), URL)).to.equal(expected);
    });
  }

  it("says the server requires SSL when pg_hba refuses an unencrypted connection", () => {
    const refusal = Coded(
      "28000",
      'no pg_hba.conf entry for host "10.0.0.2", user "reader", database "erp", no encryption',
    );
    expect(DescribeConnectFailure(refusal, URL)).to.equal(
      "the server requires SSL (28000)",
    );
  });

  it("keeps the driver's message for a 28000 refusal that is not about SSL", () => {
    const refusal = Coded("28000", 'role "reader" is not permitted to log in');
    expect(DescribeConnectFailure(refusal, URL)).to.equal(
      'role "reader" is not permitted to log in (28000)',
    );
  });

  it("names the default port when the URL has none", () => {
    expect(
      DescribeConnectFailure(Coded("ECONNREFUSED"), URL_WITHOUT_PORT),
    ).to.equal("the server is not answering at client-db:5432 (ECONNREFUSED)");
  });

  it("keeps an unmapped code with the driver's message", () => {
    expect(
      DescribeConnectFailure(Coded("53300", "too many connections"), URL),
    ).to.equal("too many connections (53300)");
  });

  it("keeps the message of an error without a code", () => {
    expect(DescribeConnectFailure(new Error("socket hang up"), URL)).to.equal(
      "socket hang up",
    );
  });
});
