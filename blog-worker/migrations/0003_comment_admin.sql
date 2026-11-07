-- 后台直接回复评论：标记该条回复由站长发出
ALTER TABLE "wl_Comment" ADD COLUMN "is_admin" INTEGER NOT NULL DEFAULT 0;
