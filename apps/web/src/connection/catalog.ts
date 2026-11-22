import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ManagedSeeds from "./managedSeeds";
import { connectionAtomRuntime } from "./runtime";

const catalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);

export const environmentCatalog = {
  ...catalog,
  // Consume first, so a consume that failed at save time cannot re-offer the removed seed.
  remove: createRuntimeCommand(connectionAtomRuntime, {
    label: "environment-catalog:remove",
    concurrency: { mode: "serial", key: () => "environment-catalog" },
    execute: Effect.fn("web.environmentCatalog.remove")(function* (environmentId: EnvironmentId) {
      yield* (yield* ManagedSeeds.ManagedSeeds).consumeSavedBy(environmentId);
      yield* (yield* EnvironmentRegistry.EnvironmentRegistry).remove(environmentId);
    }),
  }),
};
