import { describe, expect, it } from "vitest";

import { parseNpcCharacter } from "./npcIdentity";

describe("npcIdentity", () => {
  it("uses first names for standard compact labels", () => {
    expect(parseNpcCharacter("character-sv-richard-hendricks")?.shortName).toBe("Richard");
  });

  it("keeps full names for curated exceptions", () => {
    expect(parseNpcCharacter("character-sv-jian-yang")?.shortName).toBe("Jian Yang");
    expect(parseNpcCharacter("character-firefly-the-operative")?.shortName).toBe("The Operative");
  });

  it("uses last-name overrides where the surname is more recognizable", () => {
    expect(parseNpcCharacter("character-tech-david-sacks")?.shortName).toBe("Sacks");
    expect(parseNpcCharacter("character-tech-david-friedberg")?.shortName).toBe("Friedberg");
  });
});
