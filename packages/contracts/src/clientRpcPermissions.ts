import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Endpoint checks exist to configure exports, so they need the same grant as saving them.
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.appConnectionsAdd]: AuthSettingsWriteScope,
  [WS_METHODS.appConnectionsRemove]: AuthSettingsWriteScope,
  [WS_METHODS.appConnectionsSignIn]: AuthSettingsWriteScope,
  [WS_METHODS.botsTelegramConnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsTelegramDisconnect]: AuthOrchestrationOperateScope,
  [WS_METHODS.petsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.petsCreatePicture]: AuthOrchestrationOperateScope,
  [WS_METHODS.petsRename]: AuthOrchestrationOperateScope,
  [WS_METHODS.petsRemove]: AuthOrchestrationOperateScope,
  [WS_METHODS.petsHatch]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [WS_METHODS.voiceInstall]: AuthEnvironmentMaintainScope,
  [WS_METHODS.voiceInstallCancel]: AuthEnvironmentMaintainScope,
  [WS_METHODS.voiceRemove]: AuthEnvironmentMaintainScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

export function clientRpcRequiredScopes(
  method: string,
  _input?: unknown,
): readonly AuthEnvironmentScope[] {
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
