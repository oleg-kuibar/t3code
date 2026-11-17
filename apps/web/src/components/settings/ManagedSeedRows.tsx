import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { DesktopManagedSeed } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { managedSeeds } from "~/state/managedSeeds";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatDesktopSshConnectionError } from "./ConnectionsSettings.logic";
import { formatDesktopSshTarget } from "./EnvironmentRow";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";

type OfferState =
  | { readonly phase: "connecting" | "dismissing" }
  | { readonly phase: "failed"; readonly error: string };

/** Environments the organization's policy offers that this user has not acted on yet. */
export function ManagedSeedRows(): ReactNode {
  const offers = useAtomValue(managedSeeds.offersValueAtom);
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const dismiss = useAtomCommand(managedSeeds.dismiss, { reportFailure: false });
  const [offerStates, setOfferStates] = useState<ReadonlyMap<string, OfferState>>(new Map());
  const setOfferState = (seedId: string, state: OfferState | null) =>
    setOfferStates((current) => {
      const next = new Map(current);
      if (state === null) next.delete(seedId);
      else next.set(seedId, state);
      return next;
    });

  // Nothing records the seed here: once the environment is saved, ManagedSeeds sees its host.
  const connect = async (seed: DesktopManagedSeed) => {
    setOfferState(seed.seedId, { phase: "connecting" });
    const result = await connectSshEnvironment({ target: seed.target, label: seed.label });
    if (result._tag === "Success") {
      setOfferState(seed.seedId, null);
      toastManager.add({
        type: "success",
        title: "Environment connected",
        description: `${seed.label} is ready over an SSH-managed tunnel.`,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      setOfferState(seed.seedId, null);
      return;
    }
    const error = formatDesktopSshConnectionError(squashAtomCommandFailure(result));
    setOfferState(seed.seedId, { phase: "failed", error });
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not connect ${seed.label}`,
        description: error,
      }),
    );
  };

  const requestDismiss = async (seed: DesktopManagedSeed) => {
    const confirmed = await requestConfirmDialog(
      `Dismiss ${seed.label}?\n${seed.organization} offered it through its managed policy. It won't be offered again on this device. You can still add ${seed.target.hostname} yourself with Add environment.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setOfferState(seed.seedId, { phase: "dismissing" });
    const result = await dismiss(seed.seedId);
    setOfferState(seed.seedId, null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not dismiss ${seed.label}`,
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    }
  };

  return offers.map((seed) => {
    const state = offerStates.get(seed.seedId);
    const busy = state?.phase === "connecting" || state?.phase === "dismissing";
    return (
      <div key={seed.seedId} className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <TerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <p className="truncate text-sm font-medium">{seed.label}</p>
            </div>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {formatDesktopSshTarget(seed.target)} · Offered by {seed.organization}
            </p>
            {state?.phase === "failed" ? (
              <p className="mt-1 text-xs text-destructive">{state.error}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void requestDismiss(seed)}
            >
              Dismiss
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void connect(seed)}>
              {state?.phase === "connecting"
                ? "Connecting…"
                : state?.phase === "failed"
                  ? "Retry"
                  : "Connect"}
            </Button>
          </div>
        </div>
      </div>
    );
  });
}
