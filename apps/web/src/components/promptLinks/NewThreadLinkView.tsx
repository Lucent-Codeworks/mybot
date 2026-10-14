import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { resolvePromptLinkModelSelection } from "@t3tools/client-runtime/prompt-links";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { NewThreadLink } from "@t3tools/shared/promptLinks";
import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useEffect, useEffectEvent, useRef, useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { allReachableShellsLiveAtom } from "~/state/shell";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { placeLinkedPrompt } from "./linkedPrompt";

type LinkState =
  | { readonly status: "opening" }
  | { readonly status: "opened" }
  | { readonly status: "failed"; readonly message: string };

// A link opens once per history entry. Going back to it lands here again, and opening a
// second draft for the same click would surprise more than it helps.
const openedLinkKeys = new Set<string>();

/**
 * The `/new` route: turns a prompt link into a "No project" draft holding its prompt, on the
 * machine the user worked on last. The user still reads the prompt and presses Send.
 */
export function NewThreadLinkView({ link }: { readonly link: NewThreadLink }) {
  const locationKey = useLocation({ select: (location) => location.state.__TSR_key ?? "" });
  // The link needs every reachable machine's threads to find the one worked on last.
  const ready = useAtomValue(allReachableShellsLiveAtom);
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handleNewThread = useNewThreadHandler();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const [state, setState] = useState<LinkState>(() =>
    openedLinkKeys.has(locationKey) ? { status: "opened" } : { status: "opening" },
  );
  const startedRef = useRef(false);

  /** The machine the user worked on last, scratch threads included. */
  const lastActiveEnvironmentId = () => {
    let latest: (typeof threads)[number] | undefined;
    for (const thread of threads) {
      if (latest === undefined || thread.updatedAt > latest.updatedAt) latest = thread;
    }
    return latest?.environmentId ?? primaryEnvironmentId;
  };

  /** Opens a draft in the project with the link's prompt and, when it is available, model. */
  const openDraft = async (project: EnvironmentProject) => {
    const opened = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      replace: true,
    }).catch(() => null);
    if (opened === null) {
      setState({ status: "failed", message: "MyBot could not open a new thread." });
      return;
    }
    setState({ status: "opened" });
    const notes: Array<string> = [];
    if (link.provider !== null) {
      const providers =
        environments.find((environment) => environment.environmentId === project.environmentId)
          ?.serverConfig?.providers ?? [];
      const resolved = resolvePromptLinkModelSelection(providers, {
        provider: link.provider,
        model: link.model,
      });
      if (resolved !== null) {
        useComposerDraftStore.getState().setModelSelection(opened.draftId, resolved.selection, {
          explicit: true,
          replaceOptions: true,
        });
      }
      if (resolved === null || !resolved.exact) {
        notes.push(
          resolved === null
            ? `The link asked for ${link.provider}, which is not set up here, so your default model is used.`
            : `The link asked for ${link.model}, which ${link.provider} does not offer here, so its default model is used.`,
        );
      }
    }
    placeLinkedPrompt(opened.draftId, link.prompt, notes);
  };

  /** "No project" on the machine the user last worked on. */
  const openWithoutProject = async () => {
    setState({ status: "opening" });
    // The machine the user last worked on, or the only one that offers it.
    const environmentId =
      scratchEnvironmentId(lastActiveEnvironmentId()) ?? scratchEnvironmentId(null);
    // Reports its own failure.
    const project = environmentId === null ? null : await openScratchProject(environmentId);
    if (project === null) {
      setState({
        status: "failed",
        message: "None of your machines can start a thread without a project right now.",
      });
      return;
    }
    await openDraft(project);
  };

  const start = useEffectEvent(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    openedLinkKeys.add(locationKey);
    void openWithoutProject();
  });

  // Runs once per link, when the shells are in. Later shell updates must not open it again.
  useEffect(() => {
    if (ready && state.status === "opening") start();
  }, [ready, state.status]);

  switch (state.status) {
    case "opening":
      return <LinkPage title="Opening the link..." />;
    case "opened":
      return (
        <LinkPage title="This link is open">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              openedLinkKeys.delete(locationKey);
              startedRef.current = false;
              setState({ status: "opening" });
            }}
          >
            Open it again
          </Button>
        </LinkPage>
      );
    case "failed":
      return <LinkPage title="Could not open the link" description={state.message} />;
  }
}

function LinkPage({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>{title}</EmptyTitle>
          {description ? <EmptyDescription>{description}</EmptyDescription> : null}
          {children ? <div className="mt-5 flex justify-center gap-2">{children}</div> : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
