# Attachments

An **Attachment** is any file shared on a post for people to download. It is never shown inline. Photos and videos that the
Portal can show in a post stay **Embedded media** (`docs/maps/` and `packages/shared/src/embedded-media.ts`). Spec #945, tracer #952.

Status: #952 covers **Project discussion comments**, for staff and External editors (owner decision A1). #954 adds **Notice board
posts**, for staff only. #955 adds **staff Video notes and replies**, with Guest reviewers downloading a public note's files.
#956 lets **Guest reviewers attach files** to their own notes, replies and edits on a Review link. The clean-up sweep (#953) and
notifications (#957: Project comments, Notice board posts, Video notes and replies) are below.

## Limits

| | Staff and External | Guest (#956) |
|---|---|---|
| Size per file | 100 MB (`ATTACHMENT_MAX_BYTES`) | 25 MB |
| Per post | 10 Attachments, counted apart from the 10 photos or videos | 5 per note (`ATTACHMENT_GUEST_MAX_PER_NOTE`) |
| Uploads | No upload limit | 20 per guest and 100 per link in 15 minutes (`GUEST_LIMITS.attachmentGuest` / `attachmentLink`) |

They live in `portal/packages/shared/src/attachments.ts`, which the composer and the API both import. The composer checks them
before an upload starts. That check is only a convenience: the server checks every one again, and when the two disagree the
composer shows the server's message as it is.

## What the paper clip does with a file

The composer looks at each picked, pasted or dropped file's **type, never its size**:

- A photo the person may embed (JPEG, PNG or WebP, plus HEIC when HEIC is on for them), or an MP4 or MOV on a Project, goes down
  the Embedded media path, with that path's own limits. A 30 MB JPEG is still a photo, so it gets the photo size error.
- Anything else becomes an Attachment. That includes GIF, TIFF, raw camera files, WebM, and HEIC when HEIC is off (owner decision A3).

An Attachment's chip appears as soon as the file is picked. While the file uploads, the chip shows its progress. If the upload
fails, the chip offers **Retry** (a new upload of the same file) and **Remove**. Post and Save wait while a file is still uploading
or has failed, so a post never goes out without one of its files. A refusal from the server (a blocked type, a file too large, a bad
name) removes the chip and shows the server's message, because sending the same file again cannot work.

## The blocklist

`ATTACHMENT_BLOCKED_EXTENSIONS` and `ATTACHMENT_BLOCKED_CONTENT_TYPES` in `packages/shared/src/attachments.ts`. A file is refused if
the **last extension of its cleaned-up name**, or its **declared type** (lower-cased, without parameters), is on the list. The list
covers:

- executables, installers and libraries for Windows, macOS, Linux, Android and iOS;
- shell scripts, script runtimes and scripts that run when opened;
- shortcuts and files that hook into the operating system shell;
- browser extensions;
- active web content (HTML, SVG, XSLT, MHTML);
- compiled help files;
- disk images that mount on their own;
- **macro-enabled Office files** (`.docm`, `.xlsm`, `.pptm` and similar, owner decision A2).

Archives (`.zip`, `.7z`) pass, and their contents are not opened. To change the list, edit the shared module and its tests in
`packages/shared/test/attachments.test.ts`. One change applies to the composer and the API together.

How a name is cleaned up (`normalizeAttachmentName`): convert to NFC; keep only the last path segment; remove control, bidi and
zero-width characters (so a right-to-left override cannot hide the real extension); turn `:*?"<>|` into spaces; collapse runs of
spaces; strip trailing dots and spaces (`evil.exe.` becomes `evil.exe`); cut the name to 255 UTF-8 bytes and keep its extension. A
name that ends up empty is refused.

## Storage and serving

- The table is `attachments` (migration 0082). Each row moves through `uploading`, `pending`, `attached` and `detached`. An
  `attached` row belongs to exactly one post (`owner_kind`, `owner_id`). Rows are created, attached and detached in the post's own
  batch (`workers/app/src/lib/attachments.ts`), next to the post's Embedded media reconciler. Each change writes an audit row:
  `attachment.presign`, `attachment.upload`, `attachment.attach` or `attachment.detach`.
- An object's key is `projects/<projectId>/attachments/<id>/original`, or `notice-board/attachments/<id>/original` for a Notice
  board post, whose row has no `project_id`. It never contains a name the user supplied. Every object is stored as
  `application/octet-stream`, whatever the file is.
- The Notice board has its own upload routes, `POST /api/notice-board/attachments` and `.../:id/direct|complete|abort`, behind the
  Notice board capability (an External editor gets 403). They run the same upload core (`workers/app/src/lib/attachment-upload.ts`)
  with no Project to fence on.
- The download route is `GET /media/attachments/:id`. **It serves only an `attached` row**, for every caller, the uploader
  included, so a file that was never posted or has been removed stops downloading at once. On a Project comment, the people who
  can download are the people who can see the Project's Collaboration tab. Staff who are not on the Project get a 403; an External
  editor outside the Project gets a 404. On a notice, the people who can download are the notice's audience: every role with the
  Notice board capability (staff). An External editor gets a 404.
- Every response has these headers: `content-type: application/octet-stream`, `content-disposition: attachment` with an ASCII
  fallback name and a `filename*` UTF-8 name, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none';
  sandbox`, `cache-control: private, no-store`, `cross-origin-resource-policy: same-origin`, `referrer-policy: no-referrer`. Range
  requests return 206. The row's state is checked again after R2 answers and before any byte is sent.

## Video notes (#955)

- A staff note, reply or edit takes files through the note box's paper clip (`VideoNoteEditor`, `owner: "video_note"`), with the
  comment's limits, blocklist and Send hold. Uploads go through `videoNoteUploadGate` (the people who may write a note), as the
  note's Embedded media does. Only the author's own pending files can be attached, in the note's batch; an edit that drops a chip
  detaches it, and a deleted note (and the replies a hard delete takes) detaches all of its files at once.
- A guest's note takes at most 5 (`GUEST_NOTE_RICH_TEXT_PROFILE`, #956, below).
- Staff download at `GET /media/attachments/:id` when they can open the note: the Video review `notes` part, `viewVideo`, Project
  access, and a live note on a live Version. Public and Internal notes alike.
- A Guest reviewer downloads at `GET /d/api/links/:linkId/attachments/:id`, under the link's cookie path. It serves only a file
  attached to a live **public** staff note or reply on a Version this link reaches; an Internal note's file, another Project's and a
  revoked link all get the same not-found stub. The headers are the staff route's (`attachmentDownloadHeaders`), and the link and
  note are checked again after R2 answers.
- A posted note reads its text, then its photo and video strip, then its files as C4 chips (`splitNoteFiles`, `NoteBody`).
- Notifications for a note or reply with files say how many (`attachmentCount` on the Video review payload, #957's suffix).

## Guest reviewers' files (#956)

- The paper clip in the Guest note box (new note, edit of the guest's own root note, reply) takes any file, as the staff box does.
  The link's own transport (`createGuestMediaTransport(...).files` in `apps/web/src/guest/guest-api.ts`) carries the guest limits.
  Post, Send and Save wait while a file is uploading or has failed.
- Upload routes, under the link's cookie path: `POST /d/api/links/:linkId/attachments` (presign: the file alone, with no `owner`),
  and `.../:id/direct` (dev only), `.../:id/complete` and `.../:id/abort` (`workers/app/src/guest/attachments.ts`). They run the
  staff upload core with the guest as uploader. The checks run in the guest media routes' order (`admit` in `guest/media.ts`):
  the link, its gate and its `guest` and `guest_comments` parts, then Origin, the session, a verified email (401), comments on (403)
  and an unarchived Project (409). A presign then takes one attempt from the guest's bucket and one from the link's (429) before
  the body is checked. These buckets are separate from the media quota. Every write repeats the guest fence in SQL
  (`guestMediaGuard`: the exact session and token, a verified guest, a live link with comments on). Abort is allowed with comments
  off. Audit rows have a null actor, with the guest, the session and the link in the meta.
- A file is attached only by the guest's own note write, in the note's batch: only files this guest uploaded and that are still
  pending, or files already on this note. A staff upload, another guest's file or another note's file is refused (409) and nothing
  is attached. A guest edits only their own notes, so they can remove only their own files. A reply under an Internal note gets the
  stub, so a guest's file never lands on an Internal note.
- A guest's files are public, as the guest's notes are. Staff download them at `GET /media/attachments/:id`, and every guest on
  the link downloads them at `GET /d/api/links/:linkId/attachments/:id`, with the same forced-download headers.

## No malware scan in v1

This is a known limit. The mitigation is the blocklist on name and type, a forced download as octet-stream with `nosniff` and a
sandbox CSP, `no-store`, and reads limited to staff and the Project's own people. A renamed binary is served under its cleaned-up,
allowed name, so a file called `report.pdf` opens as a PDF. That is why there is no byte sniffing.

Since #956, a Guest reviewer can upload, so anyone holding a Review link who verifies an email can put a file in front of staff
and the link's other guests. #956 adds the guest limits (25 MB, 5 a note, the upload rate limit) but no scan. Whether guest
uploads need a scan before they ship is still open for the owner.

## Clean-up

- Deleting a comment or a notice detaches its Attachments in the same batch, each with an audit row, so they stop downloading
  immediately.
- A Project hard delete aborts started uploads and queues every Attachment key into `embedded_media_cleanup` in the same batch as
  the cascade.
- The background Worker's daily embedded media sweep (`sweepAttachments` in `workers/background/src/embedded-media-sweep.ts`, #953)
  reclaims the rest, the lifecycle of Embedded media: an Attachment removed from its post is deleted seven days later, and one that was
  uploaded and never posted is deleted seven days after upload. A deleted comment's Attachments are detached at 0, so they are due on
  the next run. Backstop: an `attached` row whose comment, Notice board post or Video note no longer exists is detached at 0 and
  reclaimed. An expired `uploading` row is moved to `embedded_media_cleanup` so its multipart upload is aborted before the object goes.
  At most 100 rows a run. Tests: `workers/background/test/attachment-sweep.test.ts`.
- The #549 orphan sweep does not recognise Attachment keys. An object with no row and no queue entry (a double R2 and D1 failure) is
  not covered; that gap is accepted for now.

## Rollback

Migration 0082 only adds a table. An old Worker ignores it, so rolling back the code is safe (`CI-Deploy.md`, "Attachments (0082,
#952)"). If you roll back the code, a comment that holds an Attachment shows no file in an old client, and its text and media are
unaffected.

## Notifications (#957)

No new notification kind. A Project comment's existing notifications say how many Attachments it has, as a count only (never a
name): the Project activity notification (`project.comment.created` / `edited`, "A project comment was added with 2 attachments."),
the mention notification and its email ("You were mentioned in a project comment with 2 attachments."), and the digest, which
composes from the stored copy. The count rides on the activity's `safePayload.attachmentCount` (written by
`createProjectCommentActivityIntent`, omitted at zero; the edit records the comment's count after the edit) and is rendered by
`attachmentCountSuffix` in `packages/shared/src/project-activity.ts`. A Notice board post (#954) has no activity row: its mention
notification and email say the same ("You were mentioned in a notice-board post with 2 attachments."), from the count the route
passes to `notifyNoticeBoardMentions`.

A staff Video note or reply (#955) does the same on its Video review notification: "Mia left a note with 2 attachments on Main
walkthrough", "replied with 1 attachment", and a mention "mentioned you in a note with 3 attachments". The count rides on the
outbox payload's `video.attachmentCount` (`videoReviewOutboxStatements`, omitted at zero; a mention-on-edit records the note's count
after the edit).
