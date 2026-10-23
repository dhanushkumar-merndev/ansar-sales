import { describe, expect, it } from "vitest";
import { formatDuration } from "@/lib/time";

describe("formatDuration", () => {
  it("reads like a talk time", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(60)).toBe("1 min");
    expect(formatDuration(200)).toBe("3 min 20 s");
    expect(formatDuration(3900)).toBe("1 h 5 min");
    expect(formatDuration(7200)).toBe("2 h");
    expect(formatDuration(-5)).toBe("0 s");
  });
});
