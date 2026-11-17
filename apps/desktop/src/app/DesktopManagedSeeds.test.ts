import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import { ManagedPolicyFileError } from "@t3tools/shared/managedPolicyFile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "./DesktopManagedPolicy.ts";
import * as DesktopManagedSeeds from "./DesktopManagedSeeds.ts";

const policy: ManagedPolicyDocument = {
  schemaVersion: 1,
  organization: "Acme",
  seed: {
    sshEnvironments: [
      { id: "acme.build-1", label: "Build 1", host: "build1.acme.internal", user: "dev", port: 22 },
      { id: "acme.build-2", label: "Build 2", host: "build2" },
    ],
  },
};

const layerFor = (
  homeDirectory: string,
  managedPolicy?: ManagedPolicyDocument | ManagedPolicyFileError,
) =>
  DesktopManagedSeeds.layer.pipe(
    Layer.provideMerge(DesktopManagedPolicy.layerTest(managedPolicy)),
    Layer.provideMerge(
      DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            DesktopConfig.layerTest({ T3CODE_HOME: homeDirectory }),
          ),
        ),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** Each call is a fresh app launch over the same T3 home. */
const launch = <A, E>(
  homeDirectory: string,
  managedPolicy: ManagedPolicyDocument | ManagedPolicyFileError | undefined,
  run: (
    seeds: DesktopManagedSeeds.DesktopManagedSeeds["Service"],
    ledgerPath: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const seeds = yield* DesktopManagedSeeds.DesktopManagedSeeds;
    const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
    const path = yield* Path.Path;
    return yield* run(seeds, path.join(stateDir, "managed-seeds.json"));
  }).pipe(Effect.provide(layerFor(homeDirectory, managedPolicy)));

const pendingIds = (seeds: DesktopManagedSeeds.DesktopManagedSeeds["Service"]) =>
  seeds.pending.pipe(Effect.map((pending) => pending.map(({ seedId }) => seedId)));

const withHome = <A, E>(
  test: (homeDirectory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* test(yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-managed-seeds-" }));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("DesktopManagedSeeds", () => {
  it.effect("offers each policy seed as an SSH target until it is consumed, across launches", () =>
    withHome((home) =>
      Effect.gen(function* () {
        yield* launch(home, policy, (seeds) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* seeds.pending, [
              {
                seedId: "acme.build-1",
                label: "Build 1",
                organization: "Acme",
                target: {
                  alias: "build1.acme.internal",
                  hostname: "build1.acme.internal",
                  username: "dev",
                  port: 22,
                },
              },
              {
                seedId: "acme.build-2",
                label: "Build 2",
                organization: "Acme",
                target: { alias: "build2", hostname: "build2", username: null, port: null },
              },
            ]);
            yield* seeds.consume("acme.build-1");
            yield* seeds.consume("acme.build-1");
            yield* seeds.consume("not-in-policy");
            assert.deepStrictEqual(yield* pendingIds(seeds), ["acme.build-2"]);
          }),
        );

        assert.deepStrictEqual(
          yield* launch(home, policy, (seeds, ledgerPath) =>
            Effect.gen(function* () {
              const ledger = JSON.parse(
                yield* (yield* FileSystem.FileSystem).readFileString(ledgerPath),
              );
              return { pending: yield* pendingIds(seeds), ledger };
            }),
          ),
          {
            pending: ["acme.build-2"],
            ledger: { version: 1, consumedSeedIds: ["acme.build-1"] },
          },
        );
      }),
    ),
  );

  it.effect("offers nothing without a usable policy, and leaves the ledger alone", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const unusable = new ManagedPolicyFileError({ path: "/test/policy.json", reason: "bad" });
        for (const managedPolicy of [
          undefined,
          unusable,
          { schemaVersion: 1, organization: "Acme" } as const,
        ]) {
          assert.deepStrictEqual(
            yield* launch(home, managedPolicy, (seeds) =>
              Effect.gen(function* () {
                yield* seeds.consume("acme.build-1");
                return yield* seeds.pending;
              }),
            ),
            [],
          );
        }
        assert.deepStrictEqual(yield* launch(home, policy, pendingIds), [
          "acme.build-1",
          "acme.build-2",
        ]);
      }),
    ),
  );

  it.effect("offers nothing when the ledger cannot be read, and never overwrites it", () =>
    withHome((home) =>
      Effect.gen(function* () {
        const result = yield* launch(home, policy, (seeds, ledgerPath) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* fileSystem.makeDirectory((yield* Path.Path).dirname(ledgerPath), {
              recursive: true,
            });
            yield* fileSystem.writeFileString(ledgerPath, "{ not json");
            const consumed = yield* Effect.flip(seeds.consume("acme.build-1"));
            return {
              pending: yield* seeds.pending,
              consumeFailure: consumed.operation,
              ledger: yield* fileSystem.readFileString(ledgerPath),
            };
          }),
        );
        assert.deepStrictEqual(result, {
          pending: [],
          consumeFailure: "decode",
          ledger: "{ not json",
        });
      }),
    ),
  );
});
