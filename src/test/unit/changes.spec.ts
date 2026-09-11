import { expect } from "chai";

import { WithOptions } from "./spec-fixture";
import {
  CHANGE_CHANNEL,
  CHANGE_LOG_STATEMENTS,
  TriggerStatements,
} from "../../implementations/database/changes";

const SCHEMA_ID = "shop";
const TABLE_ID = "orders";

const LOG_DDL = 0;
const FEED_INDEX_DDL = 1;
const REAPED_DDL = 2;
const ADDED_FUNCTION = 3;
const MODIFIED_FUNCTION = 4;
const REMOVED_FUNCTION = 5;

const INSERT_TRIGGER = 0;
const UPDATE_TRIGGER = 1;
const DELETE_TRIGGER = 2;

const FUNCTIONS = [ADDED_FUNCTION, MODIFIED_FUNCTION, REMOVED_FUNCTION];

/**
 * The three trigger statements, read under a configuration of this spec's own.
 *
 * `TriggerStatements` names the *physical* table, so it reads the process-wide schema prefix
 * through `SchemaName`; setting and restoring inside one synchronous call is what keeps a
 * concurrent registration from observing either.
 */
function Installed(schemaPrefix = ""): readonly string[] {
  return WithOptions({ schemaPrefix }, () =>
    TriggerStatements(SCHEMA_ID, TABLE_ID),
  );
}

describe("the change log's DDL", () => {
  it("declares the log UNLOGGED, since no feed replays what happened before it opened", () => {
    expect(CHANGE_LOG_STATEMENTS[LOG_DDL]).to.contain(
      'CREATE UNLOGGED TABLE IF NOT EXISTS "__antelope"."changes"',
    );
  });

  it("takes the transaction id as xid8, which is what pg_current_xact_id answers", () => {
    expect(CHANGE_LOG_STATEMENTS[LOG_DDL]).to.contain(
      '"txid" xid8 NOT NULL DEFAULT pg_current_xact_id()',
    );
    expect(CHANGE_LOG_STATEMENTS[LOG_DDL]).to.not.contain("bigint");
  });

  it("keeps the high-water row permanent and unsequenced, which is what makes a restart visible", () => {
    const reaped = CHANGE_LOG_STATEMENTS[REAPED_DDL];
    expect(reaped).to.contain(
      'CREATE TABLE IF NOT EXISTS "__antelope"."changes_reaped"',
    );
    expect(reaped).to.not.contain("UNLOGGED");
    expect(reaped).to.not.contain("xid8");
    expect(reaped).to.not.contain("bigserial");
  });

  it("carries an epoch beside the high-water, so a reset sequence cannot be compared across it", () => {
    expect(CHANGE_LOG_STATEMENTS[REAPED_DDL]).to.contain(
      '"postmaster_started_at" timestamptz NOT NULL',
    );
  });

  it("indexes the log the way a feed reads it", () => {
    expect(CHANGE_LOG_STATEMENTS[FEED_INDEX_DDL]).to.contain(
      'ON "__antelope"."changes" ("schema_id", "table_id", "seq")',
    );
  });

  it("puts every trigger function in the registry schema, so dropping a schema orphans nothing", () => {
    for (const statement of FUNCTIONS) {
      expect(CHANGE_LOG_STATEMENTS[statement]).to.match(
        /CREATE OR REPLACE FUNCTION "__antelope"\."changes_\w+"\(\) RETURNS trigger/,
      );
    }
  });

  it("logs the physical row rather than an assembled document", () => {
    expect(CHANGE_LOG_STATEMENTS[ADDED_FUNCTION]).to.contain("to_jsonb(n.*)");
    expect(CHANGE_LOG_STATEMENTS[REMOVED_FUNCTION]).to.contain("to_jsonb(o.*)");
  });

  it("names the whole row, since a bare alias loses to a column of the same name", () => {
    for (const statement of FUNCTIONS) {
      expect(CHANGE_LOG_STATEMENTS[statement]).to.not.match(/to_jsonb\([no]\)/);
    }
  });

  it("pairs the update's two transition tables on the key writes cannot reassign", () => {
    expect(CHANGE_LOG_STATEMENTS[MODIFIED_FUNCTION]).to.contain(
      'JOIN "old_table" o ON o."_instance" = n."_instance" AND o."_id" = n."_id"',
    );
  });

  it("announces every change on the one channel a listener subscribes to", () => {
    for (const statement of FUNCTIONS) {
      expect(CHANGE_LOG_STATEMENTS[statement]).to.contain(
        `PERFORM pg_notify('${CHANGE_CHANNEL}', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME)`,
      );
    }
  });

  it("names the schema and table from the trigger's own context, not from the installer", () => {
    for (const statement of FUNCTIONS) {
      expect(CHANGE_LOG_STATEMENTS[statement]).to.contain(
        "SELECT TG_TABLE_SCHEMA, TG_TABLE_NAME,",
      );
    }
  });

  it("returns NULL, which is the only thing an AFTER STATEMENT trigger may answer", () => {
    for (const statement of FUNCTIONS) {
      expect(CHANGE_LOG_STATEMENTS[statement]).to.contain("RETURN NULL;");
    }
  });
});

describe("the change log's triggers", () => {
  it("replaces rather than looks up and creates, which two installers would race", () => {
    for (const statement of Installed()) {
      expect(statement).to.contain("CREATE OR REPLACE TRIGGER");
      expect(statement).to.contain("FOR EACH STATEMENT");
    }
  });

  it("gives each operation the transition tables its function reads and no others", () => {
    const statements = Installed();
    expect(statements[INSERT_TRIGGER]).to.contain(
      'AFTER INSERT ON "shop"."orders"\nREFERENCING NEW TABLE AS "new_table"',
    );
    expect(statements[UPDATE_TRIGGER]).to.contain(
      'REFERENCING OLD TABLE AS "old_table" NEW TABLE AS "new_table"',
    );
    expect(statements[DELETE_TRIGGER]).to.contain(
      'AFTER DELETE ON "shop"."orders"\nREFERENCING OLD TABLE AS "old_table"',
    );
    expect(statements[DELETE_TRIGGER]).to.not.contain("NEW TABLE");
  });

  it("points each trigger at the function that reads the tables it declares", () => {
    const statements = Installed();
    expect(statements[INSERT_TRIGGER]).to.contain(
      'EXECUTE FUNCTION "__antelope"."changes_added"()',
    );
    expect(statements[UPDATE_TRIGGER]).to.contain(
      'EXECUTE FUNCTION "__antelope"."changes_modified"()',
    );
    expect(statements[DELETE_TRIGGER]).to.contain(
      'EXECUTE FUNCTION "__antelope"."changes_removed"()',
    );
  });

  it("names three distinct triggers, so the three never replace one another", () => {
    const names = Installed().map(
      (statement) => /CREATE OR REPLACE TRIGGER ("[^"]+")/.exec(statement)?.[1],
    );
    expect(new Set(names).size).to.equal(names.length);
  });

  it("targets the physical table, so the schema prefix reaches the trigger", () => {
    expect(Installed("app_")[INSERT_TRIGGER]).to.contain(
      'ON "app_shop"."orders"',
    );
  });
});
