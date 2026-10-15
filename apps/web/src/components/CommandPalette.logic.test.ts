import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { Project, Thread } from "../types";
import { makeThreadFixture } from "../test-fixtures";
import {
  buildCommandPaletteRows,
  buildProjectActionItems,
  buildThreadActionItems,
  enumerateCommandPaletteItems,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  reduceCommandPaletteUiState,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
} from "./CommandPalette.logic";

describe("reduceCommandPaletteUiState", () => {
  const closedState = { open: false, mode: "command", openIntent: null } as const;

  it("toggles each overlay mode open and closed", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(filesOpen).toEqual({ open: true, mode: "files", openIntent: null });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "ToggleMode", mode: "files" })).toEqual({
      open: false,
      mode: "files",
      openIntent: null,
    });
  });

  it("switches between open modes without closing", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "ToggleMode", mode: "command" })).toEqual(
      {
        open: true,
        mode: "command",
        openIntent: null,
      },
    );
  });

  it("opens search from another overlay and replaces an earlier search", () => {
    const first = reduceCommandPaletteUiState(
      { open: true, mode: "files", openIntent: null },
      { _tag: "OpenSearch", query: "relay" },
    );
    expect(first).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "search", query: "relay" },
    });
    const second = reduceCommandPaletteUiState(first, { _tag: "OpenSearch", query: "tunnel" });
    expect(second.openIntent).toEqual({ kind: "search", query: "tunnel" });
    expect(
      reduceCommandPaletteUiState(second, { _tag: "SetOpen", open: false }).openIntent,
    ).toBeNull();
  });

  it("routes open intents to command mode", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "OpenChangeTheme" })).toEqual({
      open: true,
      mode: "command",
      openIntent: { kind: "change-theme" },
    });
  });

  it("preserves the mode on close and resets it on open", () => {
    const filesOpen = reduceCommandPaletteUiState(closedState, {
      _tag: "ToggleMode",
      mode: "files",
    });

    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: false })).toEqual({
      open: false,
      mode: "files",
      openIntent: null,
    });
    expect(reduceCommandPaletteUiState(filesOpen, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
      openIntent: null,
    });
  });
});

describe("enumerateCommandPaletteItems", () => {
  it("assigns positional jump shortcuts to the first nine displayed items", () => {
    const items = Array.from({ length: 10 }, (_, index) => ({
      kind: "action" as const,
      value: `project-${index + 1}`,
      searchTerms: [],
      title: `Project ${index + 1}`,
      icon: null,
      shortcutCommand: "chat.new" as const,
      run: async () => undefined,
    }));

    expect(enumerateCommandPaletteItems(items).map((item) => item.shortcutCommand)).toEqual([
      "thread.jump.1",
      "thread.jump.2",
      "thread.jump.3",
      "thread.jump.4",
      "thread.jump.5",
      "thread.jump.6",
      "thread.jump.7",
      "thread.jump.8",
      "thread.jump.9",
      undefined,
    ]);
  });
});

const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    environmentId: LOCAL_ENVIRONMENT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: LOCAL_ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    updatedAt: "2026-03-01T00:00:00.000Z",
    latestRun: null,
    ...overrides,
  });
}

describe("buildProjectActionItems", () => {
  it("shows the grouped display name but keeps the real title for icons", () => {
    const project = makeProject({ title: "fleet", workspaceRoot: "/Users/theo/Code/p/fleet" });
    const iconTitles: string[] = [];
    const [item] = buildProjectActionItems({
      projects: [{ ...project, displayName: "t3dotgg/fleet" }],
      valuePrefix: "project",
      icon: (candidate) => {
        iconTitles.push(candidate.title);
        return null;
      },
      runProject: async () => undefined,
    });

    expect(item?.title).toBe("t3dotgg/fleet");
    expect(item?.searchTerms).toEqual(expect.arrayContaining(["t3dotgg/fleet", "fleet"]));
    expect(iconTitles).toEqual(["fleet"]);
  });
});

describe("buildThreadActionItems", () => {
  it("orders threads by most recent activity and formats timestamps from updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-25T12:00:00.000Z"));

    try {
      const items = buildThreadActionItems({
        threads: [
          makeThread({
            id: ThreadId.make("thread-older"),
            title: "Older thread",
            updatedAt: "2026-03-24T12:00:00.000Z",
          }),
          makeThread({
            id: ThreadId.make("thread-newer"),
            title: "Newer thread",
            createdAt: "2026-03-20T00:00:00.000Z",
            updatedAt: "2026-03-20T00:00:00.000Z",
          }),
        ],
        projectTitleById: new Map([[PROJECT_ID, "Project"]]),
        sortOrder: "updated_at",
        icon: null,
        runThread: async (_thread) => undefined,
      });

      expect(items.map((item) => item.value)).toEqual([
        "thread:thread-older",
        "thread:thread-newer",
      ]);
      expect(items[0]?.timestamp).toBe("1d ago");
      expect(items[1]?.timestamp).toBe("5d ago");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ranks thread title matches ahead of contextual project-name matches", () => {
    const threadItems = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-context-match"),
          title: "Fix navbar spacing",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-title-match"),
          title: "Project kickoff notes",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      botSearchItems: [],
      threadSearchItems: threadItems,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("threads-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:thread-title-match",
      "thread:thread-context-match",
    ]);
  });

  it("orders title matches by recent activity before older prefix matches", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("old-prefix"),
        title: "Convex InvalidCursor in Convex threads query",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-title"),
        title: "Disable Convex schema validation",
        createdAt: "2025-12-01T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      }),
      makeThread({
        id: ThreadId.make("recent-content"),
        title: "Fix schema validation",
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      }),
    ];
    const items = buildThreadActionItems({
      threads,
      projectTitleById: new Map([[PROJECT_ID, "MyBot"]]),
      sortOrder: "created_at",
      icon: null,
      getContentMatch: (thread) =>
        thread.id === ThreadId.make("recent-content")
          ? { source: "user", snippet: "Please check Convex", query: "convex" }
          : undefined,
      runThread: async () => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "convex",
      isInSubmenu: false,
      botSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "thread:recent-title",
      "thread:old-prefix",
      "thread:recent-content",
    ]);
  });

  it("preserves thread project-name matches when there is no stronger title match", () => {
    const group: CommandPaletteGroup = {
      value: "threads-search",
      label: "Threads",
      items: [
        {
          kind: "action",
          value: "thread:project-context-only",
          searchTerms: ["Fix navbar spacing", "Project"],
          title: "Fix navbar spacing",
          description: "Project",
          icon: null,
          run: async () => undefined,
        },
      ],
    };

    const groups = filterCommandPaletteGroups({
      activeGroups: [group],
      query: "project",
      isInSubmenu: false,
      botSearchItems: [],
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["thread:project-context-only"]);
  });

  it("ranks an order-independent setting title match above a split context match", () => {
    const settingsSearchItems = [
      {
        kind: "action" as const,
        value: "setting:context-match",
        searchTerms: ["Pairing settings", "remote backend"],
        title: "Context match",
        icon: null,
        run: async () => undefined,
      },
      {
        kind: "action" as const,
        value: "setting:remote-pairing",
        searchTerms: ["Remote pairing", "connections"],
        title: "Remote pairing",
        icon: null,
        run: async () => undefined,
      },
    ];

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "pairing remote",
      isInSubmenu: false,
      botSearchItems: [],
      settingsSearchItems,
      threadSearchItems: [],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.value).toBe("settings-search");
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "setting:remote-pairing",
      "setting:context-match",
    ]);
  });

  it("keeps accent-insensitive setting results", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "thè\u{1ab0}mes",
      isInSubmenu: false,
      botSearchItems: [],
      settingsSearchItems: [
        {
          kind: "action",
          value: "setting:theme",
          searchTerms: ["Themes", "Appearance"],
          title: "Themes",
          icon: null,
          run: async () => undefined,
        },
      ],
      threadSearchItems: [],
    });

    expect(groups[0]?.items.map((item) => item.value)).toEqual(["setting:theme"]);
  });

  it("normalizes case independently of the host locale", () => {
    const toLocaleLowerCase = String.prototype.toLocaleLowerCase;
    const localeLowerCase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockImplementation(function (this: string) {
        return toLocaleLowerCase.call(this, "tr");
      });
    try {
      const groups = filterCommandPaletteGroups({
        activeGroups: [],
        query: "INPUT",
        isInSubmenu: false,
        botSearchItems: [],
        threadSearchItems: [],
        settingsSearchItems: [
          {
            kind: "action",
            value: "setting:input",
            title: "Input",
            searchTerms: ["input"],
            icon: null,
            run: async () => undefined,
          },
        ],
      });
      expect(groups.flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "setting:input",
      ]);
    } finally {
      localeLowerCase.mockRestore();
    }
  });

  it("keeps message excerpts searchable without replacing thread metadata", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread()],
      projectTitleById: new Map([[PROJECT_ID, "MyBot"]]),
      sortOrder: "updated_at",
      icon: null,
      getContentMatch: () => ({
        source: "assistant",
        snippet: "The relay reconnect is now bounded.",
        query: "reconnect",
      }),
      runThread: async (_thread) => undefined,
    });

    expect(item?.searchTerms).toContain("The relay reconnect is now bounded.");
    expect(item?.threadContentMatch).toEqual({
      source: "assistant",
      snippet: "The relay reconnect is now bounded.",
      query: "reconnect",
    });
    expect(item?.description).toBe("MyBot");
  });

  it("surfaces threads when the query is their ID, without outranking title matches", () => {
    const idThread = makeThread({
      id: ThreadId.make("thread-alpha-1234"),
      title: "Unrelated work",
      updatedAt: "2026-03-05T00:00:00.000Z",
    });
    const titleThread = makeThread({
      id: ThreadId.make("thread-other-9999"),
      title: "Fix thread-alpha-1234 flakes",
      updatedAt: "2026-03-04T00:00:00.000Z",
    });
    const items = buildThreadActionItems({
      threads: [idThread, titleThread],
      projectTitleById: new Map([[PROJECT_ID, "MyBot"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "  THREAD-ALPHA-1234  ",
      isInSubmenu: false,
      botSearchItems: [],
      settingsSearchItems: [],
      threadSearchItems: items,
    });

    expect(groups.flatMap((group) => group.items)).toEqual([
      expect.objectContaining({ value: `thread:${titleThread.id}` }),
      expect.objectContaining({ value: `thread:${idThread.id}` }),
    ]);
  });

  it("prefers renderDescription when provided", () => {
    const [item] = buildThreadActionItems({
      threads: [makeThread({ title: "Search" })],
      projectTitleById: new Map([[PROJECT_ID, "MyBot"]]),
      sortOrder: "updated_at",
      icon: null,
      renderDescription: (thread, { projectTitle }) => `${projectTitle}:${thread.title}`,
      runThread: async (_thread) => undefined,
    });

    expect(item?.description).toBe("MyBot:Search");
  });

  it("filters archived threads out of thread search items", () => {
    const items = buildThreadActionItems({
      threads: [
        makeThread({
          id: ThreadId.make("thread-active"),
          title: "Active thread",
          createdAt: "2026-03-02T00:00:00.000Z",
          updatedAt: "2026-03-19T00:00:00.000Z",
        }),
        makeThread({
          id: ThreadId.make("thread-archived"),
          title: "Archived thread",
          archivedAt: "2026-03-20T00:00:00.000Z",
          updatedAt: "2026-03-20T00:00:00.000Z",
        }),
      ],
      projectTitleById: new Map([[PROJECT_ID, "Project"]]),
      sortOrder: "updated_at",
      icon: null,
      runThread: async (_thread) => undefined,
    });

    expect(items.map((item) => item.value)).toEqual(["thread:thread-active"]);
  });
});

describe("filterCommandPaletteGroups", () => {
  it("sorts secondary settings results after other matches", () => {
    const item = (value: string, title: string, secondary?: boolean) =>
      ({
        kind: "action",
        value,
        title,
        searchTerms: [title, "General"],
        icon: null,
        run: async () => undefined,
        ...(secondary ? { secondary } : {}),
      }) satisfies CommandPaletteActionItem;
    const [group] = filterCommandPaletteGroups({
      activeGroups: [],
      query: "model",
      isInSubmenu: false,
      botSearchItems: [],
      settingsSearchItems: [
        item("setting:keybinding-modelPicker.toggle", "Model Picker: Toggle", true),
        item("setting:default-model", "Default model"),
      ],
      threadSearchItems: [],
    });
    expect(group?.items.map((entry) => entry.value)).toEqual([
      "setting:default-model",
      "setting:keybinding-modelPicker.toggle",
    ]);
  });
});

describe("virtualized command palette rows", () => {
  const action = (value: string, disabled = false): CommandPaletteActionItem => ({
    kind: "action",
    value,
    searchTerms: [],
    title: value,
    icon: null,
    ...(disabled ? { disabled } : {}),
    run: async () => {},
  });
  const groups: CommandPaletteGroup[] = [
    { value: "actions", label: "Actions", items: [action("new-thread"), action("offline", true)] },
    { value: "threads", label: "Threads", items: [action("thread-a"), action("thread-b")] },
  ];

  it("keeps group order and headings while indexing only enabled items", () => {
    const { rows, itemValues, rowIndexByItemIndex } = buildCommandPaletteRows(groups);

    expect(rows.map((row) => (row.kind === "label" ? `# ${row.label}` : row.key))).toEqual([
      "# Actions",
      "actions:new-thread",
      "actions:offline",
      "# Threads",
      "threads:thread-a",
      "threads:thread-b",
    ]);
    expect(itemValues).toEqual(["new-thread", "thread-a", "thread-b"]);
    expect(rowIndexByItemIndex).toEqual([1, 4, 5]);
    expect(rows.flatMap((row) => (row.kind === "item" ? [row.itemIndex] : []))).toEqual([
      0,
      null,
      1,
      2,
    ]);
  });

  it("resolves Enter to the highlighted item without needing its row mounted", () => {
    expect(findHighlightedCommandPaletteItem(groups, "thread-b")?.value).toBe("thread-b");
    expect(findHighlightedCommandPaletteItem(groups, "offline")).toBeNull();
    expect(findHighlightedCommandPaletteItem(groups, null)).toBeNull();
  });
});
