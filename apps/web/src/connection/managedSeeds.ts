import {
  type ConnectionCatalogEntry,
  connectionRoutes,
  EnvironmentRegistry,
} from "@t3tools/client-runtime/connection";
import type {
  DesktopManagedSeed,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

const FAILURE_MESSAGES = {
  load: "Could not load the environments your organization offers.",
  save: "Could not record that an offered environment was saved.",
  dismiss: "Could not dismiss this environment. Try again.",
  remove: "Could not remove this environment. Try again.",
} as const;

export class ManagedSeedsError extends Schema.TaggedError<ManagedSeedsError>()(
  "ManagedSeedsError",
  {
    reason: Schema.Literals(["load", "save", "dismiss", "remove"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return FAILURE_MESSAGES[this.reason];
  }
}

/** An offer stays until its host is saved or it is dismissed; either consumes it for good. */
export class ManagedSeeds extends Context.Service<
  ManagedSeeds,
  {
    readonly offers: SubscriptionRef.SubscriptionRef<ReadonlyArray<DesktopManagedSeed>>;
    readonly dismiss: (seedId: string) => Effect.Effect<void, ManagedSeedsError>;
    readonly consumeSavedBy: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ManagedSeedsError>;
  }
>()("@t3tools/web/connection/managedSeeds") {}

export function isSameSshHost(
  seed: DesktopSshEnvironmentTarget,
  saved: DesktopSshEnvironmentTarget,
): boolean {
  return (
    (seed.alias === saved.alias || seed.hostname.toLowerCase() === saved.hostname.toLowerCase()) &&
    (seed.username === null || saved.username === null || seed.username === saved.username) &&
    (seed.port ?? 22) === (saved.port ?? 22)
  );
}

export function partitionSeeds(
  pending: ReadonlyArray<DesktopManagedSeed>,
  entries: Iterable<ConnectionCatalogEntry>,
): {
  readonly offered: ReadonlyArray<DesktopManagedSeed>;
  readonly alreadySaved: ReadonlyArray<DesktopManagedSeed>;
} {
  const saved = [...entries].flatMap(connectionRoutes).flatMap(({ profile }) => {
    const value = Option.getOrUndefined(profile);
    return value?._tag === "SshConnectionProfile" ? [value.target] : [];
  });
  const offered: DesktopManagedSeed[] = [];
  const alreadySaved: DesktopManagedSeed[] = [];
  for (const seed of pending) {
    (saved.some((target) => isSameSshHost(seed.target, target)) ? alreadySaved : offered).push(
      seed,
    );
  }
  return { offered, alreadySaved };
}

const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const getManagedSeeds = window.desktopBridge?.getManagedSeeds ?? (async () => []);
  const consumeManagedSeed = window.desktopBridge?.consumeManagedSeed ?? (async () => {});
  const pending = yield* SubscriptionRef.make<ReadonlyArray<DesktopManagedSeed>>([]);
  const offers = yield* SubscriptionRef.make<ReadonlyArray<DesktopManagedSeed>>([]);

  const fetchPending = (reason: ManagedSeedsError["reason"]) =>
    Effect.tryPromise({
      try: () => getManagedSeeds(),
      catch: (cause) => new ManagedSeedsError({ reason, cause }),
    });
  const reload = fetchPending("load").pipe(
    Effect.flatMap((seeds) => SubscriptionRef.set(pending, seeds)),
    Effect.catch((error) => Effect.logWarning(error.message, { cause: error.cause })),
  );
  const consume = Effect.fn("ManagedSeeds.consume")(function* (
    seedId: string,
    reason: ManagedSeedsError["reason"],
  ) {
    yield* Effect.tryPromise({
      try: () => consumeManagedSeed(seedId),
      catch: (cause) => new ManagedSeedsError({ reason, cause }),
    });
    yield* reload;
  });

  const dismiss = Effect.fn("ManagedSeeds.dismiss")(function* (seedId: string) {
    yield* consume(seedId, "dismiss");
  });

  const consumeSavedBy = Effect.fn("ManagedSeeds.consumeSavedBy")(function* (
    environmentId: EnvironmentId,
  ) {
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
    if (entry === undefined) return;
    // Main's list rather than the cached one, which is still empty right after launch.
    const { alreadySaved } = partitionSeeds(yield* fetchPending("remove"), [entry]);
    yield* Effect.forEach(alreadySaved, ({ seedId }) => consume(seedId, "remove"), {
      discard: true,
    });
  });

  yield* reload.pipe(Effect.forkScoped);
  // The only consume-on-save path, for a connected offer, a manual add, and a pre-crash save.
  yield* Stream.zipLatest(
    SubscriptionRef.changes(pending),
    SubscriptionRef.changes(registry.entries),
  ).pipe(
    Stream.runForEach(([seeds, entries]) =>
      Effect.gen(function* () {
        const { offered, alreadySaved } = partitionSeeds(seeds, entries.values());
        yield* SubscriptionRef.set(offers, offered);
        yield* Effect.forEach(
          alreadySaved,
          ({ seedId }) =>
            consume(seedId, "save").pipe(
              Effect.catch((error) =>
                Effect.logWarning(`${error.message} It is retried at the next launch.`, {
                  cause: error.cause,
                }),
              ),
            ),
          { discard: true },
        );
      }),
    ),
    Effect.forkScoped,
  );

  return ManagedSeeds.of({ offers, dismiss, consumeSavedBy });
});

export const layer = Layer.effect(ManagedSeeds, make);
