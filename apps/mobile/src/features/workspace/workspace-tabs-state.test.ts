import { describe, expect, it } from "vite-plus/test";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  workspaceToolbarHeight,
} from "./workspace-tabs-state";

describe("workspace root navigation", () => {
  it("cancel restores the list position from before search", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 640 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 160 });
    state = workspaceTabsReducer(state, { type: "expand" });
    expect(state.tabs.threads).toMatchObject({
      query: "keyboard",
      scrollOffset: 160,
      searchMode: "expanded",
    });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      scrollOffset: 640,
      searchMode: "resting",
    });
  });

  it("clear keeps search active without losing the position cancel restores", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 500 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "diff" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 80 });
    state = workspaceTabsReducer(state, { type: "query", query: "" });
    state = workspaceTabsReducer(state, { type: "search" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      searchMode: "active",
      searchEntryOffset: 500,
    });
    expect(workspaceTabsReducer(state, { type: "cancel" }).tabs.threads.scrollOffset).toBe(500);
  });

  it("reserves space for both Android toolbar rows when expanded", () => {
    expect(workspaceToolbarHeight("expanded")).toBeGreaterThan(
      workspaceToolbarHeight("resting") * 2,
    );
  });

  it("a late native blur cannot reopen a cancelled search", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(workspaceTabsReducer(state, { type: "expand" })).toBe(state);
  });
});
