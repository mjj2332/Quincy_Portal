# Attachments

An **Attachment** is any file shared on a post for people to download. It is never shown inline. Photos and videos that the
Portal can show in a post stay **Embedded media** (`docs/maps/` and `packages/shared/src/embedded-media.ts`). Spec #945, tracer #952.

Status: #952 covers **Project discussion comments** only, for staff and External editors (owner decision A1). The table already
allows the other owner kinds and a guest uploader. The Notice board (#954), Video notes (#955), guest notes on a Review link (#956),
and the clean-up sweep (#953) are later tickets. Notifications (#957) are covered for Project comments below.

## Limits

| | Staff and External | Guest (#956) |
|---|---|---|
| Size per file | 100 MB (`ATTACHMENT_MAX_BYTES`) | 25 MB |
| Per post | 10 Attachments, counted apart from the 10 photos or videos | 5 per note |

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
- An object's key is `projects/<projectId>/attachments/<id>/original`. It never contains a name the user supplied. Every object is
  stored as `application/octet-stream`, whatever the file is.
- The download route is `GET /media/attachments/:id`. **It serves only an `attached` row**, for every caller, the uploader
  included, so a file that was never posted or has been removed stops downloading at once. On a Project comment, the people who
  can download are the people who can see the Project's Collaboration tab. Staff who are not on the Project get a 403; an External
  editor outside the Project gets a 404.
- Every response has these headers: `content-type: application/octet-stream`, `content-disposition: attachment` with an ASCII
  fallback name and a `filename*` UTF-8 name, `x-content-type-options: nosniff`, `content-security-policy: default-src 'none';
  sandbox`, `cache-control: private, no-store`, `cross-origin-resource-policy: same-origin`, `referrer-policy: no-referrer`. Range
  requests return 206. The row's state is checked again after R2 answers and before any byte is sent.

## No malware scan in v1

This is a known limit. The mitigation is the blocklist on name and type, a forced download as octet-stream with `nosniff` and a
sandbox CSP, `no-store`, and reads limited to staff and the Project's own people. A renamed binary is served under its cleaned-up,
allowed name, so a file called `report.pdf` opens as a PDF. That is why there is no byte sniffing. Revisit this before guests can
upload (#956).

## Clean-up

- Deleting a comment detaches its Attachments in the same batch, so they stop downloading immediately.
- A Project hard delete aborts started uploads and queues every Attachment key into `embedded_media_cleanup` in the same batch as
  the cascade.
- Rows that were never posted or have been removed, and their objects, build up until the sweep in #953 ships. Ship #953 with
  this, or before this reaches production. The #549 orphan sweep does not recognise Attachment keys; #953 decides how to cover
  orphans.

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
`attachmentCountSuffix` in `packages/shared/src/project-activity.ts`. The other owner kinds join this when their tickets land.
