import type { DecodingContext } from "./context";
import { AsFloat, INT4_MAX, INT4_MIN, Text } from "./readings";
import { type Compiled, Param } from "./sql";
import {
  BuildStages,
  FIRST_OPERAND,
  Lift,
  LiftRaw,
  RequireOperand,
  type StageHandler,
  type StageMap,
} from "./stage";
import { ArrayOf, BOOL, type SqlType, TEXT } from "./types";
import { DecodeValue } from "./value";

interface SplitOptions {
  separator?: string;
  maxSplits?: number;
}

const DEFAULT_SEPARATOR = " ";
const SLICE_START = 1;
const MATCH_OPERATOR = "~";
const CONCAT_OPERATOR = "||";

const CASE_FUNCTIONS: Record<string, string> = {
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
 *
 * `\b` is a **backspace** in PostgreSQL's ARE, not a boundary, so `'foo bar' ~ '\bbar\b'` is false
 * and `match("\\bfoo\\b")` matched nothing on any input, ever. Silent in both directions: the
 * pattern is accepted, the answer is just always no.
 */
const WORD_BOUNDARIES: Record<string, string> = {
  b: "\\y",
  B: "\\Y",
};

const CLASS_OPEN = "[";
const CLASS_CLOSE = "]";
const ESCAPE = "\\";

/**
 * What JavaScript's `.` means, spelled as a class ARE reads the same way.
 *
 * ARE's `.` matches a newline and JavaScript's does not without the `s` flag, which is silent and
 * on the most common construct in the language: `match("^a.*z$")` answered rows a caller expects it
 * to skip. Neither embedded option corrects it — `(?p)` makes `.` newline-sensitive but makes
 * `[^a]` newline-sensitive with it, where the two flavours agree today, and `(?n)` additionally
 * makes `^` match after a newline, which is JavaScript's `m` flag. Translating the construct leaves
 * every other construct alone, which is what those options could not do.
 *
 * All four codepoints, not just `\n`: JavaScript's `.` declines `\r` and the two line separators as
 * well, and they cost the same to exclude because the pattern is a bound parameter — the class
 * carries the characters themselves and no escaping question arises. Verified against 18.4: this
 * class excludes exactly those four and matches everything else.
 */
const JS_DOT = "[^\n\r\u2028\u2029]";
const DOT = ".";

/**
 * Rewrites a JavaScript-flavoured pattern into the one `~` reads.
 *
 * **`match` is a different regex language, not a superset with one hole**, and the two flavours
 * agree on far more than they disagree — `\d`, `\w`, lookaround and non-greedy quantifiers all mean
 * the same thing — which is what makes the disagreements worth translating rather than documenting.
 * A caller who writes `\bfoo\b` has written the common spelling of the common intent.
 *
 * The scan tracks two states, and **both translations need both of them**. **Escape**: `\\b` is a
 * literal backslash followed by `b`, and `\.` is a literal dot; a search-and-replace over the text
 * corrupts each. **Character class**: inside `[…]` both flavours already read `\b` as a backspace
 * and a `.` as an ordinary dot, so translating there would change a pattern that agrees into one
 * that does not — and rewriting a `.` to {@link JS_DOT} inside a class would not even parse. The
 * class is delimited by JavaScript's rules, since that is the language the pattern was written in.
 *
 * Only a *literal* pattern reaches this. A pattern computed from a value is bound as a parameter
 * whose text no compiler here has, and rewriting it in SQL would mean reimplementing this scan in
 * `regexp_replace` against a pattern that may not even be a constant.
 */
function Translated(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at];
    if (char === ESCAPE && at + 1 < pattern.length) {
      const escaped = pattern[at + 1];
      const boundary = inClass ? undefined : WORD_BOUNDARIES[escaped];
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
  const raw = stage.args[FIRST_OPERAND];
  const pattern =
    typeof raw === "string"
      ? Param(context.params, Translated(raw), TEXT)
      : RequireOperand(DecodeValue(raw, context), stage, FIRST_OPERAND);
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
  const options: SplitOptions = stage.options ?? {};
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
