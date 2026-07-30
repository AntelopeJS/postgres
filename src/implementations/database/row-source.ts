import { Cast, WithDefault } from "./coerce";
import type { TableShape } from "./fields";
import { type Compiled, QuoteIdentifier, QuoteLiteral } from "./sql";
import { JsonOf, OPAQUE, type SqlShape, type SqlType, TEXT } from "./types";
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
    const spec = this.table.fields[name];
    if (spec) {
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
    const entries = [QuoteLiteral(ID_COLUMN), this.column(ID_COLUMN)];
    for (const [name, spec] of Object.entries(this.table.fields)) {
      entries.push(QuoteLiteral(name), this.column(spec.column));
    }
    const built = `jsonb_strip_nulls(jsonb_build_object(${entries.join(", ")}))`;
    return {
      sql: `(${built} || ${this.column(EXTRA_COLUMN)})`,
      type: JsonOf(this.shape()),
    };
  }

  public shape(): SqlShape {
    const shape: Record<string, SqlType> = { [ID_COLUMN]: TEXT };
    for (const [name, spec] of Object.entries(this.table.fields)) {
      shape[name] = spec.type;
    }
    return shape;
  }

  private column(name: string): string {
    return `${QuoteIdentifier(this.alias)}.${QuoteIdentifier(name)}`;
  }
}

export class JsonRowSource implements RowSource {
  public constructor(private readonly value: Compiled) {}

  public field(name: string, def?: Compiled): Compiled {
    const raw: Compiled = {
      sql: `(${this.value.sql} -> ${QuoteLiteral(name)})`,
      type: OPAQUE,
    };
    return WithDefault(Cast(raw, this.shape()?.[name] ?? OPAQUE), def);
  }

  public dynamicField(key: Compiled, def?: Compiled): Compiled {
    return WithDefault(
      { sql: `(${this.value.sql} -> ${Cast(key, TEXT).sql})`, type: OPAQUE },
      def,
    );
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
