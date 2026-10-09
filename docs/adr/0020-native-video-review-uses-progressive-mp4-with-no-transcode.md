---
status: accepted
---

# Native video review uses progressive MP4 with no transcode

The studio reviews and delivers every property film in Frame.io, outside the Portal (epic #741).
We are replacing that with native video review in the Portal. The Portal runs on Cloudflare Workers,
where there is no FFmpeg and no long-running process, so the first question is how a film gets from
an editor's export to a frame-accurate player. A future reader will see a video pipeline with no
transcode, no streaming manifest and no managed video service, and will wonder why. That absence is
this decision.

## Decision

1. **Staff upload a web-ready H.264 MP4 with a constant frame rate, up to 2 GB.** The file is served
   exactly as uploaded, from storage, with HTTP byte-range support. There is no transcoding, no
   adaptive streaming, and no server-side FFmpeg.
2. **The server re-probes the stored file.** Upload is reserve, then a presigned multipart upload
   straight to storage, then complete. Completion re-reads the file's MP4 boxes from bounded byte reads
   and saves its own values for frame rate, frame count, duration, dimensions, codec, start timecode
   and fast-start status. A browser-supplied frame rate is never trusted.
3. **Unsupported means rejected with a plain reason:** not H.264, a variable frame rate, or an
   unsupported edit list. A non-fast-start MP4 is accepted with a warning that playback may begin slowly.
4. **A Version is immutable.** Notes store integer presentation frames against one exact Version, which
   is only safe because the file, and so its frame rate, can never change.
5. **The stream is private.** It is never cached publicly and never served with a download disposition
   to staff viewers; the project-access check applies to every range request.

## Considered options

- **HLS or other adaptive streaming.** Declined: it needs a transcode ladder and a packager, neither of
  which the Workers platform provides, and re-encoding would change frame timing that notes and NLE
  markers depend on.
- **Cloudflare Stream or another managed video service.** Declined: it adds a vendor, a per-minute cost
  and a re-encode, and the file the editor made is no longer the file under review.
- **Server-side FFmpeg.** Declined: there is nowhere to run it on Workers, and a separate transcode
  service is operational weight for a studio that already controls its export settings.

## Consequences

- Editors export to the supported shape (H.264, constant frame rate, fast-start). Anything else is
  re-exported by them; the Portal gives the reason.
- Playback quality is the uploaded file's quality. A 2 GB cap and a fast-start warning are the only
  levers, so seek and start-up speed depend on the export.
- The pure frame, timecode and probe logic is shared and testable without a browser. jsdom cannot decode
  video, so frame accuracy is proven in a real-browser pass with a burned-in frame counter.
- Frame and timecode logic is ported from the MIT-licensed FreeFrame project; see `THIRD_PARTY_NOTICES.md`.
