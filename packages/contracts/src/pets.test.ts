import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { PET_ROWS, PetId, petAtlasVersionForSize } from "./pets.ts";
import { BotProfile } from "./project.ts";

describe("petAtlasVersionForSize", () => {
  it("recognizes both atlas layouts and rejects other sizes", () => {
    expect(petAtlasVersionForSize(1536, 1872)).toBe(1);
    expect(petAtlasVersionForSize(1536, 2288)).toBe(2);
    expect(petAtlasVersionForSize(1024, 1024)).toBeNull();
  });
});

describe("PET_ROWS", () => {
  it("lists rows 0..8 in order with their frame counts and timings", () => {
    expect(PET_ROWS.map((row) => row.row)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(PET_ROWS.map((row) => row.frameDurationsMs.length)).toEqual([6, 8, 8, 4, 5, 8, 6, 6, 6]);
    expect(PET_ROWS[0]?.name).toBe("idle");
    expect(PET_ROWS[0]?.frameDurationsMs).toEqual([280, 110, 110, 140, 140, 320]);
  });
});

describe("PetId", () => {
  const decode = Schema.decodeUnknownSync(PetId);
  it("accepts slugs and rejects path-like, uppercase, and overlong ids", () => {
    expect(decode("bolt-2")).toBe("bolt-2");
    expect(() => decode("../x")).toThrow();
    expect(() => decode("Bolt")).toThrow();
    expect(() => decode("a".repeat(65))).toThrow();
  });
});

describe("BotProfile.petId", () => {
  const decode = Schema.decodeUnknownSync(BotProfile);
  it("keeps null as no pet and absent as the default", () => {
    expect(decode({ role: "", instructions: "", petId: null }).petId).toBeNull();
    expect("petId" in decode({ role: "", instructions: "" })).toBe(false);
  });
});
