import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { DesktopManagedSeed } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as ManagedSeeds from "../connection/managedSeeds";
import { connectionAtomRuntime } from "../connection/runtime";

const offersAtom = connectionAtomRuntime.atom(
  Stream.unwrap(
    ManagedSeeds.ManagedSeeds.pipe(Effect.map((seeds) => SubscriptionRef.changes(seeds.offers))),
  ),
  { initialValue: [] as ReadonlyArray<DesktopManagedSeed> },
);

export const managedSeeds = {
  offersValueAtom: Atom.make((get) => AsyncResult.getOrElse(get(offersAtom), () => [])).pipe(
    Atom.withLabel("managed-seed-offers"),
  ),
  dismiss: createRuntimeCommand(connectionAtomRuntime, {
    label: "web:managed-seeds:dismiss",
    concurrency: { mode: "singleFlight", key: (seedId: string) => seedId },
    execute: (seedId: string) =>
      ManagedSeeds.ManagedSeeds.pipe(Effect.flatMap((seeds) => seeds.dismiss(seedId))),
  }),
};
