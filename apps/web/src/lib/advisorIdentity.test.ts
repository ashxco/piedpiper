import { describe, expect, it } from "vitest";

import { parseAdvisor } from "./advisorIdentity";

describe("advisorIdentity", () => {
  it("uses first names for standard compact labels", () => {
    expect(parseAdvisor("character-advisor-brian-chesky")?.shortName).toBe("Brian");
  });

  it("keeps full names for curated exceptions", () => {
    expect(parseAdvisor("character-sv-jian-yang")?.shortName).toBe("Jian Yang");
    expect(parseAdvisor("character-firefly-the-operative")?.shortName).toBe("The Operative");
  });

  it("uses last-name overrides where the surname is more recognizable", () => {
    expect(parseAdvisor("character-tech-david-sacks")?.shortName).toBe("Sacks");
    expect(parseAdvisor("character-tech-david-friedberg")?.shortName).toBe("Friedberg");
  });
});
