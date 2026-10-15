import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ModelSelection, ProjectId } from "@t3tools/contracts";
import type { BotTemplate } from "@t3tools/shared/botTemplates";
import { createModelSelection } from "@t3tools/shared/model";
import { useEffect, useId, useMemo, useState } from "react";
import { create } from "zustand";

import { useEnvironmentSettings } from "../hooks/useSettings";
import { useNewProject } from "../hooks/useNewProject";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { usePrimaryEnvironmentId } from "../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settings/settingsLayout";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { BotMarketplace } from "./BotMarketplace";
import { BotMembersPicker } from "./BotMembersPicker";

const useRequest = create<{ open: boolean }>(() => ({ open: false }));

/** Opens the dialog that creates a bot on the primary environment. */
export function requestNewBot() {
  useRequest.setState({ open: true });
}

function close() {
  useRequest.setState({ open: false });
}

export function NewBotDialogHost() {
  const open = useRequest((state) => state.open);
  const environmentId = usePrimaryEnvironmentId();
  useEffect(() => close, []);
  return open && environmentId ? <NewBotDialog environmentId={environmentId} /> : null;
}

function NewBotDialog({ environmentId }: { environmentId: EnvironmentId }) {
  const id = useId();
  const createBot = useNewProject();
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [instructions, setInstructions] = useState("");
  const [chosenModel, setChosenModel] = useState<ModelSelection | null>(null);
  const [saving, setSaving] = useState(false);
  // The dialog opens on the marketplace; a template or a blank bot leads to the form.
  const [step, setStep] = useState<"pick" | "form">("pick");
  const [template, setTemplate] = useState<BotTemplate | null>(null);
  // A group chat is a bot that hosts the conversation with its member bots.
  const [members, setMembers] = useState<ReadonlyArray<ProjectId> | null>(null);
  const isGroup = members !== null;
  const chooseGroup = () => {
    setTemplate(null);
    setMembers([]);
    setName("");
    setRole("Group chat");
    setInstructions("");
    setStep("form");
  };
  const choose = (next: BotTemplate | null) => {
    setTemplate(next);
    setMembers(null);
    setName(next?.name ?? "");
    setRole(next?.role ?? "");
    setInstructions(next?.instructions ?? "");
    setStep("form");
  };

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ),
    [providers, settings],
  );
  const model =
    chosenModel ?? resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, providers, model?.instanceId, model?.model),
    [settings, providers, model?.instanceId, model?.model],
  );

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || !model || saving) return;
    setSaving(true);
    const created = await createBot({
      environmentId,
      name: trimmedName,
      bot: {
        role: role.trim(),
        instructions: instructions.trim(),
        ...(members === null ? {} : { members }),
      },
      defaultModelSelection: model,
      ...(template === null
        ? {}
        : {
            templateId: template.id,
            projectIcon: { kind: "lucide" as const, ...template.icon },
          }),
      ...(isGroup
        ? { projectIcon: { kind: "lucide" as const, name: "users", color: "sky" as const } }
        : {}),
    });
    setSaving(false);
    if (created) close();
  };

  if (step === "pick") {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>New bot</DialogTitle>
            <DialogDescription>
              Start from a ready-made bot, or describe your own. You can change everything later.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <BotMarketplace onChoose={choose} onGroup={chooseGroup} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {isGroup ? "New group chat" : template ? `Add ${template.name}` : "New bot"}
            </DialogTitle>
            <DialogDescription>
              {isGroup
                ? "Talk to several bots in one conversation. The group's model passes your messages to the right bots and shows each answer under its name."
                : template
                  ? `${template.summary} Its starter skills are added to your skills folder.`
                  : "A bot is a teammate with a job. It keeps its instructions in every conversation."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  autoFocus
                  required
                  maxLength={200}
                  placeholder={isGroup ? "Team" : "Scout"}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {isGroup ? (
                <div className="flex flex-col gap-1.5">
                  <Label>Bots</Label>
                  <BotMembersPicker
                    environmentId={environmentId}
                    groupId={null}
                    value={members}
                    disabled={saving}
                    onChange={setMembers}
                  />
                </div>
              ) : null}
              <div className={isGroup ? "hidden" : "flex flex-col gap-1.5"}>
                <Label htmlFor={`${id}-role`}>Job</Label>
                <Input
                  id={`${id}-role`}
                  maxLength={120}
                  placeholder="Daily tech scout"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-instructions`}>Instructions</Label>
                <Textarea
                  id={`${id}-instructions`}
                  rows={6}
                  maxLength={20_000}
                  placeholder={
                    isGroup
                      ? "Optional house rules, such as: keep answers short, and let Analyst go first."
                      : "Each weekday, check my bookmarks and summarize anything worth prototyping. Ask before posting or sending anything."
                  }
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Model</Label>
                {model ? (
                  <div>
                    <ProviderModelPicker
                      environmentId={environmentId}
                      disabled={saving}
                      activeInstanceId={model.instanceId}
                      model={model.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      isComposerOwned={false}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onInstanceModelChange={(instanceId, nextModel) =>
                        setChosenModel(createModelSelection(instanceId, nextModel))
                      }
                    />
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Set up a provider in Settings to create a bot.
                  </p>
                )}
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setStep("pick")}>
              Back
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || !model || saving || (isGroup && members.length === 0)}
            >
              {isGroup ? "Create group" : "Create bot"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
