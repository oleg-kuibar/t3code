/**
 * DesktopManagedPolicy - the administrator's managed policy as the desktop app reads it, at most
 * once: every desktop check needs the same answer.
 *
 * @module DesktopManagedPolicy
 */
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import {
  layerWindowsRegistry,
  ManagedPolicyFileError,
  readManagedPolicy,
  readManagedPolicyFile,
  WindowsRegistry,
} from "@t3tools/shared/managedPolicyFile";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";

type FoundPolicy = Effect.Success<ReturnType<typeof readManagedPolicy>>;
const isManagedPolicyFileError = Schema.is(ManagedPolicyFileError);

export class DesktopManagedPolicy extends Context.Service<
  DesktopManagedPolicy,
  {
    /** The policy on this machine, undefined without one; fails when it cannot be used. */
    readonly read: Effect.Effect<FoundPolicy, ManagedPolicyFileError>;
  }
>()("@t3tools/desktop/app/DesktopManagedPolicy") {}

export const layer = Layer.effect(
  DesktopManagedPolicy,
  Effect.gen(function* () {
    const { platform, isPackaged } = yield* DesktopEnvironment.DesktopEnvironment;
    // A user-settable override would bypass the policy, so packaged builds ignore it; isPackaged
    // is the one signal an environment variable cannot change.
    const devPath = isPackaged
      ? Option.none<string>()
      : yield* Config.option(Config.String("T3CODE_DEV_MANAGED_POLICY_PATH")).pipe(
          Effect.orElseSucceed(() => Option.none<string>()),
        );
    const readDevPolicy = Effect.fn("DesktopManagedPolicy.readDevPolicy")(function* (path: string) {
      const document = yield* readManagedPolicyFile(path);
      if (document === undefined) {
        yield* Effect.logWarning("The dev managed policy file is missing; no policy applies.", {
          path,
        });
        return undefined;
      }
      return { source: path, document };
    });
    const read = yield* Effect.cached(
      Option.match(devPath, {
        onSome: readDevPolicy,
        onNone: () => readManagedPolicy(platform),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, yield* FileSystem.FileSystem),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          yield* ChildProcessSpawner.ChildProcessSpawner,
        ),
        Effect.provideService(WindowsRegistry, yield* WindowsRegistry),
      ),
    );
    return DesktopManagedPolicy.of({ read });
  }),
).pipe(Layer.provide(layerWindowsRegistry(() => import("ffi-rs"))));

/** A machine with `policy` deployed, one whose policy cannot be used, or none. */
export const layerTest = (policy?: ManagedPolicyDocument | ManagedPolicyFileError) =>
  Layer.succeed(
    DesktopManagedPolicy,
    DesktopManagedPolicy.of({
      read:
        policy === undefined
          ? Effect.undefined
          : isManagedPolicyFileError(policy)
            ? Effect.fail(policy)
            : Effect.succeed({ source: "/test/policy.json", document: policy }),
    }),
  );
