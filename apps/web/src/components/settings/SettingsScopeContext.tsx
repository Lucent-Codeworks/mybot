import { createContext, type ReactNode, useContext, useMemo } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";
import { resolveScopedSettingsTargets, selectScopedSettingsEnvironments } from "./scopedSettings";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { selectSingleEnvironmentScope } from "./settingsScopeAxis";

function useResolvedSettingsScope(rawSearch: SettingsScopeSearch, singleEnvironment: boolean) {
  const groups = useSettingsProjectGroups();
  const { environments: availableEnvironments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const search = useMemo(
    () =>
      singleEnvironment
        ? selectSingleEnvironmentScope(
            rawSearch,
            resolveSettingsScope(rawSearch, groups, availableEnvironments),
            availableEnvironments,
            primaryEnvironmentId,
          )
        : rawSearch,
    [availableEnvironments, groups, primaryEnvironmentId, rawSearch, singleEnvironment],
  );
  const scope = useMemo(
    () => resolveSettingsScope(search, groups, availableEnvironments),
    [availableEnvironments, groups, search],
  );
  return useMemo(() => {
    const selected = selectScopedSettingsEnvironments(
      scope,
      availableEnvironments,
      primaryEnvironmentId,
    );
    const targets = resolveScopedSettingsTargets(scope, selected.connectedEnvironments);
    // The representative target supplies display values; project scopes
    // prefer the member on the primary environment, like environments do.
    const target =
      targets.find(
        (candidate) => candidate.environmentId === selected.environment?.environmentId,
      ) ??
      targets[0] ??
      null;
    return { scope, groups, search, ...selected, targets, target };
  }, [availableEnvironments, groups, primaryEnvironmentId, scope, search]);
}

const SettingsScopeContext = createContext<
  | (ReturnType<typeof useResolvedSettingsScope> & {
      singleEnvironment: boolean;
      search: SettingsScopeSearch;
      selectScope: (next: SettingsScopeSearch) => void;
    })
  | null
>(null);

export function SettingsScopeProvider({
  search,
  onChange,
  children,
  singleEnvironment = false,
}: {
  singleEnvironment?: boolean;
  search: SettingsScopeSearch;
  onChange: (next: SettingsScopeSearch) => void;
  children: ReactNode;
}) {
  const resolved = useResolvedSettingsScope(search, singleEnvironment);
  const value = useMemo(
    () => ({ ...resolved, singleEnvironment, selectScope: onChange }),
    [onChange, resolved, singleEnvironment],
  );
  return <SettingsScopeContext value={value}>{children}</SettingsScopeContext>;
}

export function useOptionalSettingsScope() {
  return useContext(SettingsScopeContext);
}

export function useSettingsScope() {
  const scope = useOptionalSettingsScope();
  if (scope === null) throw new Error("Settings scope must be read inside SettingsScopeProvider.");
  return scope;
}
