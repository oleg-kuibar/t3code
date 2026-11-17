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

/**
 * The SSH environments an organization's policy offers this user once. An offer stays listed until
 * the user saves its host, by connecting it or by hand, or dismisses it. Either consumes it for
 * good, so removing the saved environment later keeps it removed.
 */
export class ManagedSeeds extends Context.Service<
  ManagedSeeds,
  {
    /** Seeds for the Environments list: not consumed, and no saved SSH route reaches their host. */
    readonly offers: SubscriptionRef.SubscriptionRef<ReadonlyArray<DesktopManagedSeed>>;
    readonly dismiss: (seedId: string) => Effect.Effect<void, ManagedSeedsError>;
    /**
     * Consumes every pending seed one of the environment's SSH routes reaches. Run before removing
     * it, so a consume that failed when it was saved cannot bring the offer back.
     */
    readonly consumeSavedBy: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<void, ManagedSeedsError>;
  }
>()("@t3tools/web/connection/managedSeeds") {}

/** Same alias or host name, with no conflicting user or port; ssh's default port is 22. */
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

/** Splits pending seeds by whether any saved SSH route, primary or alternate, reaches their host. */
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
  // Without these bridge methods (the browser, an older desktop app) nothing is ever offered.
  const getManagedSeeds = window.desktopBridge?.getManagedSeeds ?? (async () => []);
  const consumeManagedSeed = window.desktopBridge?.consumeManagedSeed ?? (async () => {});
  // Desktop main owns the ledger, so this copy is only ever replaced from it, never edited.
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
  // The one place a saved host consumes a seed: connecting the offer, adding the same host by
  // hand, and a save that landed just before a crash all look the same here.
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
