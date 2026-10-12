import { describe, expect, it } from "vitest";
import { EmbeddedImage, EmbeddedVideo } from "./rich-text-tiptap";
import { embeddedMediaUrl } from "./embedded-media";

/** #835: where an embedded medium's bytes are read from is an option of the node, so a Review link can serve its own. */
const render = (node: typeof EmbeddedImage, mediaUrl?: (id: string) => string) => {
  const configured = mediaUrl ? node.configure({ mediaUrl }) : node;
  const spec = configured.config.renderHTML!.call({ options: configured.options, name: configured.name, parent: null, editor: undefined as never, storage: {} } as never, { node: { attrs: { mediaId: "m1" } }, HTMLAttributes: {} } as never) as unknown as [string, Record<string, string>];
  return spec[1]!.src;
};

describe("embedded media nodes' mediaUrl (#835)", () => {
  it("defaults to the staff media route", () => {
    expect(render(EmbeddedImage)).toBe(embeddedMediaUrl("m1"));
    expect(render(EmbeddedVideo as never)).toBe(embeddedMediaUrl("m1"));
  });
  it("reads from the route it is given", () => {
    const via = (id: string) => `/review/t/media/${id}`;
    expect(render(EmbeddedImage, via)).toBe("/review/t/media/m1");
    expect(render(EmbeddedVideo as never, via)).toBe("/review/t/media/m1");
  });
});
