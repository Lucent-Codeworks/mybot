import type { NavigationState } from "@react-navigation/native";

export type AndroidWorkspaceDestination = {
  readonly name: "Thread";
  readonly params: ReactNavigation.RootParamList["Thread"];
};

/** Peer details share one slot above Home; nested routes retain ordinary back navigation. */
export function androidWorkspaceNavigationState(
  state: NavigationState,
  destination?: AndroidWorkspaceDestination,
) {
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  if (!destination) return { ...state, index: 0, routes: [home] };
  const params = destination.params as Readonly<Record<string, unknown>>;
  const existing = state.routes.findLast((route) => {
    if (route.name !== destination.name) return false;
    const current = route.params as Readonly<Record<string, unknown>> | undefined;
    return ["environmentId", "threadId"].every((key) => current?.[key] === params[key]);
  });
  return { ...state, index: 1, routes: [home, { ...existing, ...destination }] };
}
