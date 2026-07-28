import { Hono } from "hono";
import { createDb, schema } from "@quincy/db";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCapability } from "../middleware/capability";
import { audit } from "../lib/audit";
import { newId } from "../lib/ids";
import { jsonInput } from "./helpers";

const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value === "" ? undefined : value, schema.optional());
const postsQuery = z.object({
  limit: optionalQuery(z.coerce.number().int().min(1).max(50)),
});
const postInput = z.object({ body: z.string().trim().min(1).max(2_000) });
const postId = z.string().uuid();

type PostRecord = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

function serializePost(row: {
  post: typeof schema.noticeBoardPosts.$inferSelect;
  authorName: string;
}): PostRecord {
  return {
    id: row.post.id,
    authorId: row.post.authorId,
    authorName: row.authorName,
    body: row.post.body,
    createdAt: row.post.createdAt.toISOString(),
  };
}

async function findPost(db: ReturnType<typeof createDb>, id: string) {
  return db.select({ post: schema.noticeBoardPosts, authorName: schema.user.name })
    .from(schema.noticeBoardPosts)
    .innerJoin(schema.user, eq(schema.noticeBoardPosts.authorId, schema.user.id))
    .where(eq(schema.noticeBoardPosts.id, id))
    .get();
}

export const noticeBoardRoutes = new Hono<AppEnv>();

noticeBoardRoutes.use("/notice-board", requireCapability("viewNoticeBoard"));
noticeBoardRoutes.use("/notice-board/*", requireCapability("viewNoticeBoard"));

noticeBoardRoutes.get("/notice-board/posts", async (c) => {
  const parsed = postsQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: "Invalid query", details: parsed.error.flatten() }, 400);
  const limit = parsed.data.limit ?? 50;
  const rows = await createDb(c.env.DB).select({ post: schema.noticeBoardPosts, authorName: schema.user.name })
    .from(schema.noticeBoardPosts)
    .innerJoin(schema.user, eq(schema.noticeBoardPosts.authorId, schema.user.id))
    .orderBy(desc(schema.noticeBoardPosts.createdAt), desc(schema.noticeBoardPosts.id))
    .limit(limit)
    .all();
  return c.json({ posts: rows.map(serializePost) });
});

noticeBoardRoutes.get("/notice-board/posts/latest", async (c) => {
  const post = await createDb(c.env.DB).select({ id: schema.noticeBoardPosts.id, createdAt: schema.noticeBoardPosts.createdAt })
    .from(schema.noticeBoardPosts)
    .orderBy(desc(schema.noticeBoardPosts.createdAt), desc(schema.noticeBoardPosts.id))
    .limit(1)
    .get();
  return c.json({ id: post?.id ?? null, createdAt: post?.createdAt.toISOString() ?? null });
});

noticeBoardRoutes.post("/notice-board/posts", async (c) => {
  const data = await jsonInput(c, postInput);
  if (data instanceof Response) return data;
  const id = newId();
  const createdAt = new Date();
  const user = c.get("user");
  const db = createDb(c.env.DB);
  await db.insert(schema.noticeBoardPosts).values({ id, authorId: user.id, body: data.body, createdAt });
  await audit(c.env, user.id, "notice_board.post", "notice_board_post", id);
  const post = await findPost(db, id);
  if (!post) return c.json({ error: "Post could not be created" }, 500);
  return c.json(serializePost(post), 201);
});

noticeBoardRoutes.delete("/notice-board/posts/:id", async (c) => {
  const id = c.req.param("id");
  if (!postId.safeParse(id).success) return c.json({ error: "Invalid post id" }, 400);
  const db = createDb(c.env.DB);
  const post = await db.select().from(schema.noticeBoardPosts).where(eq(schema.noticeBoardPosts.id, id)).get();
  if (!post) return c.json({ error: "Post not found" }, 404);
  const user = c.get("user");
  if (post.authorId !== user.id) return c.json({ error: "Forbidden: only the author can delete this post." }, 403);
  await db.delete(schema.noticeBoardPosts).where(eq(schema.noticeBoardPosts.id, id));
  await audit(c.env, user.id, "notice_board.delete", "notice_board_post", id);
  return c.json({ ok: true });
});
