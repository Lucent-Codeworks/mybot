// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Native header item factories are only read when options are applied, so the fake
// navigation snapshots the right items at each setOptions, as native-stack does.
const harness = vi.hoisted(() => ({
  setOptionsCalls: 0,
  renderedRightItems: [] as Array<ReadonlyArray<Record<string, unknown>>>,
  navigatedRoutes: [] as string[],
}));

vi.mock("@react-navigation/native", () => {
  const navigation = {
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: (route: string) => {
      harness.navigatedRoutes.push(route);
    },
    addListener: () => () => {},
    setOptions: (options: { unstable_headerRightItems?: () => Array<Record<string, unknown>> }) => {
      harness.setOptionsCalls += 1;
      harness.renderedRightItems.push(options.unstable_headerRightItems?.() ?? []);
    },
  };
  return {
    StackActions: { replace: () => ({}) },
    useNavigation: () => navigation,
  };
});

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("react-native", () => ({ Alert: { alert: () => {} }, Linking: {}, Platform: {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { ThreadHeader } from "./ThreadHeader";

const projectScripts: ReadonlyArray<import("@mybot/contracts").ProjectScript> = [];

// Mirrors the route screen: every render passes fresh control callbacks.
function Header(props: { readonly title?: string; readonly scripts?: typeof projectScripts }) {
  return (
    <ThreadHeader
      title={props.title ?? "Thread"}
      subtitle=""
      headerColor="#000"
      usesNativeHeaderGlass
      controls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts: props.scripts ?? projectScripts,
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
      }}
      hasThreadCwd
      hasWorkspaceRoot
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={() => {}}
      onOpenFilesInspector={() => {}}
    />
  );
}

function renderedTerminalMenuLabels(): unknown[] {
  const items = harness.renderedRightItems.at(-1) ?? [];
  const terminal = items.find((item) => item.identifier === "thread-right-terminal") as
    | { menu: { items: Array<{ label?: unknown }> } }
    | undefined;
  return terminal?.menu.items.map((item) => item.label) ?? [];
}

let root: Root | null = null;

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.setOptionsCalls = 0;
  harness.renderedRightItems = [];
  harness.navigatedRoutes = [];
});

describe("ThreadHeader", () => {
  it("re-applies native header items when the project scripts change", () => {
    render(<Header />);
    expect(renderedTerminalMenuLabels()).toContain("No project scripts");

    render(<Header scripts={[{ id: "dev", name: "Dev", command: "pnpm dev", icon: "play" }]} />);
    expect(renderedTerminalMenuLabels()).toContain("Dev");
  });

  it("does not re-apply options for re-renders with equivalent header content", () => {
    render(<Header />);
    const applied = harness.setOptionsCalls;

    // Streaming re-renders the route with fresh callbacks and equal content.
    for (let index = 0; index < 20; index += 1) {
      render(<Header />);
    }
    expect(harness.setOptionsCalls).toBe(applied);
  });
});
