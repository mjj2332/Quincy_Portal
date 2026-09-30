import { describe, expect, it } from "vitest";
import { formatAssigneeNames } from "./subtask-assignees";

const person = (name: string) => ({ id: name.toLowerCase(), name });

describe("formatAssigneeNames", () => {
  it("names one, two and three people in plain English", () => {
    expect(formatAssigneeNames([person("Ada")], 0)).toBe("Ada");
    expect(formatAssigneeNames([person("Ada"), person("Bo")], 0)).toBe("Ada and Bo");
    expect(formatAssigneeNames([person("Ada"), person("Bo"), person("Cy")], 0)).toBe("Ada, Bo and Cy");
  });

  it("names three and counts the rest", () => {
    const five = ["Ada", "Bo", "Cy", "Di", "Ed"].map(person);
    expect(formatAssigneeNames(five, 0)).toBe("Ada, Bo, Cy and 2 others");
    expect(formatAssigneeNames(five.slice(0, 4), 0)).toBe("Ada, Bo, Cy and 1 other");
  });

  it("counts people the viewer may not see as others", () => {
    expect(formatAssigneeNames([person("Ada")], 2)).toBe("Ada and 2 others");
    expect(formatAssigneeNames([], 2)).toBe("2 others");
    expect(formatAssigneeNames([], 1)).toBe("1 other");
  });

  it("is empty when nobody is assigned", () => {
    expect(formatAssigneeNames([], 0)).toBe("");
  });
});
