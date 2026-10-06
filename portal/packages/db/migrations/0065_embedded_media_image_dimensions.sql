-- Embedded image dimensions (#611): the pixel size of the image as the browser decodes it, so a post can reserve the image's box before the file loads.
-- width and height are what the uploading browser measured (naturalWidth and naturalHeight) and the server only range-checks. NULL for every existing row, every video and every HEIC row, whose size is display_width and display_height once its JPEG copy exists.
-- Additive only and nullable, so a Worker older than this change ignores the columns and a rollback is safe. No trigger and no semicolon inside a comment: the worker test harness splits this file on semicolons.
ALTER TABLE embedded_media ADD COLUMN width integer;
--> statement-breakpoint
ALTER TABLE embedded_media ADD COLUMN height integer;
