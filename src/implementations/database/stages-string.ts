import { DecodeValue } from "./value";
import { type Compiled, Param } from "./sql";
import type { DecodingContext } from "./context";
import { ArrayOf, BOOL, type SqlType, TEXT } from "./types";
import { AsFloat, INT4_MAX, INT4_MIN, Text } from "./readings";
import {
  BuildStages,
  FIRST_OPERAND,
  Lift,
  LiftRaw,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";
import { IsString } from "./guards";
import { OptionsOf } from "./utils";
import { ClassifyMember } from "./member";

interface SplitOptions {
  separator?: string;
  maxSplits?: number;
}

const DEFAULT_SEPARATOR = " ";
const SLICE_START = 1;
const MATCH_OPERATOR = "~";
const CONCAT_OPERATOR = "||";

const CASE_FUNCTIONS = {
  str_upcase: "upper",
  str_downcase: "lower",
};

function CaseStage(name: string): StageHandler {
  return Lift((value) => ({
    sql: `(${name}(${Text(value).sql}))`,
    type: TEXT,
  }));
}

function TextInfix(operator: string, type: SqlType): StageHandler {
  return Lift((value, args, stage) => {
    const other = RequireOperand(args[FIRST_OPERAND], stage, FIRST_OPERAND);
    return {
      sql: `(${Text(value).sql} ${operator} ${Text(other).sql})`,
      type,
    };
  });
}

const LengthStage = Lift((value) => AsFloat(`length(${Text(value).sql})`));

/**
 * The word-boundary assertions, which the two flavours spell differently and both accept.
 * `\b` is a backspace in PostgreSQL's ARE, so an untranslated pattern silently matches nothing.
 */
const WORD_BOUNDARIES = new Map([
  ["b", "\\y"],
  ["B", "\\Y"],
]);

const CLASS_OPEN = "[";
const CLASS_CLOSE = "]";
const ESCAPE = "\\";

/**
 * What JavaScript's `.` means, spelled as a class ARE reads the same way.
 * ARE's `.` matches a newline where JavaScript's declines all four line terminators.
 */
const JS_DOT = "[^\n\r\u2028\u2029]";
const DOT = ".";

/**
 * Rewrites a JavaScript-flavoured pattern into the one `~` reads, tracking escapes and classes.
 * Only a *literal* pattern reaches this; a computed one is bound as a parameter and left alone.
 */
function Translated(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at];
    if (char === ESCAPE && at + 1 < pattern.length) {
      const escaped = pattern[at + 1];
      const boundary = inClass ? undefined : WORD_BOUNDARIES.get(escaped);
      out += boundary ?? char + escaped;
      at++;
      continue;
    }
    if (char === DOT && !inClass) {
      out += JS_DOT;
      continue;
    }
    inClass = inClass ? char !== CLASS_CLOSE : char === CLASS_OPEN;
    out += char;
  }
  return out;
}

const MatchStage = LiftRaw((value, stage, context) => {
  const raw: unknown = stage.args[FIRST_OPERAND];
  const pattern = IsString(raw)
    ? Param(context.params, Translated(raw), TEXT)
    : RequireOperand(
        DecodeValue(ClassifyMember(raw), context),
        stage,
        FIRST_OPERAND,
      );
  return {
    sql: `(${Text(value).sql} ${MATCH_OPERATOR} ${Text(pattern).sql})`,
    type: BOOL,
  };
});

function Separator(options: SplitOptions, context: DecodingContext): Compiled {
  return Param(context.params, options.separator ?? DEFAULT_SEPARATOR, TEXT);
}

function SliceBound(maxSplits: number): number {
  return Math.min(Math.max(Math.trunc(maxSplits), INT4_MIN), INT4_MAX);
}

function Truncated(array: string, maxSplits?: number): string {
  if (maxSplits === undefined || Number.isNaN(maxSplits)) {
    return array;
  }
  return `(${array})[${SLICE_START}:${SliceBound(maxSplits)}]`;
}

const SplitStage = LiftRaw((value, stage, context) => {
  const options: SplitOptions = OptionsOf(stage) ?? {};
  const separator = Separator(options, context).sql;
  const array = `string_to_array(${Text(value).sql}, ${separator})`;
  return {
    sql: `(to_jsonb(${Truncated(array, options.maxSplits)}))`,
    type: ArrayOf(TEXT),
  };
});

/**
 * String stages.
 *
 * Every operand is read through `Text`, which for a jsonb source is the projection guarded on
 * `jsonb_typeof(…) = 'string'` — so a stored number yields NULL rather than its decimal spelling,
 * which is what keeps a heterogeneous overflow key from silently comparing equal across types.
 * For a `timestamp` operand it is the explicit ISO 8601 rendering in UTC, so none of these
 * stages reads differently under a different session `TimeZone` or `DateStyle`.
 *
 * Three shapes are deliberate rather than incidental:
 *
 * - `str_len` counts *codepoints*, which is what `length()` does and what the contract documents.
 *   JavaScript's `String.length` counts UTF-16 code units, so the two disagree on an
 *   astral-plane character. It ends `::double precision` because `length()` returns `integer`.
 * - `str_concat` is a bare `||`, so a NULL operand poisons the whole result. A missing field
 *   yielding NULL rather than the other operand is the intended reading.
 * - `str_match` yields a boolean, as the contract documents, rather than ReQL's match object.
 *   `~` is PostgreSQL's advanced regular expression flavour (ARE), which is not JavaScript's: it
 *   rejects a named capture group at *runtime* with `2201B`, reads `\b` as a backspace rather than
 *   as a word boundary, and lets `.` match a newline. A **literal** pattern is rewritten by
 *   {@link Translated} for the last two; a pattern computed from a value is bound untranslated.
 *
 * `str_split` carries its separator and its bound in `stage.options` and takes no arguments at
 * all, which is why it is lifted raw. `maxSplits` truncates the result rather than reproducing
 * ReQL's "remainder in the last element", and its bound is clamped to the int4 range: a slice
 * subscript is an `integer`, so an unclamped `3e9` raises `22003` and loses the whole statement.
 * Only `NaN` names no bound at all; `Infinity` clamps to the whole array and a negative bound to
 * an empty one.
 */
export const STRING_STAGES: StageMap = {
  ...BuildStages(CASE_FUNCTIONS, CaseStage),
  str_len: LengthStage,
  str_concat: TextInfix(CONCAT_OPERATOR, TEXT),
  str_match: MatchStage,
  str_split: SplitStage,
};
