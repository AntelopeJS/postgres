import type { QueryStage } from "@antelopejs/interface-database/common";
import { AsFloat, Moment, UTC_ZONE } from "./readings";
import { type Compiled, QuoteLiteral } from "./sql";
import {
  AsValue,
  BuildStages,
  FIRST_OPERAND,
  Lift,
  RequireOperand,
  SECOND_OPERAND,
  type StageHandler,
  type StageMap,
} from "./stage";
import { BOOL } from "./types";

type LocalReading = (local: string) => string;

const DAY_UNIT = QuoteLiteral("day");
const EPOCH_FIELD = "EPOCH";
const AT_OR_AFTER = ">=";
const BEFORE = "<";

const DATE_PARTS: Record<string, string> = {
  date_year: "YEAR",
  date_month: "MONTH",
  date_day: "DAY",
  date_dow: "ISODOW",
  date_doy: "DOY",
  date_hours: "HOUR",
  date_minutes: "MINUTE",
  date_seconds: "SECOND",
};

function Local(value: Compiled, timezone?: string): string {
  return `(${Moment(value).sql} AT TIME ZONE ${timezone ?? UTC_ZONE})`;
}

function Extraction(field: string): LocalReading {
  return (local) => `EXTRACT(${field} FROM ${local})`;
}

const SinceMidnight: LocalReading = (local) =>
  `EXTRACT(${EPOCH_FIELD} FROM (${local} - date_trunc(${DAY_UNIT}, ${local})))`;

function LocalStage(reading: LocalReading): StageHandler {
  return (state) => ({
    current: AsFloat(reading(Local(AsValue(state), state.timezone))),
  });
}

function PartStage(field: string): StageHandler {
  return LocalStage(Extraction(field));
}

function ZoneLiteral(stage: QueryStage): string {
  const zone = stage.args[FIRST_OPERAND];
  if (typeof zone !== "string" || zone.length === 0) {
    throw new Error(
      `Stage '${stage.stage}' requires a time zone name at position ${FIRST_OPERAND}`,
    );
  }
  return QuoteLiteral(zone);
}

const TimezoneStage: StageHandler = (state, stage) => ({
  current: state.current,
  timezone: ZoneLiteral(stage),
});

const EpochStage = Lift((value) =>
  AsFloat(`EXTRACT(${EPOCH_FIELD} FROM ${Moment(value).sql})`),
);

const DuringStage = Lift((value, args, stage) => {
  const moment = Moment(value).sql;
  const low = Moment(
    RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND),
  ).sql;
  const high = Moment(
    RequireOperand(args[SECOND_OPERAND], stage, SECOND_OPERAND),
  ).sql;
  return {
    sql: `((${moment} ${AT_OR_AFTER} ${low}) AND (${moment} ${BEFORE} ${high}))`,
    type: BOOL,
  };
});

/**
 * Date stages.
 *
 * No *extraction* here reads a `timestamptz` under session state.
 * `EXTRACT(DAY FROM <timestamptz>)` is evaluated in the session's `TimeZone`, so
 * `doc.key("createdAt").day()` against UTC midnight answers 14 rather than 15 on a server set to
 * `America/New_York` — a wrong answer that nothing in the query mentions, and one the default UTC
 * of a container would hide until a deployment. Every extraction therefore names its zone,
 * `'UTC'` when the caller gave none, and reads the `timestamp without time zone` that
 * `AT TIME ZONE` yields. `date_tod` truncates that same local value rather than the instant,
 * which is what makes `date_trunc` session-independent too.
 *
 * Naming the zone is not sufficient on its own, which is why `connection.ts` also pins the
 * session: reading a `text` or jsonb operand as an instant runs `timestamptz_in`, and that
 * resolves a string carrying no offset under `TimeZone` and an ambiguous numeric date under
 * `DateStyle` before any extraction sees it. The two are complements, not alternatives — the
 * explicit zone also covers a server whose settings changed under a live pool.
 *
 * The zone itself is *state*, not a transformation: `withTimezone` is only ever emitted as a
 * prefix of an extraction and does not move the instant, so `date_with_timezone` records it on
 * the accumulator and passes the accumulator through untouched — materializing it there would
 * turn a row addressing `t."createdAt"` into a whole jsonb document and lose the column's index
 * for a stage that never reads the value. Turning the zone into a value would put a naive
 * timestamp into an accumulator whose type model has no such kind. These nine readings are the
 * only handlers in the compiler that consume that zone; every other stage drops it — `Lift` and
 * `LiftRaw` return a state without one, and the few handlers written directly build a fresh state
 * too — and a zone no extraction reads is genuinely a no-op.
 *
 * The zone is emitted as a **quoted literal**, never a parameter. `AT TIME ZONE` takes a zone
 * name, which is structural in the same sense as `obj_has`'s field names; and a parameter would
 * be bound into the ledger by the recording stage and then dropped by any stage that clears the
 * zone, leaving the statement referring to `$2` with two values bound and PostgreSQL answering
 * `there is no parameter $2`. An unrecognised name raises `22023` at parse time, which is
 * accepted as caller error on the same terms as an invalid regular expression in `str_match`:
 * the only test of a zone name is the server's own `pg_timezone_names`, compilation is
 * synchronous and holds no connection, and the alternative — a runtime `EXISTS` guard — would
 * turn a typo into silent NULLs. An **empty** zone is rejected at compile time, where the stage
 * can still be named.
 *
 * `date_epoch` and `date_during` are lifted for exactly that reason: an instant and a comparison
 * between instants do not depend on a zone, so both must ignore a pending one, and going through
 * `Lift` makes that structural rather than remembered. `during` is low-inclusive and
 * high-exclusive, as the contract documents it.
 *
 * `date_dow` is `ISODOW` and not `DOW`: the contract's callers assert a day of week in 1..7 with
 * Monday first, where `DOW` is 0..6 with Sunday first and satisfies neither. Every part ends
 * `::double precision`, since `EXTRACT` yields `numeric` and the driver hands `numeric` back as
 * a string.
 *
 * `date_seconds` and `date_tod` carry the fractional second, as ReQL does — `30.25` where
 * JavaScript's `Date.prototype.getSeconds` would say `30`.
 */
export const DATE_STAGES: StageMap = {
  date_with_timezone: TimezoneStage,
  date_epoch: EpochStage,
  date_during: DuringStage,
  date_tod: LocalStage(SinceMidnight),
  ...BuildStages(DATE_PARTS, PartStage),
};
