/**
 * The client database the external suite reads: created by its owner before the module constructs,
 * and never by the adapter. Every value is derived from the row number, so a test can state its
 * expected answer as a native query over the same rows.
 */
export const CLIENT_DATABASE = "antelopejs_external";

export const CLIENT_ROLE = "dms_client";

export const READER_PASSWORD = "reader";

export const FIXTURE: readonly string[] = [
  "CREATE EXTENSION IF NOT EXISTS citext",
  "CREATE SCHEMA sales",
  "CREATE TYPE sales.status AS ENUM ('lead', 'active', 'churned')",
  `CREATE TABLE sales.accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name varchar(200) NOT NULL,
    email citext,
    status sales.status NOT NULL DEFAULT 'lead',
    revenue numeric(12,2),
    score integer,
    rating real,
    created_at timestamptz NOT NULL DEFAULT now(),
    signed_on date,
    last_seen timestamp,
    external_ref uuid UNIQUE,
    tags text[],
    meta jsonb,
    raw json,
    active boolean,
    big_counter bigint,
    name_upper text GENERATED ALWAYS AS (upper(name)) STORED
  )`,
  "CREATE INDEX accounts_score ON sales.accounts (score)",
  "CREATE INDEX accounts_revenue ON sales.accounts (revenue)",
  "CREATE INDEX accounts_created ON sales.accounts (created_at)",
  "CREATE INDEX accounts_signed ON sales.accounts (signed_on)",
  "CREATE INDEX accounts_last_seen ON sales.accounts (last_seen)",
  "CREATE INDEX accounts_status ON sales.accounts (status)",
  "CREATE INDEX accounts_name ON sales.accounts (name)",
  "CREATE INDEX accounts_email ON sales.accounts (email)",
  `CREATE TABLE sales.contacts (
    contact_id uuid PRIMARY KEY,
    account_id bigint REFERENCES sales.accounts (id),
    first_name text NOT NULL,
    created_at timestamp NOT NULL
  )`,
  "CREATE INDEX contacts_account ON sales.contacts (account_id)",
  "CREATE INDEX contacts_created ON sales.contacts (created_at)",
  `CREATE TABLE sales.order_lines (
    order_id int NOT NULL, line_no int NOT NULL, sku text, qty int,
    PRIMARY KEY (order_id, line_no)
  )`,
  `CREATE TABLE sales.events (event_ref uuid NOT NULL, at timestamptz NOT NULL, msg text)`,
  "CREATE UNIQUE INDEX events_ref ON sales.events (event_ref)",
  "CREATE UNIQUE INDEX events_at_msg ON sales.events (at, msg)",
  "CREATE TABLE sales.raw_log (at timestamptz, msg text)",
  "CREATE TABLE sales.countries (code char(2) PRIMARY KEY, name text)",
  "CREATE TABLE sales.flags (id int PRIMARY KEY, ref uuid, n int)",
  "INSERT INTO sales.flags VALUES (1, md5('flag1')::uuid, 5), (2, NULL, NULL)",
  `CREATE TABLE sales.tags (id int PRIMARY KEY, label text) PARTITION BY HASH (id)`,
  "CREATE TABLE sales.tags_0 PARTITION OF sales.tags FOR VALUES WITH (MODULUS 2, REMAINDER 0)",
  "CREATE TABLE sales.tags_1 PARTITION OF sales.tags FOR VALUES WITH (MODULUS 2, REMAINDER 1)",
  `INSERT INTO sales.accounts (name, email, status, revenue, score, rating, created_at, signed_on,
      last_seen, external_ref, tags, meta, raw, active, big_counter)
    SELECT 'Acct ' || g, 'User' || g || '@Example.com',
      (ARRAY['lead', 'active', 'churned'])[1 + g % 3]::sales.status,
      (g * 13.37)::numeric(12,2), g % 100, (g % 50) / 10.0,
      timestamptz '2026-01-01 00:00:00+00' + (g || ' hours')::interval,
      date '2026-01-01' + (g % 300), timestamp '2026-01-01 00:00' + (g || ' minutes')::interval,
      md5('account' || g)::uuid, ARRAY['t' || (g % 5)], jsonb_build_object('k', g),
      json_build_object('k', g), g % 2 = 0, 9007199254740993 + g
    FROM generate_series(1, 20000) g`,
  `INSERT INTO sales.contacts (contact_id, account_id, first_name, created_at)
    SELECT md5('contact' || g)::uuid, 1 + (g % 20000), 'First' || g,
      timestamp '2026-03-01 23:30' + (g || ' minutes')::interval
    FROM generate_series(1, 20000) g`,
  `INSERT INTO sales.order_lines SELECT g / 10, g % 10, 'sku' || g, g % 7 FROM generate_series(1, 5000) g`,
  `INSERT INTO sales.events
    SELECT md5('event' || g)::uuid, timestamptz '2026-01-01' + (g || ' minutes')::interval, 'm' || g
    FROM generate_series(1, 5000) g`,
  `INSERT INTO sales.raw_log
    SELECT timestamptz '2026-01-01' + (g || ' seconds')::interval, 'r' || g FROM generate_series(1, 5000) g`,
  "INSERT INTO sales.countries VALUES ('FR', 'France'), ('IT', 'Italy')",
  "INSERT INTO sales.tags SELECT g, 'tag' || g FROM generate_series(1, 1000) g",
  `CREATE VIEW sales.big_accounts AS
    SELECT a.id, a.name AS account_name, a.revenue FROM sales.accounts a WHERE a.revenue > 1000`,
  `CREATE MATERIALIZED VIEW sales.daily_signups AS
    SELECT signed_on AS day, count(*) AS n FROM sales.accounts GROUP BY signed_on`,
  "CREATE UNIQUE INDEX daily_signups_day ON sales.daily_signups (day)",
  `CREATE TABLE sales.w_accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code varchar(5) NOT NULL UNIQUE,
    email citext,
    status sales.status NOT NULL DEFAULT 'lead',
    revenue numeric(12,2) CHECK (revenue >= 0),
    big bigint,
    rating real,
    seen timestamp,
    at timestamptz NOT NULL DEFAULT now(),
    raw json,
    tags text[],
    upper_code text GENERATED ALWAYS AS (upper(code)) STORED
  )`,
  `CREATE TABLE sales.w_items (
    sku uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id bigint REFERENCES sales.w_accounts (id),
    qty int NOT NULL
  )`,
  "CREATE TABLE sales.w_serial (id serial PRIMARY KEY, label text)",
  "CREATE TABLE sales.w_events (at timestamptz PRIMARY KEY, msg text)",
  "CREATE TABLE sales.w_big (id bigint PRIMARY KEY, label text)",
  `CREATE TABLE sales.w_lines (
    order_id int NOT NULL, line_no int NOT NULL, qty int, PRIMARY KEY (order_id, line_no)
  )`,
  "COMMENT ON TABLE sales.accounts IS 'Customer accounts'",
  "COMMENT ON COLUMN sales.accounts.name IS 'Display name'",
  "CREATE TABLE sales.people (id int PRIMARY KEY, name text, ssn text)",
  "INSERT INTO sales.people SELECT g, 'Person ' || g, lpad(g::text, 9, '0') FROM generate_series(1, 100) g",
  "CREATE TABLE sales.attachments (id int PRIMARY KEY, note text, body bytea)",
  "CREATE VIEW sales.v_transaction AS SELECT current_setting('transaction_read_only') AS read_only",
  `INSERT INTO sales.attachments VALUES
    (1, repeat('n', 300), decode('00010203', 'hex')),
    (2, 'short', NULL),
    (3, NULL, decode('ff', 'hex'))`,
  `CREATE TABLE sales.invoices (
    id int PRIMARY KEY, kind text NOT NULL, account_ref bigint, broken_ref bigint, issued_on date
  )`,
  `INSERT INTO sales.invoices
    SELECT g, CASE WHEN g <= 2 THEN 'disputed' ELSE (ARRAY['paid', 'open', 'void'])[1 + g % 3] END,
      1 + (g % 20000), CASE WHEN g % 4 = 0 THEN 900000 + g ELSE 1 + g END,
      date '2025-01-01' + (g % 400)
    FROM generate_series(1, 1000) g`,
  "ANALYZE",
  `CREATE TABLE sales.big_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, kind text NOT NULL, at timestamptz NOT NULL
  ) WITH (autovacuum_enabled = false)`,
  `INSERT INTO sales.big_events (kind, at)
    SELECT (ARRAY['click', 'view', 'buy'])[1 + g % 3], timestamptz '2025-01-01' + (g || ' seconds')::interval
    FROM generate_series(1, 1100000) g`,
];

/** Rows of the never-analyzed table, which only the live-tuple counter knows the size of. */
export const BIG_EVENTS_ROWS = 1_100_000;

/** The tables the external suite writes; every other relation stays readable only. */
const WRITABLE_TABLES: readonly string[] = [
  "sales.w_accounts",
  "sales.w_items",
  "sales.w_serial",
  "sales.w_lines",
  "sales.w_events",
  "sales.w_big",
];

/** What a client grants the account the DMS writes with: rows of the writable tables, and their sequences. */
export function WriterGrants(role: string): string[] {
  return [
    `GRANT INSERT, UPDATE, DELETE ON ${WRITABLE_TABLES.join(", ")} TO ${role}`,
    `GRANT USAGE ON ALL SEQUENCES IN SCHEMA sales TO ${role}`,
  ];
}

/** What a client grants the account the DMS reads with: the schema and its rows, nothing more. */
export function ReaderGrants(role: string): string[] {
  return [
    `GRANT USAGE ON SCHEMA sales TO ${role}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA sales TO ${role}`,
    `REVOKE SELECT ON sales.people FROM ${role}`,
    `GRANT SELECT (id, name) ON sales.people TO ${role}`,
  ];
}
