import type { PetPose } from "@mybot/client-runtime/state/petMood";
import { PET_ATLAS, PET_ROWS, type Pet, type PetRowName } from "@mybot/contracts";
import { type AnimationEvent, type CSSProperties, useEffect, useState } from "react";

import { cn } from "~/lib/utils";

/**
 * One stepped `@keyframes` per atlas row, built from the row's frame timings.
 * Each keyframe holds its frame (`step-end`) until the next one; the element
 * supplies `--pet-w`, the rendered cell width.
 */
const PET_ROW_KEYFRAMES_CSS = PET_ROWS.map(({ name, frameDurationsMs }) => {
  const totalMs = frameDurationsMs.reduce((sum, ms) => sum + ms, 0);
  let elapsedMs = 0;
  const steps = frameDurationsMs.map((ms, frame) => {
    const percent = (elapsedMs / totalMs) * 100;
    elapsedMs += ms;
    return `${Number(percent.toFixed(4))}%{background-position-x:calc(var(--pet-w) * -${frame})}`;
  });
  const lastFrame = frameDurationsMs.length - 1;
  steps.push(`100%{background-position-x:calc(var(--pet-w) * -${lastFrame})}`);
  return `@keyframes pet-row-${name}{${steps.join("")}}`;
}).join("\n");

const ROWS_BY_NAME = new Map(PET_ROWS.map((row) => [row.name, row]));

function rowOf(name: PetRowName) {
  const row = ROWS_BY_NAME.get(name);
  if (!row) throw new Error(`Unknown pet row ${name}`);
  return row;
}

/** Where a pose is in its sequence. Only `play` and `hover` animate. */
type Phase = "play" | "rest" | "review" | "idle" | "hover";

type Frame = {
  readonly row: PetRowName;
  readonly frame: "first" | "last";
  /** Iterations to play, or null for a still frame. */
  readonly iterations: number | "infinite" | null;
};

const IDLE_FRAME: Frame = { row: "idle", frame: "first", iterations: null };

function initialPhase(pose: PetPose): Phase {
  return pose.loop || pose.plays > 0 ? "play" : "rest";
}

function frameFor(pose: PetPose, phase: Phase): Frame {
  switch (phase) {
    case "play":
      return { row: pose.row, frame: "first", iterations: pose.loop ? "infinite" : pose.plays };
    case "rest":
      return { row: pose.row, frame: pose.holdLastFrame ? "last" : "first", iterations: null };
    // After a completion jump the pet looks over the work for a moment (Ruling 6).
    case "review":
      return { row: "review", frame: "last", iterations: null };
    case "hover":
      return { row: "idle", frame: "first", iterations: 1 };
    case "idle":
      return IDLE_FRAME;
  }
}

/**
 * Where a phase lands while motion is off (hidden, reduced motion): a finite
 * reaction skips to where it would end, so it never replays later. A loop
 * keeps its phase and resumes with the motion.
 */
function settle(pose: PetPose, phase: Phase): Phase {
  if (phase === "review" || phase === "hover") return "idle";
  if (phase !== "play" || pose.loop) return phase;
  return pose.returnToIdleAfterMs !== undefined ? "idle" : "rest";
}

/** Picture pets fake each reaction with a fixed CSS motion from index.css. */
function pictureAnimationClass(frame: Frame): string | null {
  if (frame.iterations === null) return null;
  switch (frame.row) {
    case "running":
      return frame.iterations === "infinite" ? "pet-picture-bob" : null;
    case "waiting":
      return "pet-picture-hop";
    case "jumping":
      return "pet-picture-jump";
    case "failed":
      return "pet-picture-shake";
    default:
      return null;
  }
}

export type PetSpriteProps = {
  readonly pet: Pet;
  /** Signed URL of the pet's sprite sheet or picture. */
  readonly url: string;
  readonly pose: PetPose;
  /** Show the idle frame only, with no motion. */
  readonly reducedMotion: boolean;
  /**
   * False while the pet can't be seen move (hidden, reduced motion): finite
   * reactions skip to their end instead of playing later. Defaults to
   * `!reducedMotion`.
   */
  readonly animating?: boolean;
  /** Rendered width in px; height follows the 192×208 cell. */
  readonly width?: number;
  readonly className?: string;
};

/**
 * Plays a pose once (or loops it while `pose.loop`), then holds still. A new
 * pose object restarts the sequence, so callers should keep poses stable;
 * while not `animating`, a new finite pose lands straight on its end.
 */
export function PetSprite({
  pet,
  url,
  pose,
  reducedMotion,
  animating: animatingProp = !reducedMotion,
  width = 72,
  className,
}: PetSpriteProps) {
  const animating = animatingProp && !reducedMotion;
  const [sequence, setSequence] = useState(() => ({
    pose,
    phase: initialPhase(pose),
    playKey: 0,
  }));
  let current =
    sequence.pose !== pose
      ? { pose, phase: initialPhase(pose), playKey: sequence.playKey + 1 }
      : sequence;
  if (!animating) {
    const settled = settle(pose, current.phase);
    if (settled !== current.phase) current = { ...current, phase: settled };
  }
  if (current !== sequence) setSequence(current);
  const { phase, playKey } = current;

  const reviewHoldMs = animating && phase === "review" ? pose.returnToIdleAfterMs : undefined;
  useEffect(() => {
    if (reviewHoldMs === undefined) return;
    const timer = window.setTimeout(() => {
      setSequence((previous) =>
        previous.pose === pose && previous.phase === "review"
          ? { ...previous, phase: "idle" }
          : previous,
      );
    }, reviewHoldMs);
    return () => window.clearTimeout(timer);
  }, [pose, reviewHoldMs]);

  const frame = reducedMotion ? IDLE_FRAME : frameFor(pose, phase);
  const isStillIdle = frame.row === "idle" && frame.frame === "first" && frame.iterations === null;

  const handleAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    setSequence((previous) => {
      if (previous.pose !== pose) return previous;
      if (previous.phase === "hover") return { ...previous, phase: "idle" };
      if (previous.phase !== "play") return previous;
      return {
        ...previous,
        phase: pose.returnToIdleAfterMs !== undefined ? "review" : "rest",
      };
    });
  };

  const handlePointerEnter = () => {
    if (!animating || pet.kind !== "atlas" || !isStillIdle) return;
    setSequence((previous) => ({ ...previous, phase: "hover", playKey: previous.playKey + 1 }));
  };

  const height = Math.round((width * PET_ATLAS.cellHeight) / PET_ATLAS.cellWidth);

  if (pet.kind === "picture") {
    const animationClass = reducedMotion ? null : pictureAnimationClass(frame);
    return (
      <img
        key={playKey}
        src={url}
        alt={pet.displayName}
        draggable={false}
        width={width}
        height={height}
        onAnimationEnd={handleAnimationEnd}
        className={cn(
          // max-w-none: preflight's max-width:100% collapses the image to 0px
          // inside the composer's shrink-to-fit, absolutely positioned wrapper.
          "block max-w-none object-contain select-none",
          // Built-ins are pixel art, served at a whole-number scale.
          pet.builtIn ? "[image-rendering:pixelated]" : null,
          animationClass,
          !reducedMotion && pose.row === "failed" && phase !== "review" && phase !== "idle"
            ? "pet-picture-failed"
            : null,
          className,
        )}
      />
    );
  }

  const row = rowOf(frame.row);
  const lastFrame = row.frameDurationsMs.length - 1;
  const totalMs = row.frameDurationsMs.reduce((sum, ms) => sum + ms, 0);
  const style = {
    "--pet-w": `${width}px`,
    width,
    height,
    backgroundImage: `url(${JSON.stringify(url)})`,
    backgroundSize: `${PET_ATLAS.columns * 100}% auto`,
    backgroundPositionX: frame.frame === "last" ? -lastFrame * width : 0,
    backgroundPositionY: -row.row * height,
    animation:
      frame.iterations === null
        ? "none"
        : `pet-row-${frame.row} ${totalMs}ms step-end ${frame.iterations} forwards`,
  } as CSSProperties;

  return (
    <>
      <style href="mybot-pet-row-keyframes" precedence="medium">
        {PET_ROW_KEYFRAMES_CSS}
      </style>
      <div
        key={playKey}
        role="img"
        aria-label={pet.displayName}
        style={style}
        onAnimationEnd={handleAnimationEnd}
        onPointerEnter={handlePointerEnter}
        className={cn("bg-no-repeat [image-rendering:pixelated]", className)}
      />
    </>
  );
}
