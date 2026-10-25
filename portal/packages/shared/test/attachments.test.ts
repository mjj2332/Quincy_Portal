import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_POST,
  ATTACHMENT_GUEST_MAX_BYTES,
  ATTACHMENT_GUEST_MAX_PER_NOTE,
  attachmentExtension,
  attachmentObjectKey,
  attachmentPresignInput,
  attachmentRefusal,
  noticeAttachmentObjectKey,
  normalizeAttachmentName,
  normalizeDeclaredContentType,
} from "../src/attachments";

describe("Attachment limits", () => {
  it("are 100 MB and 10 a post for staff, 25 MB and 5 a note for guests", () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(104_857_600);
    expect(ATTACHMENT_MAX_PER_POST).toBe(10);
    expect(ATTACHMENT_GUEST_MAX_BYTES).toBe(26_214_400);
    expect(ATTACHMENT_GUEST_MAX_PER_NOTE).toBe(5);
  });

  it("keys an object by id under the Project's prefix, never by its name", () => {
    expect(attachmentObjectKey("p1", "a1")).toBe("projects/p1/attachments/a1/original");
    expect(noticeAttachmentObjectKey("a1")).toBe("notice-board/attachments/a1/original");
  });
});

describe("normalizeAttachmentName", () => {
  it("keeps an ordinary name", () => {
    expect(normalizeAttachmentName("Floor plan v2.pdf")).toBe("Floor plan v2.pdf");
  });

  it("drops the path a browser or a forged request may send", () => {
    expect(normalizeAttachmentName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(normalizeAttachmentName("../../etc/passwd")).toBe("passwd");
  });

  it("removes control, bidi and zero-width characters, so a right-to-left override shows the true extension", () => {
    expect(normalizeAttachmentName("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(normalizeAttachmentName("a\u0000b\u200Bc\uFEFF.txt")).toBe("abc.txt");
  });

  it("replaces reserved characters with a space and collapses whitespace", () => {
    expect(normalizeAttachmentName('a:b*c?"d<e>f|g.txt')).toBe("a b c d e f g.txt");
    expect(normalizeAttachmentName("  a    b\t.txt  ")).toBe("a b .txt");
  });

  it("strips trailing dots and spaces, as Windows does", () => {
    expect(normalizeAttachmentName("evil.exe. . ")).toBe("evil.exe");
  });

  it("cuts a long name to 255 UTF-8 bytes and keeps the extension", () => {
    const name = normalizeAttachmentName(`${"é".repeat(300)}.pdf`);
    expect(name?.endsWith(".pdf")).toBe(true);
    expect(new TextEncoder().encode(name!).byteLength).toBeLessThanOrEqual(255);
  });

  it("refuses a name with nothing left", () => {
    expect(normalizeAttachmentName("")).toBeNull();
    expect(normalizeAttachmentName(" . . ")).toBeNull();
    expect(normalizeAttachmentName("\u202E\u200B")).toBeNull();
    expect(normalizeAttachmentName("dir/")).toBeNull();
  });
});

describe("attachmentExtension", () => {
  it("is the lower-cased text after the last dot, or null", () => {
    expect(attachmentExtension("Report.PDF")).toBe("pdf");
    expect(attachmentExtension("invoice.pdf.exe")).toBe("exe");
    expect(attachmentExtension("README")).toBeNull();
    expect(attachmentExtension(".bashrc")).toBe("bashrc");
  });
});

describe("normalizeDeclaredContentType", () => {
  it("lower-cases and strips parameters", () => {
    expect(normalizeDeclaredContentType("Text/HTML; charset=UTF-8")).toBe("text/html");
  });

  it("makes an empty or malformed type octet-stream", () => {
    expect(normalizeDeclaredContentType("")).toBe("application/octet-stream");
    expect(normalizeDeclaredContentType("not a type")).toBe("application/octet-stream");
    expect(normalizeDeclaredContentType(`application/${"x".repeat(200)}`)).toBe("application/octet-stream");
  });
});

describe("attachmentRefusal", () => {
  const blocked = (name: string, type = "application/octet-stream") => attachmentRefusal(name, type);

  it.each([
    ["setup.exe"], ["SETUP.EXE"], ["installer.msi"], ["lib.dll"], ["run.bat"], ["run.cmd"], ["script.ps1"], ["link.lnk"], ["shortcut.url"],
    ["Mac.app"], ["image.dmg"], ["pkg.pkg"], ["run.command"], ["deploy.sh"], ["app.apk"], ["app.ipa"], ["tool.jar"], ["script.py"],
    ["ext.crx"], ["page.html"], ["page.HTM"], ["page.xhtml"], ["logo.svg"], ["help.chm"], ["disk.iso"], ["disk.vhdx"],
    ["budget.xlsm"], ["letter.docm"], ["deck.pptm"], ["template.dotm"], ["template.xltm"], ["template.potm"], ["show.ppsm"],
    ["addin.xlam"], ["addin.ppam"], ["slide.sldm"], ["invoice.pdf.exe"], ["evil.exe. "],
  ])("refuses %s by its extension", (name) => {
    const refusal = blocked(normalizeAttachmentName(name)!);
    expect(refusal?.reason).toBe("extension");
  });

  it("names the extension it refused", () => {
    expect(blocked("Setup.EXE")).toEqual({ reason: "extension", value: "exe" });
  });

  it.each([
    ["text/html; charset=utf-8"], ["application/x-msdownload"], ["image/svg+xml"], ["application/javascript"], ["application/x-sh"],
    ["application/vnd.ms-excel.sheet.macroEnabled.12"], ["application/vnd.ms-word.document.macroenabled.12"], ["application/xhtml+xml"],
  ])("refuses a file declared as %s", (type) => {
    expect(blocked("notes.txt", type)).toEqual({ reason: "content_type", value: normalizeDeclaredContentType(type) });
  });

  it.each([
    ["report.pdf"], ["letter.docx"], ["budget.xlsx"], ["photos.zip"], ["IMG_0001.dng"], ["IMG_0001.CR3"], ["scan.tif"], ["notes.txt"],
    ["table.csv"], ["IMG_0001.xmp"], ["anim.gif"], ["photo.exe.pdf"], ["README"], ["clip.webm"], ["photo.heic"],
  ])("allows %s", (name) => {
    expect(blocked(name)).toBeNull();
  });
});

describe("attachmentPresignInput", () => {
  it("takes a name, a type and a size, and nothing else", () => {
    expect(attachmentPresignInput.parse({ name: "a.pdf", contentType: "application/pdf", bytes: 10 })).toEqual({ name: "a.pdf", contentType: "application/pdf", bytes: 10 });
    expect(attachmentPresignInput.safeParse({ name: "a.pdf", contentType: "application/pdf", bytes: 10, kind: "x" }).success).toBe(false);
    expect(attachmentPresignInput.safeParse({ name: "a.pdf", contentType: "application/pdf", bytes: 1.5 }).success).toBe(false);
  });
});
