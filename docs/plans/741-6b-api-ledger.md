# #741 slice 6b-api: reuse ledger

**No UI element is added in this slice.** It changes the Worker, the shared schemas and one copy line; nothing is rendered that was not already.

| Element | Item | Note |
|---|---|---|
| Paste dialog skip label for `drawing_outside` ("Drawing would fall outside the note") | existing `PASTE_SKIP_COPY` map in `components/video/VideoNotePasteDialog.tsx` | One string in a `Record<VideoNotePasteSkipReason, string>` that `tsc` requires to be exhaustive. No new component, no new markup. |

Searches for the other ledger classes found nothing to add: no new `<button>`, `<input>`, `<select>`, `<textarea>`, `<dialog>` or widget `role`, so `config/ui-primitive-allowlist.ts` is untouched.

## MCP

The MCP tools in `workers/app/src/mcp/tools/` do not expose video notes at all (`reads.ts` and `writes.ts` only mention video *links*; no tool lists, creates, edits or reads a video note, a reply, a resolution or a paste). So there is no video-note tool to extend with markup. Adding note tools is a separate decision. If they land, the strict envelope to reuse is `videoMarkupSchema` from `@quincy/shared`.
