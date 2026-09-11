import { ImplementInterface } from "@antelopejs/interface-core";

import type { Options } from "./config";
import { Connect, Disconnect } from "./connection";

export type { MigrationMode, Options } from "./config";

export async function construct(options?: Options) {
  await Connect(options);
  (await import("./implementations/database/reaper")).StartReaper();

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
