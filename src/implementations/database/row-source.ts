import { Cast, WithDefault } from "./coerce";
import type { TableShape } from "./fields";
import { type Compiled, QuoteIdentifier, QuoteLiteral } from "./sql";
import {
  IsJsonBacked,
  JsonOf,
  OPAQUE,
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

export class ColumnRowSource implements RowSource {
  public constructor(
    private readonly alias: string,
    private readonly table: TableShape,
  ) {}

  public field(name: string, def?: Compiled): Compiled {
    if (name === ID_COLUMN) {
      return WithDefault({ sql: this.column(ID_COLUMN), type: TEXT }, def);
    }
    if (Object.hasOwn(this.table.fields, name)) {
      const spec = this.table.fields[name];
      return WithDefault(
        { sql: this.column(spec.column), type: spec.type },
        def,
      );
    }
    return WithDefault(
      {
        sql: `(${this.column(EXTRA_COLUMN)} -> ${QuoteLiteral(name)})`,
        type: OPAQUE,
      },
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

  public toJson(): Compiled {
    const scalars = [QuoteLiteral(ID_COLUMN), this.column(ID_COLUMN)];
    const containers: string[] = [];
    for (const [name, spec] of Object.entries(this.table.fields)) {
      if (IsJsonBacked(spec.type)) {
        containers.push(this.container(name, spec.column));
        continue;
      }
      scalars.push(QuoteLiteral(name), this.column(spec.column));
    }
    const base = `jsonb_strip_nulls(jsonb_build_object(${scalars.join(", ")}))`;
    const parts = [
      base,
      ...containers,
      `COALESCE(${this.column(EXTRA_COLUMN)}, '{}'::jsonb)`,
    ];
    return { sql: `(${parts.join(" || ")})`, type: JsonOf(this.shape()) };
  }

  public shape(): SqlShape {
    const shape: Record<string, SqlType> = { [ID_COLUMN]: TEXT };
    for (const [name, spec] of Object.entries(this.table.fields)) {
      shape[name] = spec.type;
    }
    return shape;
  }

  private container(name: string, column: string): string {
    const ref = this.column(column);
    const built = `jsonb_build_object(${QuoteLiteral(name)}, ${ref})`;
    return `(CASE WHEN ${ref} IS NULL THEN '{}'::jsonb ELSE ${built} END)`;
  }

  private column(name: string): string {
    return `${QuoteIdentifier(this.alias)}.${QuoteIdentifier(name)}`;
  }
}

export class JsonRowSource implements RowSource {
  public constructor(private readonly value: Compiled) {}

  public field(name: string, def?: Compiled): Compiled {
    const raw: Compiled = {
      sql: `(${this.toJson().sql} -> ${QuoteLiteral(name)})`,
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
    return this.value.type.kind === "json" ? this.value.type.shape : undefined;
  }
}
