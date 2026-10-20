import { useAtomValue } from "@effect/atom-react";
import {
  type PetMood,
  type PetPose,
  petPoseFor,
  resolveBotPet,
  resolvePetMood,
} from "@mybot/client-runtime/state/petMood";
import type { EnvironmentThreadShell } from "@mybot/client-runtime/state/shell";
import {
  type BotProfile,
  type EnvironmentId,
  PET_ATLAS,
  PET_ROWS,
  type Pet,
  type PetRowName,
} from "@mybot/contracts";
import { Image } from "expo-image";
import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, AppState, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { assetImageSource } from "../../lib/assetImageSource";
import { useAssetUrl } from "../../state/assets";
import { petEnvironment } from "../../state/pets";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const PET_WIDTH = 44;
const PET_HEIGHT = (PET_WIDTH * PET_ATLAS.cellHeight) / PET_ATLAS.cellWidth;

/**
 * The bot's pet, reacting to the thread's state. The caller positions it;
 * renders nothing when the project is not a bot or the bot has no pet.
 */
export function ThreadPet(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: BotProfile | null | undefined;
  readonly thread: EnvironmentThreadShell;
}) {
  const { environmentId, bot, thread } = props;
  const wantsPet = !!bot && bot.petId !== null;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const pets = useEnvironmentQuery(
    wantsPet ? petEnvironment.list({ environmentId, input: undefined }) : null,
  );
  const petList = pets.data?.pets ?? null;
  const pet = wantsPet
    ? resolveBotPet({ bot, defaultPetId: settings?.defaultPetId ?? null, pets: petList ?? [] })
    : null;

  // Pets are managed on other devices, so a bot can name a pet this device's
  // list has not seen yet. Ask again once per unknown id.
  const missingPetId =
    petList !== null && bot?.petId && !petList.some((entry) => entry.id === bot.petId)
      ? bot.petId
      : null;
  const refreshedForRef = useRef<string | null>(null);
  const { refresh } = pets;
  useEffect(() => {
    if (missingPetId === null || refreshedForRef.current === missingPetId) return;
    refreshedForRef.current = missingPetId;
    refresh();
  }, [missingPetId, refresh]);

  if (!pet) return null;
  return <ThreadPetFor environmentId={environmentId} pet={pet} thread={thread} />;
}

function ThreadPetFor(props: {
  readonly environmentId: EnvironmentId;
  readonly pet: Pet;
  readonly thread: EnvironmentThreadShell;
}) {
  const { environmentId, pet, thread } = props;
  const resource = useMemo(
    () => ({ _tag: "pet-sprite", petId: pet.id, version: pet.updatedAt }) as const,
    [pet.id, pet.updatedAt],
  );
  const url = useAssetUrl(environmentId, resource);
  const pose = useThreadPose(thread);
  const reducedMotion = useReduceMotionEnabled();
  const appActive = useAppIsActive();
  const sequence = usePetSequence(pet, pose, !reducedMotion && appActive);
  if (!url) return null;
  const source = assetImageSource(environmentId, resource, url);

  return (
    <View
      pointerEvents="none"
      accessible
      accessibilityRole="image"
      accessibilityLabel={pose.bubble ? `${pet.displayName}: ${pose.bubble}` : pet.displayName}
      style={{ width: PET_WIDTH, height: PET_HEIGHT }}
    >
      {pose.bubble ? (
        <View className="absolute bottom-full left-0 mb-0.5 rounded-full bg-subtle-strong px-1.5 py-0.5">
          <Text className="text-2xs font-mybot-bold text-foreground-muted" numberOfLines={1}>
            {pose.bubble}
          </Text>
        </View>
      ) : null}
      {pet.kind === "picture" ? (
        <PicturePet source={source} sequence={sequence} animating={!reducedMotion && appActive} />
      ) : (
        <AtlasPet
          source={source}
          rows={pet.atlasVersion === 2 ? PET_ATLAS.v2.rows : PET_ATLAS.v1.rows}
          still={reducedMotion ? IDLE_STILL : stillFor(sequence)}
        />
      )}
    </View>
  );
}

/**
 * The pose for the thread's current mood. Reactions play only when the mood
 * changes while this thread is shown; switching threads starts from the new
 * thread's resting pose, so it never replays a reaction.
 */
function useThreadPose(thread: EnvironmentThreadShell): PetPose {
  const mood: PetMood = resolvePetMood(thread);
  const threadKey = `${thread.environmentId}:${thread.id}`;
  const [tracked, setTracked] = useState(() => ({
    threadKey,
    mood,
    pose: petPoseFor(mood, false),
  }));
  if (tracked.threadKey !== threadKey || tracked.mood !== mood) {
    const next = { threadKey, mood, pose: petPoseFor(mood, tracked.threadKey === threadKey) };
    setTracked(next);
    return next.pose;
  }
  return tracked.pose;
}

function useReduceMotionEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setEnabled);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setEnabled);
    return () => subscription.remove();
  }, []);
  return enabled;
}

function useAppIsActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setActive(state === "active");
    });
    return () => subscription.remove();
  }, []);
  return active;
}

const ROWS_BY_NAME = new Map(PET_ROWS.map((row) => [row.name, row]));

function rowOf(name: PetRowName) {
  const row = ROWS_BY_NAME.get(name);
  if (!row) throw new Error(`Unknown pet row ${name}`);
  return row;
}

/**
 * Where a pose is in its sequence: playing its row, resting on it, or, after
 * a completion jump, holding the review row's last frame before going idle.
 */
type Phase = "play" | "rest" | "review" | "idle";

type Sequence = {
  readonly pose: PetPose;
  readonly phase: Phase;
  /** Atlas frame within the playing row. */
  readonly frame: number;
  /** Plays left, counting the current one. Unused while `pose.loop`. */
  readonly playsLeft: number;
};

function startSequence(pose: PetPose): Sequence {
  return {
    pose,
    phase: pose.loop || pose.plays > 0 ? "play" : "rest",
    frame: 0,
    playsLeft: pose.plays,
  };
}

function finishPlay(sequence: Sequence): Sequence {
  return {
    ...sequence,
    phase: sequence.pose.returnToIdleAfterMs !== undefined ? "review" : "rest",
  };
}

function nextAtlasFrame(sequence: Sequence): Sequence {
  const lastFrame = rowOf(sequence.pose.row).frameDurationsMs.length - 1;
  if (sequence.frame < lastFrame) return { ...sequence, frame: sequence.frame + 1 };
  if (sequence.pose.loop) return { ...sequence, frame: 0 };
  if (sequence.playsLeft > 1) {
    return { ...sequence, frame: 0, playsLeft: sequence.playsLeft - 1 };
  }
  return finishPlay(sequence);
}

/**
 * Steps a pose through its sequence with one `setTimeout` at a time. Nothing
 * is scheduled once the pose rests, nor while `animating` is false (reduced
 * motion or app in background); every pending timer clears on change and
 * unmount. A new pose object restarts the sequence.
 */
function usePetSequence(pet: Pet, pose: PetPose, animating: boolean): Sequence {
  const [sequence, setSequence] = useState(() => startSequence(pose));
  let current = sequence;
  if (sequence.pose !== pose) {
    current = startSequence(pose);
    setSequence(current);
  }

  const delayMs = !animating
    ? null
    : current.phase === "review"
      ? (pose.returnToIdleAfterMs ?? null)
      : current.phase !== "play"
        ? null
        : pet.kind === "atlas"
          ? (rowOf(pose.row).frameDurationsMs[current.frame] ?? null)
          : picturePlayMs(pose);
  useEffect(() => {
    if (delayMs === null) return;
    const timer = setTimeout(() => {
      setSequence((previous) => {
        if (previous !== current) return previous;
        if (previous.phase === "review") return { ...previous, phase: "idle" };
        return pet.kind === "atlas" ? nextAtlasFrame(previous) : finishPlay(previous);
      });
    }, delayMs);
    return () => clearTimeout(timer);
  }, [current, delayMs, pet.kind]);

  return current;
}

type Still = { readonly row: number; readonly frame: number };

const IDLE_STILL: Still = { row: 0, frame: 0 };

function stillFor(sequence: Sequence): Still {
  const { pose, phase } = sequence;
  switch (phase) {
    case "play":
      return { row: rowOf(pose.row).row, frame: sequence.frame };
    case "rest": {
      const row = rowOf(pose.row);
      return { row: row.row, frame: pose.holdLastFrame ? row.frameDurationsMs.length - 1 : 0 };
    }
    case "review": {
      const row = rowOf("review");
      return { row: row.row, frame: row.frameDurationsMs.length - 1 };
    }
    case "idle":
      return IDLE_STILL;
  }
}

/** The full atlas behind a one-cell window, offset to the current frame. */
function AtlasPet(props: {
  readonly source: ReturnType<typeof assetImageSource>;
  readonly rows: number;
  readonly still: Still;
}) {
  return (
    <View style={{ width: PET_WIDTH, height: PET_HEIGHT, overflow: "hidden" }}>
      <Image
        source={props.source}
        cachePolicy="memory-disk"
        contentFit="fill"
        style={{
          position: "absolute",
          width: PET_WIDTH * PET_ATLAS.columns,
          height: PET_HEIGHT * props.rows,
          left: -props.still.frame * PET_WIDTH,
          top: -props.still.row * PET_HEIGHT,
        }}
      />
    </View>
  );
}

type PictureMotion = "bob" | "hop" | "jump" | "shake";

/** Picture pets fake a reaction with one motion: hop ×3, jump ×1, shake ×3. */
const PICTURE_MOTION_MS: Record<Exclude<PictureMotion, "bob">, number> = {
  hop: 450 * 3,
  jump: 500,
  shake: 120 * 3,
};

function pictureMotionForRow(row: PetRowName, loop: boolean): PictureMotion | null {
  switch (row) {
    case "running":
      return loop ? "bob" : null;
    case "waiting":
      return "hop";
    case "jumping":
      return "jump";
    case "failed":
      return "shake";
    default:
      return null;
  }
}

function pictureMotionFor(sequence: Sequence): PictureMotion | null {
  if (sequence.phase !== "play") return null;
  return pictureMotionForRow(sequence.pose.row, sequence.pose.loop);
}

/** How long a picture pet's play phase lasts, or null while it loops. */
function picturePlayMs(pose: PetPose): number | null {
  const motion = pictureMotionForRow(pose.row, pose.loop);
  if (motion === "bob") return null;
  return motion === null ? 0 : PICTURE_MOTION_MS[motion];
}

function timing(toValue: number, duration: number) {
  return withTiming(toValue, {
    duration,
    easing: Easing.out(Easing.quad),
    reduceMotion: ReduceMotion.System,
  });
}

function PicturePet(props: {
  readonly source: ReturnType<typeof assetImageSource>;
  readonly sequence: Sequence;
  readonly animating: boolean;
}) {
  const { sequence, animating } = props;
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  // Keyed on the sequence object, so a new pose replays even the same motion.
  useEffect(() => {
    const motion = animating ? pictureMotionFor(sequence) : null;
    if (motion === null) return;
    switch (motion) {
      case "bob":
        translateY.value = withRepeat(
          withSequence(timing(-2, 250), timing(0, 250)),
          -1,
          false,
          undefined,
          ReduceMotion.System,
        );
        break;
      case "hop":
        translateY.value = withRepeat(
          withSequence(timing(-5, 225), timing(0, 225)),
          3,
          false,
          undefined,
          ReduceMotion.System,
        );
        break;
      case "jump":
        translateY.value = withSequence(timing(-10, 200), timing(0, 300));
        break;
      case "shake":
        translateX.value = withRepeat(
          withSequence(timing(-2, 30), timing(2, 60), timing(0, 30)),
          3,
          false,
          undefined,
          ReduceMotion.System,
        );
        break;
    }
    return () => {
      cancelAnimation(translateX);
      cancelAnimation(translateY);
      translateX.value = 0;
      translateY.value = 0;
    };
  }, [animating, sequence, translateX, translateY]);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  return (
    <Animated.View style={[{ width: PET_WIDTH, height: PET_HEIGHT }, animatedStyle]}>
      <Image
        source={props.source}
        cachePolicy="memory-disk"
        contentFit="contain"
        style={{ width: PET_WIDTH, height: PET_HEIGHT }}
      />
    </Animated.View>
  );
}
