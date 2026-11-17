import { DesktopManagedSeedSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopManagedSeeds from "../../app/DesktopManagedSeeds.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const getManagedSeeds = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_MANAGED_SEEDS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopManagedSeedSchema),
  handler: Effect.fn("desktop.ipc.managedSeeds.get")(function* () {
    return yield* (yield* DesktopManagedSeeds.DesktopManagedSeeds).pending;
  }),
});

export const consumeManagedSeed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONSUME_MANAGED_SEED_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.managedSeeds.consume")(function* (seedId) {
    yield* (yield* DesktopManagedSeeds.DesktopManagedSeeds).consume(seedId);
  }),
});
