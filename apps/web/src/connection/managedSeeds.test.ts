import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  type DesktopManagedSeed,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { isSameSshHost, partitionSeeds } from "./managedSeeds";

const target = (
  alias: string,
  overrides: Partial<DesktopSshEnvironmentTarget> = {},
): DesktopSshEnvironmentTarget => ({
  alias,
  hostname: alias,
  username: null,
  port: null,
  ...overrides,
});

const seed = (seedId: string, seedTarget: DesktopSshEnvironmentTarget): DesktopManagedSeed => ({
  seedId,
  label: seedId,
  organization: "Acme",
  target: seedTarget,
});

const sshRoute = (environmentId: EnvironmentId, saved: DesktopSshEnvironmentTarget) => {
  const connectionId = `ssh:${environmentId}:${saved.alias}`;
  return {
    target: new SshConnectionTarget({ environmentId, label: saved.alias, connectionId }),
    profile: Option.some(
      new SshConnectionProfile({ connectionId, environmentId, label: saved.alias, target: saved }),
    ),
  } satisfies ConnectionRoute;
};

const bearerRoute = (environmentId: EnvironmentId, httpBaseUrl: string) => {
  const connectionId = `bearer:${environmentId}`;
  return {
    target: new BearerConnectionTarget({ environmentId, label: "Desk", connectionId }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId,
        environmentId,
        label: "Desk",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  } satisfies ConnectionRoute;
};

const entry = ([first, ...rest]: [
  ConnectionRoute,
  ...ConnectionRoute[],
]): ConnectionCatalogEntry => ({
  ...first,
  enabled: true,
  ...(rest.length === 0 ? {} : { alternateRoutes: rest }),
});

describe("isSameSshHost", () => {
  it.each([
    [
      "the same alias resolved to another host name",
      target("build1"),
      target("build1", { hostname: "10.0.0.5" }),
      true,
    ],
    [
      "the same host name in other case under another alias",
      target("Build1.Acme.Internal"),
      target("box", { hostname: "build1.acme.internal" }),
      true,
    ],
    [
      "a seed without a user against the user ssh resolved",
      target("build1"),
      target("build1", { username: "kuiba" }),
      true,
    ],
    ["no port against ssh's default port", target("build1"), target("build1", { port: 22 }), true],
    [
      "another user",
      target("build1", { username: "dev" }),
      target("build1", { username: "kuiba" }),
      false,
    ],
    ["another port on the same alias", target("build1", { port: 2222 }), target("build1"), false],
    ["another host", target("build1"), target("build2"), false],
  ] as const)("%s", (_case, seedTarget, saved, expected) => {
    expect(isSameSshHost(seedTarget, saved)).toBe(expected);
  });
});

describe("partitionSeeds", () => {
  it("treats a seed as saved when any SSH route of any entry reaches its host", () => {
    const desk = EnvironmentId.make("desk");
    const build = EnvironmentId.make("build");
    const onAlternate = seed("acme.build-1", target("build1"));
    const onPrimary = seed("acme.build-2", target("build2", { username: "dev" }));
    const onlyOverHttp = seed("acme.desk", target("desk.acme.internal"));
    const unsaved = seed("acme.build-3", target("build3"));

    const { offered, alreadySaved } = partitionSeeds(
      [onAlternate, onPrimary, onlyOverHttp, unsaved],
      [
        entry([
          bearerRoute(desk, "http://desk.acme.internal:3773/"),
          sshRoute(desk, target("build1")),
        ]),
        entry([sshRoute(build, target("build2", { username: "dev", port: 22 }))]),
      ],
    );

    expect(alreadySaved).toEqual([onAlternate, onPrimary]);
    expect(offered).toEqual([onlyOverHttp, unsaved]);
  });
});
