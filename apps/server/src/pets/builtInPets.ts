/**
 * The pets every MyBot server ships with: original pixel art, one character per
 * pixel, rendered to PNG once when the library starts. `.` is transparent; every other character
 * is a key into the pet's palette.
 */
interface BuiltInPetDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly pixels: ReadonlyArray<string>;
  readonly palette: Readonly<Record<string, string>>;
}

export const BUILT_IN_PETS: ReadonlyArray<BuiltInPetDefinition> = [
  {
    id: "builtin-bolt",
    displayName: "Bolt",
    description: "A small silver robot with a blinking antenna.",
    pixels: [
      ".......aa.......",
      ".......oo.......",
      "...oooooooooo...",
      "..ohhsssssssdo..",
      "..ohsvvvvvvsdo..",
      "..ohsvevvevsdo..",
      "..ohsvvvvvvsdo..",
      "..osssssssssdo..",
      "...oooooooooo...",
      "......oddo......",
      "...oooooooooo...",
      "..ohsssaasssdo..",
      "..ohssssssssdo..",
      "..oddddddddddo..",
      "...oo......oo...",
      "..ooo......ooo..",
    ],
    palette: {
      a: "#ff6b6b",
      o: "#2b2f3a",
      h: "#eef2f7",
      s: "#c9d1dc",
      d: "#8a94a3",
      v: "#1e2633",
      e: "#4fd1ff",
    },
  },
  {
    id: "builtin-ember",
    displayName: "Ember",
    description: "A little flame that flickers when it is thinking.",
    pixels: [
      ".......r........",
      "......rr........",
      "......rnr.......",
      ".....rnnr...r...",
      ".....rnnnr.rr...",
      "....rnnynnrrnr..",
      "...rnnyyynnnnr..",
      "...rnyyyyynnnr..",
      "..rnnyywyyynnnr.",
      "..rnyeywweyynnr.",
      "..rnyywwwwyynnr.",
      "..rnyyywwyyynnr.",
      "..rnnyyyyyynnnr.",
      "...rnnnnnnnnnr..",
      "....rrnnnnnrr...",
      "......rrrrr.....",
    ],
    palette: {
      r: "#e8452c",
      n: "#ff8a2a",
      y: "#ffd23f",
      w: "#fff4c2",
      e: "#2b1a12",
    },
  },
  {
    id: "builtin-pip",
    displayName: "Pip",
    description: "A round little bird who cheers when the work is done.",
    pixels: [
      "................",
      "......ooooo.....",
      "....oobbbbboo...",
      "...obbbbbbbbbo..",
      "..obbbbbbbwebo..",
      "..obbbbbbbeebokk",
      ".obbbbbbbbbbbokk",
      ".obbllbbbbbbbo..",
      ".obllllbbbbbbo..",
      ".obllllllbbbbo..",
      ".oblllllllbbbo..",
      "..obllllllbbo...",
      "...oobbbbbboo...",
      ".....oooooo.....",
      "......f..f......",
      ".....ff..ff.....",
    ],
    palette: {
      o: "#2d2a3e",
      b: "#5aa9e6",
      l: "#a8d8ff",
      w: "#ffffff",
      e: "#1b1b1b",
      k: "#ffb347",
      f: "#f08a24",
    },
  },
];
