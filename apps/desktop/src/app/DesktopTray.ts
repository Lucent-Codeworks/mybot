import * as Electron from "electron";

let tray: Electron.Tray | null = null;

/**
 * The tray icon that keeps MyBot reachable after its last window closes. The
 * desktop app hosts the user's bots, so the server and its routines keep
 * running until the user quits from here. Calling it again reuses the icon.
 */
export function showBackgroundTray(input: {
  readonly iconPath: string;
  readonly displayName: string;
  readonly onOpen: () => void;
  readonly onQuit: () => void;
}): void {
  if (tray !== null && !tray.isDestroyed()) return;
  tray = new Electron.Tray(Electron.nativeImage.createFromPath(input.iconPath));
  tray.setToolTip(`${input.displayName} is running in the background`);
  tray.setContextMenu(
    Electron.Menu.buildFromTemplate([
      { label: `Open ${input.displayName}`, click: input.onOpen },
      { type: "separator" },
      { label: `Quit ${input.displayName}`, click: input.onQuit },
    ]),
  );
  tray.on("click", input.onOpen);
}
