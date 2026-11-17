/**
 * DesktopManagedSeeds - the SSH environments the managed policy offers this user once, and the
 * ledger of the ones they already acted on. The only writer of `managed-seeds.json`.
 *
 * @module DesktopManagedSeeds
 */
import type { DesktopManagedSeed, ManagedPolicyDocument } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "./DesktopManagedPolicy.ts";

const LEDGER_FILE = "managed-seeds.json";

/** Seed ids this user acted on. It only ever grows. */
const SeedLedgerJson = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    consumedSeedIds: Schema.Array(Schema.String),
  }),
);
const decodeLedger = Schema.decodeEffect(SeedLedgerJson);
const encodeLedger = Schema.encodeEffect(SeedLedgerJson);

export class DesktopManagedSeedLedgerError extends Schema.TaggedError<DesktopManagedSeedLedgerError>()(
  "DesktopManagedSeedLedgerError",
  {
    operation: Schema.Literals(["read", "decode", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The managed seed ledger at ${this.path} failed during ${this.operation}.`;
  }
}

export class DesktopManagedSeeds extends Context.Service<
  DesktopManagedSeeds,
  {
    /**
     * The policy's seeds this user has not consumed. Empty without a usable policy, and empty
     * when the ledger cannot be read: offering again what the user removed is worse than nothing.
     */
    readonly pending: Effect.Effect<ReadonlyArray<DesktopManagedSeed>>;
    /** Never offer `seedId` again. Idempotent; an id the policy does not offer is ignored. */
    readonly consume: (seedId: string) => Effect.Effect<void, DesktopManagedSeedLedgerError>;
  }
>()("@t3tools/desktop/app/DesktopManagedSeeds") {}

/** Each seed as the target a manual `user@host:port` add saves, so it connects the same way. */
function pendingSeeds(
  document: ManagedPolicyDocument,
  consumed: ReadonlySet<string>,
): ReadonlyArray<DesktopManagedSeed> {
  return (document.seed?.sshEnvironments ?? [])
    .filter(({ id }) => !consumed.has(id))
    .map((seed) => ({
      seedId: seed.id,
      label: seed.label,
      organization: document.organization,
      target: {
        alias: seed.host,
        hostname: seed.host,
        username: seed.user ?? null,
        port: seed.port ?? null,
      },
    }));
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const policy = yield* DesktopManagedPolicy.DesktopManagedPolicy;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ledgerPath = path.join(environment.stateDir, LEDGER_FILE);
  const lock = yield* Semaphore.make(1);
  const ledgerError = (operation: DesktopManagedSeedLedgerError["operation"]) => (cause: unknown) =>
    new DesktopManagedSeedLedgerError({ operation, path: ledgerPath, cause });

  const document = policy.read.pipe(
    Effect.map((found) => found?.document),
    Effect.catchTags({
      ManagedPolicyFileError: (error) =>
        Effect.logWarning("No policy seeds are offered because the policy cannot be used.", {
          path: error.path,
          reason: error.reason,
        }).pipe(Effect.as(undefined)),
    }),
  );

  // A missing ledger is a new user; an unreadable one is an error, never read as empty.
  const readLedger = fileSystem.readFileString(ledgerPath).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound" ? Effect.undefined : Effect.fail(ledgerError("read")(cause)),
    ),
    Effect.flatMap((raw) =>
      raw === undefined
        ? Effect.succeed(new Set<string>())
        : decodeLedger(raw).pipe(
            Effect.map(({ consumedSeedIds }) => new Set(consumedSeedIds)),
            Effect.mapError(ledgerError("decode")),
          ),
    ),
  );

  const writeLedger = (consumedSeedIds: ReadonlySet<string>) =>
    encodeLedger({ version: 1, consumedSeedIds: [...consumedSeedIds] }).pipe(
      Effect.flatMap((json) =>
        writeFileStringAtomically({ filePath: ledgerPath, contents: `${json}\n` }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(ledgerError("write")),
    );

  const pending = Effect.gen(function* () {
    const current = yield* document;
    if (current?.seed === undefined) return [];
    const consumed = yield* readLedger.pipe(
      Effect.catch((error) =>
        Effect.logWarning("No policy seeds are offered because the seed ledger cannot be read.", {
          error,
        }).pipe(Effect.as(undefined)),
      ),
    );
    return consumed === undefined ? [] : pendingSeeds(current, consumed);
  }).pipe(Effect.withSpan("DesktopManagedSeeds.pending"));

  const consume = Effect.fn("DesktopManagedSeeds.consume")(function* (seedId: string) {
    const current = yield* document;
    if (!current?.seed?.sshEnvironments.some(({ id }) => id === seedId)) return;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const consumed = yield* readLedger;
        if (consumed.has(seedId)) return;
        yield* writeLedger(new Set([...consumed, seedId]));
      }),
    );
  });

  return DesktopManagedSeeds.of({ pending, consume });
});

export const layer = Layer.effect(DesktopManagedSeeds, make);
