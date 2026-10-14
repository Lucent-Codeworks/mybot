import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  androidWorkspaceNavigationState,
  type AndroidWorkspaceDestination,
} from "./android-workspace-navigation";

const require = NodeModule.createRequire(import.meta.url);
const nativePackage = require.resolve("@react-navigation/native/package.json");
const requireFromNative = NodeModule.createRequire(nativePackage);
const corePackage = requireFromNative.resolve("@react-navigation/core/package.json");
const requireFromCore = NodeModule.createRequire(corePackage);
const { CommonActions, StackActions, StackRouter } = requireFromCore(
  "@react-navigation/routers",
) as {
  readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
  readonly StackActions: typeof import("@react-navigation/native").StackActions;
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};
const router = StackRouter({});
const options = {
  routeNames: ["Home", "Thread", "ThreadFiles", "ThreadTerminal", "SettingsSheet"],
  routeParamList: {},
  routeGetIdList: {},
};
const thread = {
  name: "Thread",
  params: { environmentId: "environment-a", threadId: "thread-a" },
} as const;
function apply(
  state: ReturnType<typeof router.getInitialState>,
  action: Parameters<typeof router.getStateForAction>[1],
) {
  const result = router.getStateForAction(state, action, options);
  if (!result) throw new Error(`Router rejected ${action.type}`);
  return router.getRehydratedState(result, options);
}

function select(
  state: ReturnType<typeof router.getInitialState>,
  destination?: AndroidWorkspaceDestination,
) {
  return apply(state, CommonActions.reset(androidWorkspaceNavigationState(state, destination)));
}

function legacyHistory() {
  let state = router.getInitialState(options);
  state = apply(state, StackActions.push(thread.name, thread.params));
  state = apply(state, StackActions.push("ThreadFiles", thread.params));
  return state;
}

function names(state: ReturnType<typeof router.getInitialState>) {
  return state.routes.map((route) => route.name);
}

describe("Android workspace navigation", () => {
  it("replaces peer thread selections without leaving the previous thread underneath", () => {
    const first = select(router.getInitialState(options), thread);
    const second = select(first, {
      name: "Thread",
      params: { ...thread.params, threadId: "thread-b" },
    });
    expect(names(second)).toEqual(["Home", "Thread"]);
    expect(second.routes[1]?.params).toEqual({ ...thread.params, threadId: "thread-b" });
    expect(second.routes[1]?.key).not.toBe(first.routes[1]?.key);
    expect(names(apply(second, StackActions.pop()))).toEqual(["Home"]);
  });

  it("dismisses nested content and overlays when the sidebar selects a peer", () => {
    let state = legacyHistory();
    state = apply(state, StackActions.push("SettingsSheet"));
    const selected = select(state, thread);
    expect(names(selected)).toEqual(["Home", "Thread"]);
    expect(selected.routes[1]?.params).toEqual(thread.params);
  });

  it("creates Home beneath cold-linked details and gives direct list escape", () => {
    const initial = router.getInitialState(options);
    const cold = apply(initial, CommonActions.reset({ index: 0, routes: [thread] }));
    expect(names(select(cold, thread))).toEqual(["Home", "Thread"]);
    expect(names(select(cold))).toEqual(["Home"]);
  });

  it.each(["ThreadFiles", "ThreadTerminal"])(
    "returns to chat when its sidebar row is selected from %s",
    (route) => {
      const detail = select(router.getInitialState(options), thread);
      const nested = apply(detail, StackActions.push(route, thread.params));
      const selected = select(nested, thread);
      expect(names(selected)).toEqual(["Home", "Thread"]);
      expect(selected.routes[1]?.key).toBe(detail.routes[1]?.key);
      expect(names(apply(selected, StackActions.pop()))).toEqual(["Home"]);
    },
  );

  it("does not reuse a thread key from another environment", () => {
    const previous = select(router.getInitialState(options), thread);
    const state = select(previous, {
      name: "Thread",
      params: { ...thread.params, environmentId: "environment-b" },
    });
    expect(state.routes[1]?.key).not.toBe(previous.routes[1]?.key);
  });

  it("drops stale detail history when returning to the list while retaining Home", () => {
    const previous = legacyHistory();
    const state = select(previous);
    expect(names(state)).toEqual(["Home"]);
    expect(state.routes[0]?.key).toBe(previous.routes[0]?.key);
    expect(state.index).toBe(0);
  });
});
