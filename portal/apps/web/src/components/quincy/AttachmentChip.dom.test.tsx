import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RichTextDoc } from "@quincy/shared";
import { RichTextContent } from "../RichTextContent";

/** #952: a posted comment's Attachments are a list of download chips (C4's `.cmp-file` shape, A4), after the text and the media. */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
const lists = (host: ParentNode) => [...host.querySelectorAll<HTMLElement>('[role="list"][aria-label="Attachments"]')];

const doc: RichTextDoc = { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "Plans and the contract" }] },
  { type: "attachment", attrs: { attachmentId: A, name: "Floor plan.pdf", bytes: 2_400_000 } },
  { type: "attachment", attrs: { attachmentId: B, name: "Contract.docx", bytes: 48_000 } },
] };

describe("Attachments on a posted comment (#952)", () => {
  it("draws a run of Attachments as one list of download links, by name and size", () => {
    const host = mount(<RichTextContent content={doc} />);
    expect(lists(host)).toHaveLength(1);
    const links = [...lists(host)[0]!.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toBe(`/media/attachments/${A}`);
    expect(links[0]!.hasAttribute("download")).toBe(true);
    expect(links[0]!.getAttribute("aria-label")).toBe("Download Floor plan.pdf, 2.4 MB");
    expect(links[0]!.getAttribute("title")).toBe("Floor plan.pdf");
    expect(links[0]!.textContent).toContain("Floor plan.pdf");
    expect(links[1]!.textContent).toContain("48 KB");
    expect(host.textContent).toContain("Plans and the contract");
  });

  it("takes the download route it is given", () => {
    const host = mount(<RichTextContent content={doc} attachmentUrl={(id) => `/review/t/attachments/${id}`} />);
    expect(host.querySelector("a")!.getAttribute("href")).toBe(`/review/t/attachments/${A}`);
  });

  it("draws an Attachment the server could not name as an unavailable file, not a link", () => {
    const host = mount(<RichTextContent content={{ type: "doc", content: [{ type: "attachment", attrs: { attachmentId: C } }] }} />);
    expect(host.querySelector("a")).toBeNull();
    const item = lists(host)[0]!.querySelector("li")!;
    expect(item.textContent).toContain("File unavailable");
    expect(item.querySelector('[data-state="unavailable"]')).not.toBeNull();
  });

  it("keeps the extension in view when a long name is cut: only the stem truncates, and the whole name still reads", () => {
    const host = mount(<RichTextContent content={{ type: "doc", content: [{ type: "attachment", attrs: { attachmentId: A, name: "Floor plan v2.zip", bytes: 10 } }] }} />);
    const name = host.querySelector<HTMLElement>('[data-testid="attachment-chip"] [data-testid="file-chip-name"]')!;
    expect(name.textContent).toBe("Floor plan v2.zip");
    const stem = name.querySelector<HTMLElement>('[data-testid="file-chip-stem"]')!;
    const extension = name.querySelector<HTMLElement>('[data-testid="file-chip-extension"]')!;
    expect(stem.textContent).toBe("Floor plan v2");
    expect(stem.classList.contains("truncate")).toBe(true);
    expect(extension.textContent).toBe(".zip");
    expect(extension.classList.contains("shrink-0")).toBe(true);
    expect(stem.contains(extension)).toBe(false);
  });

  it("cuts a name with no extension as a whole", () => {
    const host = mount(<RichTextContent content={{ type: "doc", content: [{ type: "attachment", attrs: { attachmentId: A, name: "Site notes v1.2 final", bytes: 10 } }] }} />);
    const name = host.querySelector<HTMLElement>('[data-testid="file-chip-name"]')!;
    expect(name.querySelector('[data-testid="file-chip-extension"]')).toBeNull();
    expect(name.querySelector('[data-testid="file-chip-stem"]')!.textContent).toBe("Site notes v1.2 final");
  });

  it("draws the file name in its own case, as the composer chip does, not in the button's uppercase label type", () => {
    const host = mount(<RichTextContent content={doc} />);
    const link = host.querySelector<HTMLElement>('[data-testid="attachment-chip"]')!;
    expect(link.classList.contains("uppercase")).toBe(false);
    expect(link.classList.contains("normal-case")).toBe(true);
    expect(link.querySelector('[data-testid="file-chip-name"]')!.textContent).toBe("Floor plan.pdf");
  });

  it("starts a new list when other content sits between two runs", () => {
    const host = mount(<RichTextContent content={{ type: "doc", content: [
      { type: "attachment", attrs: { attachmentId: A, name: "a.pdf", bytes: 10 } },
      { type: "paragraph", content: [{ type: "text", text: "between" }] },
      { type: "attachment", attrs: { attachmentId: B, name: "b.pdf", bytes: 10 } },
    ] }} />);
    expect(lists(host)).toHaveLength(2);
  });
});
