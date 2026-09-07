import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

type OverlayComponent = Component & Focusable & { dispose?(): void };
type OverlayOutcome = { error?: unknown };

export async function runMonitorsOverlay(
  ctx: ExtensionCommandContext,
  createComponent: (
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    close: () => void,
  ) => OverlayComponent,
): Promise<void> {
  let component: OverlayComponent | undefined;
  let handle: OverlayHandle | undefined;
  let ownerTui: TUI | undefined;
  let closed = false;
  let pendingOutcome: OverlayOutcome | undefined;
  let finish: ((outcome: OverlayOutcome) => void) | undefined;

  const completeClose = () => {
    if (!handle || !ownerTui || !pendingOutcome || !finish) return;
    handle.hide();
    // Pi 0.84/0.85 completes custom overlays by popping the newest stack entry.
    // Replace this exact handle with an invisible sentinel so done() cannot pop
    // an unrelated overlay that opened after /monitors.
    ownerTui.showOverlay(
      { render: () => [], invalidate: () => {} },
      { width: 1, maxHeight: 1, visible: () => false, nonCapturing: true },
    );
    const outcome = pendingOutcome;
    pendingOutcome = undefined;
    finish(outcome);
  };

  const close = (error?: unknown) => {
    if (closed) return;
    closed = true;
    pendingOutcome = error === undefined ? {} : { error };
    completeClose();
  };

  const outcome = await ctx.ui.custom<OverlayOutcome>(
    (tui, theme, keybindings, done) => {
      ownerTui = tui;
      finish = done;
      component = createComponent(tui, theme, keybindings, () => close());
      component.focused = handle?.isFocused() ?? true;
      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        width: "78%",
        minWidth: 72,
        maxHeight: "78%",
        anchor: "top-center",
        margin: { top: 1, left: 2, right: 2 },
        nonCapturing: true,
      },
      onHandle: (overlayHandle) => {
        handle = overlayHandle;
        handle.focus();
        if (component) component.focused = handle.isFocused();
        completeClose();
      },
    },
  );

  if (outcome.error !== undefined) throw outcome.error;
}
