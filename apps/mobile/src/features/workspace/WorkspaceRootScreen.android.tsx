import { useMemo } from "react";
import { View } from "react-native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { HomeRouteScreen } from "../home/HomeRouteScreen";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";

export function WorkspaceRootScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const workspace = useWorkspaceTabs()!;
  const { fabClearance } = useAndroidControlSizing();
  const context = useMemo(
    () => ({ ...workspace, bottomClearance: fabClearance + 16 }),
    [workspace, fabClearance],
  );

  // Split lists live beside the navigator; Home remains an empty detail pane.
  if (layout.usesSplitView) return <HomeRouteScreen />;

  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-header">
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <HomeRouteScreen />
      </View>
    </WorkspaceTabsContext>
  );
}
