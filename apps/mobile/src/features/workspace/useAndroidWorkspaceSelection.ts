import { CommonActions, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard } from "react-native";
import {
  androidWorkspaceNavigationState,
  type AndroidWorkspaceDestination,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";

export function useAndroidWorkspaceSelection() {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(
    (destination: AndroidWorkspaceDestination) => {
      Keyboard.dismiss();
      dispatch?.({ type: "select", tab: "threads" });
      navigation.dispatch((state) =>
        CommonActions.reset(androidWorkspaceNavigationState(state, destination)),
      );
    },
    [navigation, dispatch],
  );
}
