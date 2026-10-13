import { ImplementInterface } from "@antelopejs/interface-core";

import { IsExternal, type Options } from "./config";
import { Connect, Disconnect } from "./connection";

export type { MigrationMode, Mode, Options } from "./config";

export async function construct(options?: Options) {
  await Connect(options);
  if (!IsExternal()) {
    (await import("./implementations/database/reaper")).StartReaper();
  }

  void ImplementInterface(
    await import("@antelopejs/interface-database/query"),
    await import("./implementations/database/query"),
  );
  void ImplementInterface(
    await import("@antelopejs/interface-database/schema"),
    await import("./implementations/database/schema"),
  );
}

export async function destroy() {
  await Disconnect();
}
