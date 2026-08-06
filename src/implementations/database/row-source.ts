import { Cast, WithDefault } from "./coerce";
import { DocumentKeys, type TableShape } from "./fields";
import { Defaulted } from "./readings";
import { type Compiled, JsonKey, QualifiedColumn, QuoteLiteral } from "./sql";
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

export class ColumnRowSource implements RowSource {
  public constructor(
    private readonly alias: string,
    private readonly table: TableShape,
  ) {}

  public field(name: string, def?: Compiled): Compiled {
    if (name === ID_COLUMN) {
      return Defaulted(
        { sql: this.column(ID_COLUMN), type: TEXT },
        def,
        KeySubject(name),
      );
    }
    if (Object.hasOwn(this.table.fields, name)) {
      const spec = this.table.fields[name];
      return Defaulted(
        { sql: this.column(spec.column), type: spec.type },
        def,
        KeySubject(name),
      );
    }
    return WithDefault(
      { sql: JsonKey(this.column(EXTRA_COLUMN), name), type: OPAQUE },
      def,
    );
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
    const overflow = `COALESCE(${this.column(EXTRA_COLUMN)}, '{}'::jsonb)`;
    return BuildDocument(this.members(), overflow);
  }

  public shape(): SqlShape {
    return MemberShape(this.members());
  }

  private column(name: string): string {
    return QualifiedColumn(this.alias, name);
  }
}

/**
 * A row source whose *document* is null when the row it addresses is not there, which is what a
 * missed `LEFT JOIN` row must read as.
 *
 * Everything but {@link RowSource.toJson} delegates untouched, and that is the whole design rather
 * than an economy. Every column of a missed row is already SQL NULL, so a field of it answers
 * `null` with no help and stays a bare column a btree index can serve; the one reading that needs
 * fixing is the whole document, because {@link BuildDocument} over all-NULL columns is `{}` — a
 * materialized empty object where the caller was promised nothing. Guarding the value instead
 * would spell the guarded document again for every field the caller touches, which is invariant
 * 11's argument one layer up.
 *
 * `_id` is the test because it is `NOT NULL` on every row this adapter writes, so it is the one
 * exact reading of "there was no right row"; a nullable declared column cannot tell a miss from a
 * stored null. It is resolved through {@link RowSource.field}, which handles it explicitly —
 * invariant 3 makes it absent from the shape.
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
