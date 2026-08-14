import { Cast, WithDefault } from "./coerce";
import { DocumentKeys, type TableShape } from "./fields";
import { Defaulted, StoredAs } from "./readings";
import {
  type Compiled,
  JSON_NULL,
  JsonKey,
  QualifiedColumn,
  QuoteLiteral,
} from "./sql";
import {
  IsJsonBacked,
  JsonOf,
  OPAQUE,
  ShapeOf,
  type SqlShape,
  type SqlType,
  TEXT,
} from "./types";
import { EXTRA_COLUMN, ID_COLUMN } from "./utils";

/**
 * Field access over a row, so the same expression compiler works against native typed columns
 * and against a jsonb value.
 */
export interface RowSource {
  field(name: string, def?: Compiled): Compiled;
  dynamicField(key: Compiled, def?: Compiled): Compiled;
  toJson(): Compiled;
  shape(): SqlShape | undefined;
}

export interface DocumentMember extends Compiled {
  name: string;
}

function MemberShape(members: DocumentMember[]): SqlShape {
  const shape: Record<string, SqlType> = {};
  for (const member of members) {
    shape[member.name] = member.type;
  }
  return shape;
}

function ContainerMember(member: DocumentMember): string {
  const built = `jsonb_build_object(${QuoteLiteral(member.name)}, ${member.sql})`;
  return `(CASE WHEN ${member.sql} IS NULL THEN '{}'::jsonb ELSE ${built} END)`;
}

/**
 * Materializes named members as one jsonb document.
 *
 * Scalar members are stripped of nulls, so a NULL column reads as an absent key. Jsonb-backed
 * members are merged in separately under a null guard instead, because `jsonb_strip_nulls`
 * recurses and would otherwise delete nulls the caller stored inside their own value.
 *
 * `overflow` is merged last, for the unstructured column a table carries beside its declared
 * fields; a projection over a subset of the fields passes nothing. Its keys are unknown, so they
 * are absent from the returned type, which describes the named members only.
 *
 * A jsonb-backed member's sql is emitted twice — once by its guard — so pass an operand that is
 * cheap for the database to evaluate.
 */
export function BuildDocument(
  members: DocumentMember[],
  overflow?: string,
): Compiled {
  const scalars: string[] = [];
  const containers: string[] = [];
  for (const member of members) {
    if (IsJsonBacked(member.type)) {
      containers.push(ContainerMember(member));
      continue;
    }
    scalars.push(QuoteLiteral(member.name), member.sql);
  }
  const stripped = `jsonb_strip_nulls(jsonb_build_object(${scalars.join(", ")}))`;
  const parts = [stripped, ...containers];
  if (overflow) {
    parts.push(overflow);
  }
  return { sql: `(${parts.join(" || ")})`, type: JsonOf(MemberShape(members)) };
}

/** Names a key in the message {@link Defaulted} raises for a default the column cannot hold. */
function KeySubject(name: string): string {
  return `The default for key '${name}'`;
}

/**
 * How a row source reaches one physical column, *as* the type that column holds.
 *
 * The one thing a table row and a logged row disagree about, and therefore the whole of the seam
 * between them. It answers a `Compiled` rather than a bare name because the two differ in type as
 * well as in text: a table's column already **is** its declared type, while a logged one is a jsonb
 * member that has to be read as that type. Returning a name alone would let a jsonb value be
 * labelled `float` and compared as one, which is a wrong answer rather than an error.
 */
export type ColumnAddress = (column: string, type: SqlType) => Compiled;

/** A column of a real table row, which already is the type it was declared as. */
export function AliasedColumns(alias: string): ColumnAddress {
  return (column, type) => ({ sql: QualifiedColumn(alias, column), type });
}

/**
 * A logged jsonb member read as the column it came from: a json `null` is the column being absent.
 * Lossless, since a declared jsonb-backed column cannot hold a stored json null in the first place.
 */
function Present(member: Compiled): Compiled {
  return { sql: `NULLIF(${member.sql}, ${JSON_NULL})`, type: member.type };
}

/**
 * A column of a **logged** row — a physical row stored whole in jsonb by the change log.
 *
 * Every member is read through `readings.ts:StoredAs`, which is the same table the write path
 * stores through and the expression compiler reads columns back through. A bare cast
 * would be wrong in the one direction that matters: a cast to a scalar is total only
 * *from a jsonb source*, which is exactly what this is, and `StoredAs` is where that
 * knowledge already lives rather than something to restate here.
 *
 * The row expression is spelled once per member, so pass one that is cheap — a column of the log,
 * never an assembled document.
 */
export function LoggedColumns(row: string): ColumnAddress {
  return (column, type) => {
    const member: Compiled = { sql: JsonKey(row, column), type: OPAQUE };
    return StoredAs(IsJsonBacked(type) ? Present(member) : member, type);
  };
}

export class ColumnRowSource implements RowSource {
  public constructor(
    private readonly address: ColumnAddress,
    private readonly table: TableShape,
  ) {}

  public field(name: string, def?: Compiled): Compiled {
    if (name === ID_COLUMN) {
      return Defaulted(this.address(ID_COLUMN, TEXT), def, KeySubject(name));
    }
    if (Object.hasOwn(this.table.fields, name)) {
      const spec = this.table.fields[name];
      return Defaulted(
        this.address(spec.column, spec.type),
        def,
        KeySubject(name),
      );
    }
    return WithDefault(
      { sql: JsonKey(this.overflow(), name), type: OPAQUE },
      def,
    );
  }

  private overflow(): string {
    return this.address(EXTRA_COLUMN, OPAQUE).sql;
  }

  public dynamicField(key: Compiled, def?: Compiled): Compiled {
    const document = this.toJson().sql;
    return WithDefault(
      { sql: `(${document} -> ${Cast(key, TEXT).sql})`, type: OPAQUE },
      def,
    );
  }

  private members(): DocumentMember[] {
    return DocumentKeys(this.table).map((name) => ({
      name,
      ...this.field(name),
    }));
  }

  public toJson(): Compiled {
    const overflow = `COALESCE(${this.overflow()}, '{}'::jsonb)`;
    return BuildDocument(this.members(), overflow);
  }

  public shape(): SqlShape {
    return MemberShape(this.members());
  }
}

/**
 * A row source whose *document* is null when the row it addresses is not there, which is what a
 * missed `LEFT JOIN` row must read as.
 *
 * Only {@link RowSource.toJson} needs fixing: a field of a missed row is already SQL NULL, where
 * the document over all-NULL columns would be `{}`. `_id` is the test, being `NOT NULL` on any row.
 */
export class NullableRowSource implements RowSource {
  public constructor(private readonly inner: RowSource) {}

  public field(name: string, def?: Compiled): Compiled {
    return this.inner.field(name, def);
  }

  public dynamicField(key: Compiled, def?: Compiled): Compiled {
    return this.inner.dynamicField(key, def);
  }

  public toJson(): Compiled {
    const document = this.inner.toJson();
    const present = this.inner.field(ID_COLUMN).sql;
    return {
      sql: `(CASE WHEN ${present} IS NOT NULL THEN ${document.sql} END)`,
      type: document.type,
    };
  }

  public shape(): SqlShape | undefined {
    return this.inner.shape();
  }
}

export class JsonRowSource implements RowSource {
  public constructor(private readonly value: Compiled) {}

  public field(name: string, def?: Compiled): Compiled {
    const raw: Compiled = {
      sql: JsonKey(this.toJson().sql, name),
      type: OPAQUE,
    };
    return WithDefault(Cast(raw, this.fieldType(name)), def);
  }

  public dynamicField(key: Compiled, def?: Compiled): Compiled {
    return WithDefault(
      { sql: `(${this.toJson().sql} -> ${Cast(key, TEXT).sql})`, type: OPAQUE },
      def,
    );
  }

  private fieldType(name: string): SqlType {
    const shape = this.shape();
    if (!shape || !Object.hasOwn(shape, name)) {
      return OPAQUE;
    }
    return shape[name];
  }

  public toJson(): Compiled {
    return Cast(
      this.value,
      this.value.type.kind === "json" ? this.value.type : OPAQUE,
    );
  }

  public shape(): SqlShape | undefined {
    return ShapeOf(this.value.type);
  }
}
