import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(myBotHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(myBotHome)) {
    return Option.none();
  }
  const trimmed = myBotHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly myBotHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.myBotHome), () =>
    input.joinPath(input.homeDirectory, ".mybot"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly myBotHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.myBotHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
