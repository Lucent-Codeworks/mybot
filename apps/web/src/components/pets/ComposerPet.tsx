import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@mybot/client-runtime/state/models";
import {
  nextThreadPose,
  type PetPose,
  resolveBotPet,
  resolvePetMood,
  unknownBotPetIds,
} from "@mybot/client-runtime/state/petMood";
import type { BotProfile, EnvironmentId, Pet } from "@mybot/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useClientSettings } from "~/hooks/useSettings";
import { observeResize } from "~/lib/observeResize";
import { petSpriteUrlAtom } from "~/state/assets";
import { petEnvironment } from "~/state/pets";
import { serverEnvironment } from "~/state/server";

import { PetSprite } from "./PetSprite";

/** The pet is 72px wide, centered in the gap; below this it would crowd the edges. */
const MIN_FREE_SPACE_PX = 88;
const PET_WIDTH_PX = 72;

const NO_PETS_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("pets:none"),
);
const NO_SETTINGS_ATOM = Atom.make(null).pipe(Atom.withLabel("pets:no-settings"));

/**
 * The active bot's pet, beside the composer, reacting to the thread's state.
 * Renders nothing when pets are off, the project is not a bot, or the bot has
 * no pet; hides itself when the composer lane leaves no room on its left.
 */
export function ComposerPet(props: {
  readonly environmentId: EnvironmentId | null;
  readonly bot: BotProfile | null | undefined;
  /** The active server thread, or null for a draft. */
  readonly thread: EnvironmentThreadShell | null;
}) {
  const { environmentId, bot, thread } = props;
  const petsEnabled = useClientSettings((settings) => settings.petsEnabled);
  const wantsPet = petsEnabled && environmentId !== null && !!bot && bot.petId !== null;
  const serverSettings = useAtomValue(
    wantsPet ? serverEnvironment.settingsValueAtom(environmentId) : NO_SETTINGS_ATOM,
  );
  const petsAtom = wantsPet
    ? petEnvironment.list({ environmentId, input: undefined })
    : NO_PETS_ATOM;
  const petsResult = useAtomValue(petsAtom);
  const refreshPets = useAtomRefresh(petsAtom);
  const pets = Option.match(AsyncResult.value(petsResult), {
    onNone: () => null,
    onSome: (result) => result.pets,
  });
  const defaultPetId = serverSettings?.defaultPetId ?? null;
  const pet = wantsPet ? resolveBotPet({ bot, defaultPetId, pets: pets ?? [] }) : null;

  // Pets are managed on other devices, so the bot or the default can name a
  // pet this list has not seen yet. Ask again once per unknown answer.
  const unknownKey =
    wantsPet && pets !== null ? unknownBotPetIds({ bot, defaultPetId, pets }).join(",") : "";
  const refreshedForRef = useRef("");
  useEffect(() => {
    if (unknownKey === "" || refreshedForRef.current === unknownKey) return;
    refreshedForRef.current = unknownKey;
    refreshPets();
  }, [unknownKey, refreshPets]);

  if (!pet || environmentId === null) return null;
  return <ComposerPetFor environmentId={environmentId} pet={pet} thread={thread} />;
}

function ComposerPetFor(props: {
  readonly environmentId: EnvironmentId;
  readonly pet: Pet;
  readonly thread: EnvironmentThreadShell | null;
}) {
  const { environmentId, pet, thread } = props;
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const url = useAtomValue(
    petSpriteUrlAtom({ environmentId, petId: pet.id, version: pet.updatedAt }),
  );
  const pose = useThreadPose(thread);
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const hasRoom = useHasRoomBesideComposer(element);

  return (
    <div
      ref={setElement}
      aria-hidden={!hasRoom}
      // Centered in the gap left of the composer and on the chat box; the
      // variables come from useHasRoomBesideComposer.
      className={hasRoom && url ? "absolute translate-x-1/2 -translate-y-1/2" : "hidden"}
      style={{
        right: "calc(100% + var(--pet-gap, 0px) / 2)",
        top: "var(--pet-center-y, 50%)",
      }}
    >
      {pose.bubble ? (
        <div className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded-full bg-muted px-1.5 py-0.5 text-2xs font-semibold whitespace-nowrap text-muted-foreground">
          {pose.bubble}
        </div>
      ) : null}
      {url ? (
        <PetSprite
          pet={pet}
          url={url}
          pose={pose}
          reducedMotion={reducedMotion}
          animating={hasRoom && !reducedMotion}
          width={PET_WIDTH_PX}
        />
      ) : null}
    </div>
  );
}

/**
 * The pose for the thread's current mood, via `nextThreadPose`: reactions play
 * only when the shown thread's mood changes. It is derived during render so
 * the reaction lands with the change, not a frame later, and StrictMode's
 * double render cannot swallow it.
 */
function useThreadPose(thread: EnvironmentThreadShell | null): PetPose {
  const mood = thread ? resolvePetMood(thread) : "idle";
  const threadKey = thread ? `${thread.environmentId}:${thread.id}` : null;
  const [tracked, setTracked] = useState(() => nextThreadPose(null, threadKey, mood));
  const next = nextThreadPose(tracked, threadKey, mood);
  if (next !== tracked) setTracked(next);
  return next.pose;
}

/**
 * Whether the composer stack leaves room for the pet on its left. Also writes
 * the gap's width (`--pet-gap`) and the chat box's vertical center
 * (`--pet-center-y`) onto the pet, so resizes reposition it without a render;
 * React only re-renders when the room answer flips.
 */
function useHasRoomBesideComposer(element: HTMLElement | null): boolean {
  const [hasRoom, setHasRoom] = useState(false);
  useEffect(() => {
    const stack = element?.closest<HTMLElement>("[data-chat-composer-stack]");
    const lane = stack?.parentElement;
    if (!element || !stack || !lane) return;
    // Delivers an initial entry for each target, so no separate first measure.
    // The chat box grows inside the stack, so watching the stack covers it.
    return observeResize([lane, stack], () => {
      const stackRect = stack.getBoundingClientRect();
      const free = stackRect.left - lane.getBoundingClientRect().left;
      const box = stack.querySelector('[data-slot="composer-shell"]')?.getBoundingClientRect();
      const centerY = box ? box.top - stackRect.top + box.height / 2 : stackRect.height / 2;
      element.style.setProperty("--pet-gap", `${free}px`);
      element.style.setProperty("--pet-center-y", `${centerY}px`);
      setHasRoom(free >= MIN_FREE_SPACE_PX);
    });
  }, [element]);
  return hasRoom;
}
