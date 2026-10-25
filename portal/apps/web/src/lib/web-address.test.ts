import { describe, expect, it } from "vitest";
import { findWebAddresses } from "./web-address";

const hrefs = (text: string) => findWebAddresses(text).map((found) => found.href);

describe("findWebAddresses (#947)", () => {
  it("finds an http or https address and gives where it sits in the text", () => {
    expect(findWebAddresses("see https://example.test/a now")).toEqual([{ from: 4, to: 26, href: "https://example.test/a" }]);
    expect(findWebAddresses("http://example.test")).toEqual([{ from: 0, to: 19, href: "http://example.test" }]);
  });

  it("normalises a www. address to https and keeps the typed text's range", () => {
    expect(findWebAddresses("go to www.example.com today")).toEqual([{ from: 6, to: 21, href: "https://www.example.com" }]);
  });

  it("finds every address in order, a repeated one each time it appears", () => {
    expect(hrefs("https://b.test then www.a.test/x and https://b.test")).toEqual(["https://b.test", "https://www.a.test/x", "https://b.test"]);
  });

  it("leaves bare domains and email addresses alone", () => {
    expect(hrefs("example.com or mail me at someone@example.com or ops@www.example.com")).toEqual([]);
  });

  it("keeps the path, query and fragment but not the sentence's closing punctuation", () => {
    expect(hrefs("Read https://example.test/a?b=1#c.")).toEqual(["https://example.test/a?b=1#c"]);
    expect(hrefs("Is it https://example.test/a?")).toEqual(["https://example.test/a"]);
    expect(hrefs('"https://example.test/a", she said')).toEqual(["https://example.test/a"]);
    expect(hrefs("(see https://example.test/a)")).toEqual(["https://example.test/a"]);
    expect(hrefs("https://en.example.test/wiki/A_(b)")).toEqual(["https://en.example.test/wiki/A_(b)"]);
  });

  it("does not take a scheme or www. glued to the end of a word", () => {
    expect(hrefs("xhttps://example.test nowww.example.com")).toEqual([]);
  });

  it("refuses a scheme with no host and a www. with no domain after it", () => {
    expect(hrefs("https:// and www. and www.example")).toEqual([]);
  });

  it("reads the scheme and www. in any case, keeping the text as written", () => {
    expect(hrefs("HTTPS://Example.test/A WWW.Example.com")).toEqual(["HTTPS://Example.test/A", "https://WWW.Example.com"]);
  });
});
