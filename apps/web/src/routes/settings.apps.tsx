import { createFileRoute } from "@tanstack/react-router";

import { ConnectedAppsSettings } from "../components/settings/ConnectedAppsSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";

function SettingsAppsRoute() {
  return (
    <SettingsPageContainer>
      <ConnectedAppsSettings />
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/settings/apps")({
  component: SettingsAppsRoute,
});
