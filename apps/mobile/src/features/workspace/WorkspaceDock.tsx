import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { GlassSurface } from "../../components/GlassSurface";
import { WORKSPACE_DOCK } from "./workspace-tabs-state";

/** The compose control sits on the trailing edge without resizing the native tab controller. */
export function WorkspaceDock(props: { readonly onNewTask: () => void }) {
  return (
    <View className="w-full flex-row items-center justify-end" style={{ gap: WORKSPACE_DOCK.gap }}>
      <GlassSurface
        style={{
          width: WORKSPACE_DOCK.height,
          height: WORKSPACE_DOCK.height,
          borderRadius: WORKSPACE_DOCK.height / 2,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={props.onNewTask}
          className="flex-1 items-center justify-center"
        >
          <SymbolView name="square.and.pencil" size={23} tintColorClassName="accent-icon" />
        </Pressable>
      </GlassSurface>
    </View>
  );
}
