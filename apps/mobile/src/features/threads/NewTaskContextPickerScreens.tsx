import type { ReactNode } from "react";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialListRow } from "../../components/MaterialListRow";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { cn } from "../../lib/cn";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useServerConfigs } from "../../state/entities";
import { useNewTaskFlow } from "./new-task-flow-provider";

function SelectionRow(props: {
  readonly icon?: ReactNode;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        className="bg-grouped-card"
        title={props.title}
        subtitle={props.subtitle}
        leading={props.icon}
        trailing={
          props.selected ? (
            <SymbolView name="checkmark" size={20} tintColorClassName="accent-focus" />
          ) : null
        }
        accessibilityRole="radio"
        accessibilityState={{ checked: props.selected }}
        disabled={props.disabled}
        onPress={props.onPress}
      />
    );
  }
  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.icon ?? null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return (
    <View
      className={
        Platform.OS === "android"
          ? "overflow-hidden rounded-[28px] bg-grouped-card"
          : "overflow-hidden rounded-2xl bg-grouped-card"
      }
    >
      {props.children}
    </View>
  );
}

export function NewTaskEnvironmentPickerRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const serverConfigs = useServerConfigs();
  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: "Environment",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Environment"
          hideBottomBorder
          onBack={() => navigation.goBack()}
        />
      ) : null}
      <MaterialScreenContent>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, 16) + 16,
            paddingHorizontal: 16,
            paddingTop: 16,
          }}
          showsVerticalScrollIndicator={false}
        >
          <PickerSurface>
            {flow.environments.map((environment, index) => (
              <SelectionRow
                key={String(environment.environmentId)}
                icon={
                  <EnvironmentMachineSymbol
                    kind={resolveEnvironmentMachineKind(
                      serverConfigs.get(environment.environmentId) ?? null,
                    )}
                    size={Platform.OS === "android" ? 24 : 17}
                    tintColorClassName="accent-icon-muted"
                  />
                }
                isLast={index === flow.environments.length - 1}
                disabled={flow.switchingToEnvironmentId !== null}
                onPress={() => {
                  void Haptics.selectionAsync();
                  void flow.switchEnvironment(environment.environmentId).then((switched) => {
                    if (switched) navigation.goBack();
                  });
                }}
                selected={flow.selectedEnvironmentId === environment.environmentId}
                title={environment.environmentLabel}
              />
            ))}
          </PickerSurface>
        </ScrollView>
      </MaterialScreenContent>
    </View>
  );
}
