import { Hono } from "hono";
import type { Env, UserInfo, Variables } from "./waline/env.js";
import walineApp from "./waline/subapp.js";
import { signJwt, verifyJwt } from "./waline/middleware/auth.js";
import { hashPassword, verifyPassword } from "./waline/utils/password.js";
import { unzipSync } from "fflate";
import { renderAdminPage } from "./admin-ui.js";
import { renderAdminLoginPage } from "./admin-login.js";
import { sendMail } from "./mail/smtp.js";
import { renderMarkdown } from "./waline/utils/markdown.js";

// 整合后的完整 Bindings：博客文章(gh + D1 评论) + Waline(JWT/D1)
type Bindings = Env & {
  DB: D1Database;
  JWT_SECRET?: string;
  SITE_URL?: string;
  // 文章发布
  GH_TOKEN?: string;
  GH_REPO?: string;
  GH_BRANCH?: string;
  POSTS_DIR?: string;
  PAGES_URL?: string;
  // Cloudflare Workers AI：由部署工作流注入（与部署令牌同源），后台无需重复填写
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  // 专门用于 Workers AI / 额度查询的令牌（部署工作流注入，优先于 CF_API_TOKEN）
  CF_AI_TOKEN?: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// ---------- 0. 配置兜底：减少部署时的手动填写 ----------
// SITE_URL（对外域名）：未显式配置时，自动取当前请求的域名。
// 因此绑定自定义域名 / Workers 自带域名后，无需再手动配置该项（邮件里的链接也会用该域名）。
app.use("*", async (c, next) => {
  const env = c.env as Bindings;
  if (!env.SITE_URL) {
    try {
      (env as { SITE_URL?: string }).SITE_URL = new URL(c.req.url).origin;
    } catch {
      /* ignore */
    }
  }
  await maybeResetAdmin(env); // 「重置后台账号」工作流注入 ADMIN_RESET_ONCE 后，首个请求执行重置
  await next();
});

// PAGES_URL（GitHub Pages 地址）：未配置时按 GH_REPO 推导，形如 https://<owner>.github.io[/repo]
function pagesBaseUrl(env: Bindings): string {
  const raw = (env.PAGES_URL || "").trim();
  if (raw) return raw.replace(/\/+$/, "");
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec((env.GH_REPO || "").trim());
  if (m) {
    const owner = m[1];
    const name = m[2];
    return name.toLowerCase() === owner.toLowerCase() + ".github.io"
      ? `https://${owner}.github.io`
      : `https://${owner}.github.io/${name}`;
  }
  return "https://kf1145fan.github.io";
}

// ---------- 1. 统一鉴权（复用 Waline 管理员 JWT）----------
function isAdmin(user?: UserInfo): boolean {
  return !!user && user.type === "administrator";
}

// ---------- 2. Waline 评论系统挂载到 /waline/* ----------
// 主题中 serverURL 设为 blog.902786.xyz/waline，客户端会自动拼接 /api/xxx
app.route("/waline", walineApp);

// ---------- 3. 健康检查 ----------
app.get("/api/health", async (c) => {
  const env = c.env as Bindings;
  const jwtSet = !!env.JWT_SECRET;
  return json({
    ok: true,
    worker: "blog-worker",
    waline: true,
    ver: "1.0.0",
    jwt_set: jwtSet,
    gh_token_set: !!env.GH_TOKEN,
  });
});

// ---------- 3.1 站点初始化状态（首次部署时引导创建管理员）----------
// 无任何用户时返回 needInit=true，登录页据此自动切换到「创建管理员」表单。
app.get("/api/site/init", async (c) => {
  const db = (c.env as Bindings).DB;
  try {
    // 自愈：全新环境下 D1 迁移可能未执行，先确保用户表存在（否则注册也会失败）
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS "wl_Users" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "display_name" TEXT NOT NULL DEFAULT '',
          "email" TEXT NOT NULL DEFAULT '',
          "password" TEXT NOT NULL DEFAULT '',
          "type" TEXT NOT NULL DEFAULT 'guest',
          "label" TEXT DEFAULT '',
          "url" TEXT DEFAULT '',
          "avatar" TEXT DEFAULT '',
          "github" TEXT DEFAULT '',
          "twitter" TEXT DEFAULT '',
          "facebook" TEXT DEFAULT '',
          "google" TEXT DEFAULT '',
          "weibo" TEXT DEFAULT '',
          "qq" TEXT DEFAULT '',
          "2fa" TEXT DEFAULT '',
          "createdAt" TEXT DEFAULT (datetime('now')),
          "updatedAt" TEXT DEFAULT (datetime('now'))
        )`
      )
      .run();
    await db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS "idx_users_email" ON "wl_Users" ("email")`
      )
      .run();
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM "wl_Users"`)
      .first<{ count: number }>();
    return json({ ok: true, needInit: (row?.count ?? 0) === 0 });
  } catch (e) {
    console.error("site init check failed", e);
    return json({ ok: true, needInit: true });
  }
});

// ---------- 3.2 博客后台独立管理员体系（与 Waline 评论账号完全解耦）----------
// 独立表 bl_Admin（username 登录）+ 独立 JWT（payload 带 scope='blog-admin'）+ 独立 Cookie(bl_token)。
// 评论系统账号照旧用于评论，不再用于后台登录。
// 忘记密码时可在 GitHub Actions 手动运行「重置后台账号」工作流，重置为 admin/admin。
async function ensureAdminTable(db: D1Database): Promise<void> {
  // 自愈：检测旧表结构（email 列）——空表直接重建为 username 结构；有数据则补列迁移
  const cols = await db
    .prepare(`PRAGMA table_info("bl_Admin")`)
    .all<{ name: string }>();
  const hasUsername = (cols.results || []).some((r) => r.name === "username");
  if (cols.results && cols.results.length > 0) {
    if (hasUsername) {
      await db
        .prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_bl_admin_username" ON "bl_Admin" ("username")`,
        )
        .run();
      return;
    }
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM "bl_Admin"`)
      .first<{ count: number }>();
    if ((row?.count ?? 0) > 0) {
      await db
        .prepare(`ALTER TABLE "bl_Admin" ADD COLUMN "username" TEXT NOT NULL DEFAULT ''`)
        .run();
      await db.prepare(`UPDATE "bl_Admin" SET username = email`).run();
      await db
        .prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_bl_admin_username" ON "bl_Admin" ("username")`,
        )
        .run();
      return;
    }
    await db.prepare(`DROP TABLE "bl_Admin"`).run();
  }
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS "bl_Admin" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "username" TEXT NOT NULL DEFAULT '',
        "password" TEXT NOT NULL DEFAULT '',
        "createdAt" TEXT DEFAULT (datetime('now')),
        "updatedAt" TEXT DEFAULT (datetime('now'))
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS "idx_bl_admin_username" ON "bl_Admin" ("username")`,
    )
    .run();
}

// 从 Cookie / Authorization 头解析 bl_token 并校验（必须带 blog-admin scope，防止拿 Waline token 冒充）
function adminCookieToken(c: { req: { header: (k: string) => string | undefined; url: string } }): string | undefined {
  const cookie = c.req.header("Cookie") || "";
  const m = /(?:^|;\s*)bl_token=([^;]+)/.exec(cookie);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  const h = c.req.header("Authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7);
  return undefined;
}

async function adminPayload(
  token: string | undefined,
  secret?: string,
): Promise<{ id: number } | null> {
  if (!token || !secret) return null;
  try {
    const p = (await verifyJwt(token, secret)) as unknown as {
      id?: number;
      scope?: string;
    } | null;
    if (!p || !p.id || p.scope !== "blog-admin") return null;
    return { id: p.id };
  } catch {
    return null;
  }
}

const ADMIN_COOKIE = (token: string) =>
  `bl_token=${encodeURIComponent(token)};path=/;max-age=2592000;SameSite=Lax`;

// 一次性重置后台账号：「重置后台账号」工作流部署 Worker 时注入 ADMIN_RESET_ONCE 标志，
// 首个请求触发执行（Worker 自身有 D1 写权限，不依赖 CF_API_TOKEN 的 D1 权限）。
// 执行后把标志记入 bl_ResetFlag，同一部署内不会重复执行；正常部署不带该变量则完全不触发。
let adminResetDone = false;
async function maybeResetAdmin(env: Bindings): Promise<void> {
  const flag = (env as { ADMIN_RESET_ONCE?: string }).ADMIN_RESET_ONCE;
  if (!flag || adminResetDone) return;
  adminResetDone = true;
  const db = env.DB;
  try {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS "bl_ResetFlag" (
          "id" INTEGER PRIMARY KEY,
          "val" TEXT NOT NULL DEFAULT ''
        )`,
      )
      .run();
    const done = await db
      .prepare(`SELECT val FROM "bl_ResetFlag" WHERE id = 1`)
      .first<{ val: string }>();
    if (done?.val === flag) return; // 本次部署已执行过重置
    await ensureAdminTable(db);
    await db.prepare(`DELETE FROM "bl_Admin"`).run();
    await db
      .prepare(`INSERT INTO "bl_Admin" (username, password) VALUES (?, ?)`)
      .bind("admin", await hashPassword("admin"))
      .run();
    await db
      .prepare(
        `INSERT INTO "bl_ResetFlag" (id, val) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET val = excluded.val`,
      )
      .bind(flag)
      .run();
    console.log("ADMIN_RESET_ONCE: 后台账号已重置为 admin/admin");
  } catch (e) {
    console.error("ADMIN_RESET_ONCE failed", e);
    adminResetDone = false; // 失败允许下个请求重试
  }
}

// 后台所有 API 统一鉴权：bl_token 有效则注入 administrator 身份，路由内 isAdmin 检查照常生效
app.use("/admin/api/*", async (c, next) => {
  const p = await adminPayload(
    adminCookieToken(c),
    (c.env as Bindings).JWT_SECRET,
  );
  if (p) {
    c.set("userInfo", {
      objectId: p.id,
      display_name: "管理员",
      email: "",
      type: "administrator",
    } as UserInfo);
  }
  await next();
});

// 站点是否已初始化（bl_Admin 是否有管理员）
app.get("/api/admin/init", async (c) => {
  const db = (c.env as Bindings).DB;
  try {
    await ensureAdminTable(db);
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM "bl_Admin"`)
      .first<{ count: number }>();
    return json({ ok: true, needInit: (row?.count ?? 0) === 0 });
  } catch (e) {
    console.error("admin init check failed", e);
    return json({ ok: false, error: "数据库不可用" }, 500);
  }
});

// 首次创建管理员（仅当没有任何管理员时可用）
app.post("/api/admin/init", async (c) => {
  const env = c.env as Bindings;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const username = String((body as { username?: unknown }).username || "").trim();
  const password = String((body as { password?: unknown }).password || "");
  if (!username || !password)
    return json({ ok: false, error: "请输入用户名和密码" }, 400);
  if (!env.JWT_SECRET)
    return json({ ok: false, error: "JWT_SECRET 未配置" }, 500);
  const db = env.DB;
  try {
    await ensureAdminTable(db);
    const row = await db
      .prepare(`SELECT COUNT(*) AS count FROM "bl_Admin"`)
      .first<{ count: number }>();
    if ((row?.count ?? 0) > 0)
      return json({ ok: false, error: "管理员已存在，请直接登录" }, 403);
    const r = await db
      .prepare(`INSERT INTO "bl_Admin" (username, password) VALUES (?, ?)`)
      .bind(username, await hashPassword(password))
      .run();
    const id = r.meta?.last_row_id;
    const token = await signJwt(
      { id: id as number, scope: "blog-admin" } as never,
      env.JWT_SECRET,
    );
    c.header("Set-Cookie", ADMIN_COOKIE(token));
    return c.json({ ok: true, username });
  } catch (e) {
    console.error("admin init failed", e);
    return json({ ok: false, error: "创建失败（用户名可能已被占用），请重试" }, 500);
  }
});

// 登录
app.post("/api/admin/login", async (c) => {
  const env = c.env as Bindings;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const username = String((body as { username?: unknown }).username || "").trim();
  const password = String((body as { password?: unknown }).password || "");
  if (!username || !password)
    return json({ ok: false, error: "请输入用户名和密码" }, 400);
  const db = env.DB;
  try {
    await ensureAdminTable(db);
    const user = await db
      .prepare(`SELECT * FROM "bl_Admin" WHERE username = ?`)
      .bind(username)
      .first<{ id: number; password: string }>();
    if (!user || !(await verifyPassword(password, user.password)))
      return json({ ok: false, error: "用户名或密码错误" }, 401);
    if (!env.JWT_SECRET)
      return json({ ok: false, error: "JWT_SECRET 未配置" }, 500);
    const token = await signJwt(
      { id: user.id as number, scope: "blog-admin" } as never,
      env.JWT_SECRET,
    );
    c.header("Set-Cookie", ADMIN_COOKIE(token));
    return c.json({ ok: true, username });
  } catch (e) {
    console.error("admin login failed", e);
    return json({ ok: false, error: "登录失败，请重试" }, 500);
  }
});

// 当前登录信息
app.get("/api/admin/me", async (c) => {
  const p = await adminPayload(
    adminCookieToken(c),
    (c.env as Bindings).JWT_SECRET,
  );
  if (!p) return json({ ok: false, error: "unauthorized" }, 401);
  const user = await (c.env as Bindings).DB.prepare(
    `SELECT username FROM "bl_Admin" WHERE id = ?`,
  )
    .bind(p.id)
    .first<{ username: string }>();
  return json({ ok: true, username: user?.username || "" });
});

// 退出登录（清 Cookie）
app.post("/api/admin/logout", (c) => {
  c.header("Set-Cookie", "bl_token=;path=/;max-age=0;SameSite=Lax");
  return c.json({ ok: true });
});

// 修改管理员账号（用户名 / 密码，需先登录并验证旧密码；两者都可独立修改）
app.post("/api/admin/account", async (c) => {
  const env = c.env as Bindings;
  const p = await adminPayload(adminCookieToken(c), env.JWT_SECRET);
  if (!p) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const oldPassword = String(
    (body as { old_password?: unknown }).old_password || "",
  );
  const newPassword = String(
    (body as { new_password?: unknown }).new_password || "",
  );
  const newUsername = String(
    (body as { new_username?: unknown }).new_username || "",
  ).trim();
  if (!oldPassword) return json({ ok: false, error: "请输入旧密码" }, 400);
  if (!newUsername && !newPassword)
    return json({ ok: false, error: "没有需要修改的内容" }, 400);
  if (newPassword && newPassword.length < 6)
    return json({ ok: false, error: "新密码至少 6 位" }, 400);
  const db = env.DB;
  const user = await db
    .prepare(`SELECT username, password FROM "bl_Admin" WHERE id = ?`)
    .bind(p.id)
    .first<{ username: string; password: string }>();
  // 旧密码错误用 403（401 会让前端跳回登录页）
  if (!user || !(await verifyPassword(oldPassword, user.password)))
    return json({ ok: false, error: "旧密码错误" }, 403);
  if (newUsername && newUsername !== user.username) {
    if (newUsername.length < 2 || newUsername.length > 32)
      return json({ ok: false, error: "用户名需为 2-32 个字符" }, 400);
    const dup = await db
      .prepare(`SELECT id FROM "bl_Admin" WHERE username = ? AND id != ?`)
      .bind(newUsername, p.id)
      .first();
    if (dup) return json({ ok: false, error: "该用户名已被占用" }, 400);
  }
  const sets: string[] = [];
  const args: unknown[] = [];
  if (newUsername && newUsername !== user.username) {
    sets.push("username = ?");
    args.push(newUsername);
  }
  if (newPassword) {
    sets.push("password = ?");
    args.push(await hashPassword(newPassword));
  }
  if (sets.length) {
    sets.push(`updatedAt = datetime('now')`);
    await db
      .prepare(`UPDATE "bl_Admin" SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...args, p.id)
      .run();
  }
  return json({ ok: true, username: newUsername || user.username });
});

// ---------- 3.5 访问量统计 API ----------
// 允许跨域（博客静态站可能部署在 github.io 等其它域名）
const VISIT_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
const visitJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...VISIT_CORS },
  });

// 日期按东八区（Asia/Shanghai）计算，格式 YYYY-MM-DD；offsetDays 表示往前推几天
function visitDay(offsetDays = 0): string {
  const t = Date.now() + 8 * 3600 * 1000 - offsetDays * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// 数据默认保留 365 天（可在后台「访问量」页调整）
const VISIT_DEFAULT_RETENTION = 365;

// 确保访问量表存在（自愈：CI 的 D1 迁移可能因令牌权限失败，此处按需建表）
let visitTablesReady: Promise<unknown> | null = null;
function ensureVisitTables(db: D1Database): Promise<unknown> {
  if (!visitTablesReady) {
    visitTablesReady = db
      .batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_Visit" ("day" TEXT PRIMARY KEY, "count" INTEGER NOT NULL DEFAULT 0)`
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_VisitVisitor" ("day" TEXT NOT NULL, "visitor" TEXT NOT NULL, PRIMARY KEY("day","visitor"))`
        ),
        // 按来源站点统计（新增，历史 wl_Visit 汇总数据保持不动）
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_VisitSite" (
            "day" TEXT NOT NULL,
            "site" TEXT NOT NULL,
            "count" INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY("day","site")
          )`
        ),
        // 按站点去重：同一访客同一天在同一站点只计一次
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_VisitVisitorSite" (
            "day" TEXT NOT NULL,
            "site" TEXT NOT NULL,
            "visitor" TEXT NOT NULL,
            PRIMARY KEY("day","site","visitor")
          )`
        ),
        // 保留天数等设置存放于此（与 Waline 共用 wl_Settings，缺失时自愈创建）
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_Settings" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL DEFAULT '', "updatedAt" TEXT DEFAULT (datetime('now')))`
        ),
      ])
      .catch((e) => {
        visitTablesReady = null;
        throw e;
      });
  }
  return visitTablesReady;
}

// 读取数据保留天数（存于 wl_Settings，默认 365）
async function visitRetention(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT "value" FROM "wl_Settings" WHERE "key"=?1`)
      .bind("visit_retention_days")
      .first<{ value: string }>();
    const n = parseInt(row?.value ?? "", 10);
    if (Number.isFinite(n) && n >= 1 && n <= 3650) return n;
  } catch (e) {
    /* wl_Settings 不存在等情况忽略，用默认值 */
  }
  return VISIT_DEFAULT_RETENTION;
}

// 读取今日/总访问量
async function visitStats(db: D1Database) {
  const day = visitDay();
  await ensureVisitTables(db);
  const row = await db
    .prepare(
      `SELECT (SELECT "count" FROM "wl_Visit" WHERE "day"=?1) AS today,
              (SELECT COALESCE(SUM("count"),0) FROM "wl_Visit") AS total`
    )
    .bind(day)
    .first<{ today: number | null; total: number }>();
  return { today: row?.today ?? 0, total: row?.total ?? 0 };
}

// 最近 days 天的访问趋势（缺失日期补 0）；传 site 时只看该站点
async function visitDaily(db: D1Database, days: number, site = "") {
  await ensureVisitTables(db);
  const from = visitDay(days - 1);
  const rows = site
    ? await db
        .prepare(
          `SELECT "day","count" FROM "wl_VisitSite" WHERE "site"=?1 AND "day">=?2 ORDER BY "day" ASC`
        )
        .bind(site, from)
        .all<{ day: string; count: number }>()
    : await db
        .prepare(`SELECT "day","count" FROM "wl_Visit" WHERE "day">=?1 ORDER BY "day" ASC`)
        .bind(from)
        .all<{ day: string; count: number }>();
  const map = new Map<string, number>();
  (rows.results || []).forEach((r) => map.set(r.day, r.count));
  const series: { day: string; count: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = visitDay(i);
    series.push({ day: d, count: map.get(d) ?? 0 });
  }
  return series;
}

// 最近 days 天各站点的逐日访问量（用于折线图悬停时显示站点拆分）
async function visitDailyBySite(db: D1Database, days: number) {
  await ensureVisitTables(db);
  const from = visitDay(days - 1);
  const rows = await db
    .prepare(
      `SELECT "day","site","count" FROM "wl_VisitSite" WHERE "day">=?1 ORDER BY "day" ASC`
    )
    .bind(from)
    .all<{ day: string; site: string; count: number }>();
  const bySite = new Map<string, Map<string, number>>();
  (rows.results || []).forEach((r) => {
    if (!r.site) return;
    let m = bySite.get(r.site);
    if (!m) {
      m = new Map<string, number>();
      bySite.set(r.site, m);
    }
    m.set(r.day, (m.get(r.day) || 0) + (Number(r.count) || 0));
  });
  const out: { site: string; series: { day: string; count: number }[] }[] = [];
  bySite.forEach((m, s) => {
    const series: { day: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = visitDay(i);
      series.push({ day: d, count: m.get(d) ?? 0 });
    }
    out.push({ site: s, series });
  });
  out.sort(
    (a, b) =>
      b.series.reduce((x, y) => x + y.count, 0) - a.series.reduce((x, y) => x + y.count, 0)
  );
  return out;
}

// 过期数据清理：同一隔离实例每天最多执行一次
let lastCleanupDay = "";
async function visitCleanup(db: D1Database) {
  const today = visitDay();
  if (lastCleanupDay === today) return;
  lastCleanupDay = today;
  try {
    const retention = await visitRetention(db);
    const cutoff = visitDay(retention - 1);
    await db.batch([
      db.prepare(`DELETE FROM "wl_Visit" WHERE "day"<?1`).bind(cutoff),
      db.prepare(`DELETE FROM "wl_VisitVisitor" WHERE "day"<?1`).bind(cutoff),
      db.prepare(`DELETE FROM "wl_VisitSite" WHERE "day"<?1`).bind(cutoff),
      db.prepare(`DELETE FROM "wl_VisitVisitorSite" WHERE "day"<?1`).bind(cutoff),
    ]);
  } catch (e) {
    console.error("visit cleanup failed", e);
  }
}

// 访客标识：IP + UA 的 SHA-256（同一访客当天只计一次）
async function visitorId(c: { req: { header: (k: string) => string | undefined } }): Promise<string> {
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";
  const ua = c.req.header("user-agent") || "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + ua));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

// 来源站点归一化：只保留域名（去掉协议、路径、端口、www.），非法值返回空
function normalizeSite(raw: string): string {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.replace(/:\d+$/, "").replace(/^www\./, "");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(s)) return "";
  return s.slice(0, 100);
}

// 判断本次访问来自哪个站点：请求方显式传 site > Origin > Referer > Host
// （博客页面与自己域名的 /api 同源，Host 即站点域名；跨域嵌入时用 Origin/Referer）
function requestSite(c: {
  req: {
    header: (k: string) => string | undefined;
  };
}): string {
  const origin = normalizeSite(c.req.header("origin") || "");
  if (origin) return origin;
  const referer = normalizeSite(c.req.header("referer") || "");
  if (referer) return referer;
  const host = normalizeSite(c.req.header("x-forwarded-host") || c.req.header("host") || "");
  return host || "unknown";
}

// 按来源站点统计：区间内 / 今日 / 累计 + 历史（未区分站点）数量
async function visitSiteStats(db: D1Database, days: number) {
  await ensureVisitTables(db);
  const day = visitDay();
  const from = visitDay(days - 1);
  const [rangeRows, totalRows, dayRow, allRow] = await Promise.all([
    db
      .prepare(
        `SELECT "site",
                SUM("count") AS "range",
                SUM(CASE WHEN "day"=?1 THEN "count" ELSE 0 END) AS "today"
         FROM "wl_VisitSite" WHERE "day">=?2 GROUP BY "site" ORDER BY "range" DESC`
      )
      .bind(day, from)
      .all<{ site: string; range: number; today: number }>(),
    db
      .prepare(`SELECT "site", SUM("count") AS "total" FROM "wl_VisitSite" GROUP BY "site"`)
      .all<{ site: string; total: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM("count"),0) AS "range" FROM "wl_Visit" WHERE "day">=?1`
      )
      .bind(from)
      .first<{ range: number }>(),
    db
      .prepare(
        `SELECT (SELECT COALESCE("count",0) FROM "wl_Visit" WHERE "day"=?1) AS "today",
                (SELECT COALESCE(SUM("count"),0) FROM "wl_Visit") AS "total"`
      )
      .bind(day)
      .first<{ today: number; total: number }>(),
  ]);
  const totals = new Map<string, number>();
  (totalRows.results || []).forEach((r) => totals.set(r.site, Number(r.total) || 0));
  const sites = (rangeRows.results || []).map((r) => ({
    site: r.site,
    today: Number(r.today) || 0,
    range: Number(r.range) || 0,
    total: totals.get(r.site) ?? (Number(r.range) || 0),
  }));
  const known = sites.reduce((a, b) => a + b.range, 0);
  const rangeTotal = Number(dayRow?.range) || 0;
  return {
    days,
    sites,
    rangeTotal,
    todayAll: Number(allRow?.today) || 0,
    totalAll: Number(allRow?.total) || 0,
    // 历史（升级前未区分站点的记录）保留并在后台单独展示
    legacy: Math.max(0, rangeTotal - known),
  };
}

// 预检
app.options("/api/visit", (c) => new Response(null, { status: 204, headers: VISIT_CORS }));

// 查询：GET /api/visit/stats
app.get("/api/visit/stats", async (c) => {
  try {
    const s = await visitStats((c.env as Bindings).DB);
    return visitJson({ ok: true, ...s });
  } catch (e) {
    console.error("visit stats failed", e);
    return visitJson({ ok: false, today: 0, total: 0 });
  }
});

// 记录一次访问：POST /api/visit（同一访客同一天在同一站点只计一次，刷新不重复计数）
// 可选 body: {"site":"https://1.com"}；不传则按 Origin / Referer / Host 自动识别来源站点
app.post("/api/visit", async (c) => {
  const db = (c.env as Bindings).DB;
  const day = visitDay();
  try {
    const body = (await c.req.json().catch(() => ({}))) as { site?: unknown };
    const site = normalizeSite(String(body?.site ?? "")) || requestSite(c);
    await ensureVisitTables(db);
    const vid = await visitorId(c);
    const ins = await db
      .prepare(
        `INSERT OR IGNORE INTO "wl_VisitVisitorSite" ("day","site","visitor") VALUES (?1,?2,?3)`
      )
      .bind(day, site, vid)
      .run();
    const counted = ((ins.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
    if (counted) {
      await db.batch([
        db
          .prepare(
            `INSERT INTO "wl_Visit" ("day","count") VALUES (?1,1)
             ON CONFLICT("day") DO UPDATE SET "count"="count"+1`
          )
          .bind(day),
        db
          .prepare(
            `INSERT INTO "wl_VisitSite" ("day","site","count") VALUES (?1,?2,1)
             ON CONFLICT("day","site") DO UPDATE SET "count"="count"+1`
          )
          .bind(day, site),
        // 旧表继续写入，保证历史口径数据完整（仅记录，不再参与去重判断）
        db
          .prepare(`INSERT OR IGNORE INTO "wl_VisitVisitor" ("day","visitor") VALUES (?1,?2)`)
          .bind(day, vid),
      ]);
    }
    try {
      c.executionCtx.waitUntil(visitCleanup(db));
    } catch (e) {
      /* 无 executionCtx 时忽略 */
    }
    const s = await visitStats(db);
    return visitJson({ ok: true, counted, site, ...s });
  } catch (e) {
    console.error("visit record failed", e);
    return visitJson({ ok: false, today: 0, total: 0 });
  }
});

// ---------- 3.9 后台直接回复评论（站长回复）----------
// 以管理员身份写入回复：默认已通过、前台显示站长标识、后台可看到「站长」标记。
// 回复昵称取仓库根目录 _config.yml 的 author（成功结果缓存，失败回退「站长」）。
let cachedBlogAuthor = "";
async function getBlogAuthor(env: Bindings): Promise<string> {
  if (cachedBlogAuthor) return cachedBlogAuthor;
  const repo = (env.GH_REPO || "").trim();
  const branch = (env.GH_BRANCH || "HEAD").trim();
  if (repo) {
    try {
      const resp = await fetch(
        `https://raw.githubusercontent.com/${repo}/${branch}/_config.yml`,
        { headers: { "User-Agent": "blog-worker" } },
      );
      if (resp.ok) {
        const text = await resp.text();
        const m = /^author:\s*(.+?)\s*$/m.exec(text);
        const name = m?.[1]?.replace(/^["']|["']$/g, "").trim();
        if (name) cachedBlogAuthor = name;
      }
    } catch (e) {
      console.error("getBlogAuthor failed", e);
    }
  }
  return cachedBlogAuthor || "站长";
}

let commentAdminColumnReady = false;
async function ensureCommentAdminColumn(db: D1Database): Promise<void> {
  if (commentAdminColumnReady) return;
  try {
    await db
      .prepare(
        `ALTER TABLE "wl_Comment" ADD COLUMN "is_admin" INTEGER NOT NULL DEFAULT 0`,
      )
      .run();
  } catch {
    // 列已存在（迁移已执行）时忽略
  }
  commentAdminColumnReady = true;
}

app.post("/admin/api/comment/reply", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    parentId?: unknown;
    comment?: unknown;
  };
  const parentId = parseInt(String(body.parentId ?? ""), 10);
  const text = String(body.comment ?? "").trim();
  if (!Number.isFinite(parentId) || parentId <= 0) {
    return json({ error: "缺少被回复的评论" }, 400);
  }
  if (!text) return json({ error: "回复内容不能为空" }, 400);
  if (text.length > 65536) return json({ error: "回复内容过长（最多 64KB）" }, 400);

  const env = c.env as Bindings;
  const db = env.DB;
  try {
    await ensureCommentAdminColumn(db);
    const parent = await db
      .prepare(`SELECT * FROM "wl_Comment" WHERE id = ?`)
      .bind(parentId)
      .first<Record<string, any>>();
    if (!parent) return json({ error: "被回复的评论不存在" }, 404);

    const rid = (parent.rid as number) || parentId;
    const ip = c.req.header("CF-Connecting-IP") || "";
    const nick = await getBlogAuthor(env);
    // RETURNING 与 INSERT 同语句执行，避免 last_insert_rowid() 跨请求失效
    const row = await db
      .prepare(
        `INSERT INTO "wl_Comment"
          (user_id, comment, orig, ip, link, mail, nick, pid, rid, sticky, status, "like", ua, url, is_admin)
         VALUES (NULL, ?, ?, ?, '', '', ?, ?, ?, 0, 'approved', 0, '', ?, 1)
         RETURNING *`,
      )
      .bind(
        renderMarkdown(text),
        text,
        ip,
        nick,
        parentId,
        rid,
        (parent.url as string) || "",
      )
      .first<Record<string, any>>();
    if (!row) return json({ error: "回复失败" }, 500);
    return json({
      ok: true,
      data: {
        objectId: row?.id,
        comment: row?.comment,
        orig: row?.orig,
        nick,
        pid: parentId,
        rid,
        url: row?.url,
        status: "approved",
        is_admin: 1,
      },
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ---------- 4. 文章管理 API（需博客管理员 bl_token，见上方 /admin/api/* 中间件）----------

app.get("/admin/api/posts", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleListPosts(c.env as Bindings);
});

app.get("/admin/api/post", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const path = c.req.query("path") || "";
  if (!path) return json({ error: "path required" }, 400);
  return handleGetPost(c.env as Bindings, path);
});

app.post("/admin/api/post", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleWritePost(c.env as Bindings, await c.req.json(), false);
});

app.put("/admin/api/post", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleWritePost(c.env as Bindings, await c.req.json(), true);
});

// 删除文章（移入回收站）：DELETE /admin/api/post?path=xxx
app.delete("/admin/api/post", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const path = c.req.query("path") || "";
  if (!path) return json({ error: "path required" }, 400);
  const r = await handleRecyclePaths(c.env as Bindings, [path]);
  const build = r.moved > 0 ? await afterContentChange(c.env as Bindings) : {};
  return json({ ...r, ...build, message: r.moved ? "已移入回收站" : "" });
});

// 批量删除文章（移入回收站）：POST /admin/api/posts/delete  body { paths: string[] }
app.post("/admin/api/posts/delete", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { paths?: unknown };
  const r = await handleRecyclePaths(c.env as Bindings, body.paths);
  const build = r.moved > 0 ? await afterContentChange(c.env as Bindings) : {};
  return json({ ...r, ...build });
});

// 批量上传文章：POST /admin/api/posts/upload  body { files: [{name, content}] }
app.post("/admin/api/posts/upload", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { files?: unknown };
  return handleUploadPosts(c.env as Bindings, body.files);
});

// 部署工作流状态：/admin/api/build
app.get("/admin/api/build", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleBuildStatus(c.env as Bindings);
});

// 手动触发部署工作流：/admin/api/build/trigger
app.post("/admin/api/build/trigger", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleTriggerBuild(c.env as Bindings);
});

// 部署历史记录：/admin/api/build/history
app.get("/admin/api/build/history", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleBuildHistory(c.env as Bindings);
});

// 部署工作流日志：/admin/api/build/log?id=<runId>
// 由 Cloudflare 直接代理获取 GitHub Actions 运行日志（zip）并解压为文本，前端无需跳转 GitHub。
// id 缺省时取最近一次 deploy.yml 运行。
app.get("/admin/api/build/log", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleBuildLog(c.env as Bindings, c.req.query("id") || "", c.req.query("workflow") || "");
});

// ---------- 通用工作流管理（列出 / 运行记录 / 运行 / 取消 / 克隆仓库）----------
app.get("/admin/api/workflows", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleListWorkflows(c.env as Bindings);
});

app.get("/admin/api/workflows/runs", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleWorkflowRuns(c.env as Bindings, c.req.query("workflow") || "", Number(c.req.query("limit") || 20));
});

app.post("/admin/api/workflows/trigger", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleTriggerWorkflow(c.env as Bindings, await c.req.json().catch(() => ({})));
});

app.post("/admin/api/workflows/cancel", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleCancelWorkflow(c.env as Bindings, await c.req.json().catch(() => ({})));
});

app.post("/admin/api/clone-repo", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleCloneRepo(c.env as Bindings, await c.req.json().catch(() => ({})));
});

// 主题管理：列出 themes 目录主题 / 切换主题
app.get("/admin/api/themes", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleListThemes(c.env as Bindings);
});

app.post("/admin/api/themes/switch", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleSwitchTheme(c.env as Bindings, await c.req.json().catch(() => ({})));
});

// ---------- 访问量（仅管理员可见）----------
// 最近 N 天趋势：/admin/api/visit/daily?days=30
app.get("/admin/api/visit/daily", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const raw = parseInt(c.req.query("days") || "30", 10);
  const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 3650) : 30;
  const site = normalizeSite(c.req.query("site") || "");
  try {
    const series = await visitDaily((c.env as Bindings).DB, days, site);
    // 全部站点视图：附带各站点逐日数据，供折线图悬停时显示站点拆分
    const siteSeries = site ? [] : await visitDailyBySite((c.env as Bindings).DB, days);
    return json({
      ok: true,
      days,
      site,
      series,
      siteSeries,
      sum: series.reduce((a, b) => a + b.count, 0),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 按站点明细：/admin/api/visit/sites?days=30
app.get("/admin/api/visit/sites", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const raw = parseInt(c.req.query("days") || "30", 10);
  const days = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 3650) : 30;
  try {
    return json({ ok: true, ...(await visitSiteStats((c.env as Bindings).DB, days)) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 删除某个站点的历史访问明细：/admin/api/visit/site?site=1.com
// 只删站点明细，不动 wl_Visit 总量；这些访问量会在后台自动归入「未分类」，总访问量保持不变。
app.delete("/admin/api/visit/site", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const site = normalizeSite(c.req.query("site") || "");
  if (!site) return json({ error: "站点无效" }, 400);
  const db = (c.env as Bindings).DB;
  try {
    await ensureVisitTables(db);
    const res = await db.batch([
      db.prepare(`DELETE FROM "wl_VisitSite" WHERE "site"=?1`).bind(site),
      db.prepare(`DELETE FROM "wl_VisitVisitorSite" WHERE "site"=?1`).bind(site),
    ]);
    const deleted =
      ((res?.[0]?.meta as { changes?: number } | undefined)?.changes ?? 0);
    return json({ ok: true, site, deleted });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 读取设置：/admin/api/visit/settings
app.get("/admin/api/visit/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  try {
    await ensureVisitTables(db);
    return json({ ok: true, retention_days: await visitRetention(db) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 保存设置：/admin/api/visit/settings（数据保留天数，1-3650）
app.put("/admin/api/visit/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { retention_days?: unknown };
  const n = parseInt(String(body?.retention_days ?? ""), 10);
  if (!Number.isFinite(n) || n < 1 || n > 3650) {
    return json({ error: "retention_days 需为 1-3650 的整数" }, 400);
  }
  try {
    await ensureVisitTables((c.env as Bindings).DB);
    await (c.env as Bindings).DB.prepare(
      `INSERT INTO "wl_Settings" ("key","value","updatedAt") VALUES (?1,?2,datetime('now'))
       ON CONFLICT("key") DO UPDATE SET "value"=?2, "updatedAt"=datetime('now')`
    )
      .bind("visit_retention_days", String(n))
      .run();
    return json({ ok: true, retention_days: n });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---------- 3.55 站点功能设置（访客评论开关、数据保留等）----------
// 统一存于 wl_Settings，供后台「设置」标签页读写
async function getSiteSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  try {
    const row = await db
      .prepare(`SELECT "value" FROM "wl_Settings" WHERE "key"=?1`)
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? fallback;
  } catch (e) {
    return fallback;
  }
}
async function setSiteSetting(db: D1Database, key: string, value: string): Promise<void> {
  await ensureVisitTables(db);
  await db
    .prepare(
      `INSERT INTO "wl_Settings" ("key","value","updatedAt") VALUES (?1,?2,datetime('now'))
       ON CONFLICT("key") DO UPDATE SET "value"=?2,"updatedAt"=datetime('now')`
    )
    .bind(key, value)
    .run();
}

// 工作流触发模式（后台「设置 → 后台设置」）：auto=发文/删文后自动运行工作流；manual=只推 GitHub，等管理员手动运行
async function workflowModeOf(env: Bindings): Promise<"auto" | "manual"> {
  try {
    return (await getSiteSetting(env.DB, "workflow_mode", "auto")) === "manual" ? "manual" : "auto";
  } catch {
    return "auto";
  }
}

app.get("/admin/api/site/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  try {
    const allowGuest = (await getSiteSetting(db, "allow_guest_comment", "true")) !== "false";
    return json({
      ok: true,
      allow_guest_comment: allowGuest,
      retention_days: await visitRetention(db),
      workflow_mode: await workflowModeOf(c.env as Bindings),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

app.put("/admin/api/site/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (body.allow_guest_comment !== undefined) {
      await setSiteSetting(db, "allow_guest_comment", body.allow_guest_comment ? "true" : "false");
    }
    if (body.retention_days !== undefined) {
      const n = parseInt(String(body.retention_days), 10);
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        return json({ error: "retention_days 需为 1-3650 的整数" }, 400);
      }
      await setSiteSetting(db, "visit_retention_days", String(n));
    }
    if (body.workflow_mode !== undefined) {
      await setSiteSetting(db, "workflow_mode", body.workflow_mode === "manual" ? "manual" : "auto");
    }
    const allowGuest = (await getSiteSetting(db, "allow_guest_comment", "true")) !== "false";
    return json({
      ok: true,
      allow_guest_comment: allowGuest,
      retention_days: await visitRetention(db),
      workflow_mode: await workflowModeOf(c.env as Bindings),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---------- 3.58 AI 设置（OpenAI 兼容接口）----------
// 配置统一存于 wl_Settings(key=ai_config)，序列化为 JSON，模仿订阅配置的写法。
// 注意：评论区垃圾过滤另行使用 llm_endpoint/llm_api_key/llm_model/llm_prompt，
// 与本模块的 ai_config 相互独立。
interface AiConfig {
  baseUrl: string; // API 基础地址，如 https://api.openai.com/v1
  apiKey: string; // API 密钥（读取接口不回传明文）
  model: string; // 默认模型
  models: string[]; // 可选模型列表（AI 助手中可切换）
  prompt: string; // 系统提示词（AI 助手的角色设定）
  enabled: boolean; // 是否启用
  clientProxy: boolean; // 前端代理：由浏览器直连服务商
  permission: string; // 权限级别：safe 安全访问 / important 重要确认 / all 全部确认 / full 完全访问
  // Cloudflare Workers AI（与上面的自定义接口相互独立，模型以 @cf/ 开头）
  cfEnabled: boolean; // 是否启用 Cloudflare Workers AI
  cfAccountId: string; // Cloudflare 账户 ID
  cfApiKey: string; // Cloudflare API 令牌（需 Workers AI 权限，读取接口不回传明文）
  cfModels: string[]; // 勾选启用的 Cloudflare 模型
}

const AI_DEFAULT_CONFIG: AiConfig = {
  baseUrl: "",
  apiKey: "",
  model: "",
  models: [],
  prompt: "",
  enabled: false,
  clientProxy: false,
  permission: "safe",
  cfEnabled: false,
  cfAccountId: "",
  cfApiKey: "",
  cfModels: [],
};

// 权限级别白名单：非法值回退为 safe（安全访问）
const AI_PERMISSIONS = ["safe", "important", "all", "full"];
function normalizePermission(v: unknown): string {
  const s = String(v ?? "").trim();
  return AI_PERMISSIONS.indexOf(s) >= 0 ? s : "safe";
}

// 内置默认系统提示词：未自定义时使用（前端「还原」按钮也会恢复为它）
const AI_DEFAULT_PROMPT = [
  "你是这个博客后台的 AI 助手，请用简洁的中文回答。",
  "你可以调用工具查看/修改仓库文件、触发部署、读写站点设置；危险操作在执行前可能会请用户确认。",
  "回答使用 Markdown（标题、要点、代码块），不要编造未实际执行的结果。",
].join("\n");

const AI_CONFIG_KEY = "ai_config";

async function getAiConfig(db: D1Database): Promise<AiConfig> {
  const raw = await getSiteSetting(db, AI_CONFIG_KEY, "");
  if (!raw) return { ...AI_DEFAULT_CONFIG };
  try {
    return { ...AI_DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch (e) {
    return { ...AI_DEFAULT_CONFIG };
  }
}

async function saveAiConfig(db: D1Database, cfg: AiConfig): Promise<void> {
  await setSiteSetting(db, AI_CONFIG_KEY, JSON.stringify(cfg));
}

// 拼接 OpenAI 兼容接口地址：用户可能填或不填结尾的 /v1，做健壮处理
function aiEndpoint(baseUrl: string, path: string): string {
  let base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  // 结尾缺少版本段（如 /v1）时自动补全，兼容标准 OpenAI 与第三方兼容接口
  if (!/\/v\d+[a-zA-Z]*$/.test(base)) base += "/v1";
  return base + path;
}

// GET 读取 AI 配置（管理员，密钥不回传，以 hasKey 表示是否已设置）
app.get("/admin/api/ai/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  try {
    const cfg = await getAiConfig((c.env as Bindings).DB);
    const env = c.env as Bindings;
    const envHasCfCreds = !!(
      String(env.CF_ACCOUNT_ID || "").trim() &&
      String(env.CF_AI_TOKEN || env.CF_API_TOKEN || "").trim()
    );
    const cfFromEnv = envHasCfCreds;
    return json({
      ok: true,
      ...cfg,
      apiKey: "",
      hasKey: !!cfg.apiKey,
      cfApiKey: "",
      // 部署工作流已注入账户 / 令牌时，后台无需再填
      hasCfKey: !!cfg.cfApiKey || cfFromEnv,
      cfFromEnv,
      cfEnvAccountId: cfFromEnv ? String(env.CF_ACCOUNT_ID || "").trim() : "",
      defaultPrompt: AI_DEFAULT_PROMPT,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// PUT 保存 AI 配置（管理员，apiKey 留空表示不修改）
app.put("/admin/api/ai/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const cur = await getAiConfig(db);
    const next: AiConfig = {
      baseUrl: body.baseUrl === undefined ? cur.baseUrl : String(body.baseUrl).trim(),
      apiKey:
        body.apiKey === undefined || body.apiKey === "" ? cur.apiKey : String(body.apiKey),
      model: body.model === undefined ? cur.model : String(body.model).trim(),
      models: Array.isArray(body.models)
        ? body.models.map((m) => String(m)).filter(Boolean)
        : cur.models,
      prompt: body.prompt === undefined ? cur.prompt : String(body.prompt),
      enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
      clientProxy: body.clientProxy === undefined ? cur.clientProxy : !!body.clientProxy,
      permission: body.permission === undefined ? cur.permission : normalizePermission(body.permission),
      cfEnabled: body.cfEnabled === undefined ? cur.cfEnabled : !!body.cfEnabled,
      cfAccountId: body.cfAccountId === undefined ? cur.cfAccountId : String(body.cfAccountId).trim(),
      cfApiKey:
        body.cfApiKey === undefined || body.cfApiKey === ""
          ? cur.cfApiKey
          : String(body.cfApiKey),
      cfModels: Array.isArray(body.cfModels)
        ? body.cfModels.map((m) => String(m)).filter(Boolean)
        : cur.cfModels,
    };
    await saveAiConfig(db, next);
    return json({
      ok: true,
      ...next,
      apiKey: "",
      hasKey: !!next.apiKey,
      cfApiKey: "",
      hasCfKey: !!next.cfApiKey || !!(String((c.env as Bindings).CF_AI_TOKEN || (c.env as Bindings).CF_API_TOKEN || "").trim()),
      cfFromEnv: !!(String((c.env as Bindings).CF_ACCOUNT_ID || "").trim() && String((c.env as Bindings).CF_AI_TOKEN || (c.env as Bindings).CF_API_TOKEN || "").trim()),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// POST 测试连通性（管理员）：向 {baseUrl}/chat/completions 发一个最小请求
// body 可选 {baseUrl, apiKey, model}，未传则使用已保存配置，方便未保存时先测试
app.post("/admin/api/ai/test", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const cfg = await getAiConfig(db);
    const baseUrl = (body.baseUrl ? String(body.baseUrl) : cfg.baseUrl).trim();
    const apiKey = body.apiKey ? String(body.apiKey) : cfg.apiKey;
    const model = (body.model ? String(body.model) : cfg.model).trim();
    if (!baseUrl) return json({ ok: false, error: "请先填写 API 地址" }, 400);
    if (!model)
      return json({ ok: false, error: "请先填写或勾选一个模型" }, 400);
    const url = aiEndpoint(baseUrl, "/chat/completions");
    const started = Date.now();
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "你好，这是一条连通性测试消息，请回复一句话确认。" }],
        max_tokens: 32,
      }),
    });
    const elapsed = Date.now() - started;
    const text = await resp.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (e) {}
    if (!resp.ok) {
      const detail =
        data?.error?.message || data?.message || text.slice(0, 300) || `HTTP ${resp.status}`;
      return json({ ok: false, elapsed, status: resp.status, error: String(detail) });
    }
    const reply = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
    return json({
      ok: true,
      elapsed,
      status: resp.status,
      model: data?.model || model,
      reply: String(reply).trim().slice(0, 300),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// GET 返回明文密钥（管理员）：仅用于「前端代理」模式下由浏览器直连服务商
app.get("/admin/api/ai/key", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  try {
    const cfg = await getAiConfig((c.env as Bindings).DB);
    return json({ ok: true, apiKey: cfg.apiKey });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 获取模型列表（管理员）：调用 {baseUrl}/models（OpenAI 兼容格式）
// 支持通过参数覆盖 baseUrl / apiKey，因此「无需保存即可获取模型列表」
async function aiModelsHandler(
  c: any,
  over: { baseUrl?: string; apiKey?: string }
) {
  try {
    const cfg = await getAiConfig((c.env as Bindings).DB);
    const baseUrl = String(over.baseUrl || cfg.baseUrl || "").trim();
    const apiKey = over.apiKey !== undefined && over.apiKey !== null && over.apiKey !== ""
      ? String(over.apiKey)
      : cfg.apiKey;
    if (!baseUrl) return json({ ok: false, error: "请先填写 API 地址" }, 400);
    const url = aiEndpoint(baseUrl, "/models");
    const resp = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });
    const text = await resp.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (e) {}
    if (!resp.ok) {
      const detail =
        data?.error?.message || data?.error || data?.message || text.slice(0, 300) || `HTTP ${resp.status}`;
      return json({ ok: false, status: resp.status, error: String(detail) });
    }
    const list: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    const models = list
      .map((m) => (typeof m === "string" ? m : m?.id))
      .filter((m): m is string => typeof m === "string" && !!m);
    return json({ ok: true, count: models.length, models });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

app.get("/admin/api/ai/models", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return aiModelsHandler(c, { baseUrl: c.req.query("baseUrl"), apiKey: c.req.query("apiKey") });
});

app.post("/admin/api/ai/models", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: string; apiKey?: string };
  return aiModelsHandler(c, { baseUrl: body.baseUrl, apiKey: body.apiKey });
});

// ---------- 3.585 Cloudflare Workers AI ----------
// 使用 Cloudflare 的 OpenAI 兼容接口：/accounts/{id}/ai/v1/chat/completions
// 令牌需具备 Workers AI 权限；额度（Neurons）通过 GraphQL Analytics 查询。
const CF_FREE_NEURONS = 10000; // 免费额度：每天 10000 Neurons（UTC 00:00 重置）

function cfBaseUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`;
}

// Cloudflare 凭据：优先用后台填写的，否则回退到部署工作流注入的账户 / 令牌
function cfCreds(cfg: AiConfig, env: Bindings): { accountId: string; token: string; fromEnv: boolean } {
  const accountId = String(cfg.cfAccountId || env.CF_ACCOUNT_ID || "").trim();
  // 优先用专门给 AI 用的令牌（部署工作流注入），其次回退到部署令牌
  const token = String(cfg.cfApiKey || env.CF_AI_TOKEN || env.CF_API_TOKEN || "").trim();
  const hasEnv = !!(env.CF_ACCOUNT_ID || env.CF_AI_TOKEN || env.CF_API_TOKEN);
  return { accountId, token, fromEnv: !!(hasEnv && !(cfg.cfAccountId && cfg.cfApiKey)) };
}

// GET 模型列表：/ai/models/search?task=Text Generation
app.get("/admin/api/ai/cf/models", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  try {
    const cfg = await getAiConfig(db);
    const env = c.env as Bindings;
    const accountId = String(c.req.query("accountId") || "").trim() || cfCreds(cfg, env).accountId;
    const token = String(c.req.query("apiKey") || "").trim() || cfCreds(cfg, env).token;
    if (!accountId) return json({ ok: false, error: "请先填写 Cloudflare Account ID" }, 400);
    if (!token) return json({ ok: false, error: "请先填写 Cloudflare API 令牌" }, 400);
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
      `/ai/models/search?per_page=100&task=Text%20Generation`;
    const resp = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    const text = await resp.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (e) {}
    if (!resp.ok || data?.success === false) {
      const detail =
        data?.errors?.[0]?.message || data?.error?.message || text.slice(0, 300) || `HTTP ${resp.status}`;
      return json({ ok: false, status: resp.status, error: String(detail) });
    }
    const list: any[] = Array.isArray(data?.result) ? data.result : [];
    const models = list
      .map((m) => (typeof m === "string" ? m : m?.name))
      .filter((m): m is string => typeof m === "string" && m.indexOf("@cf/") === 0);
    return json({ ok: true, count: models.length, models: Array.from(new Set(models)).sort() });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// GET 今日额度：已用 / 剩余 Neurons（GraphQL Analytics）
app.get("/admin/api/ai/cf/quota", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  try {
    const cfg = await getAiConfig(db);
    const env = c.env as Bindings;
    const accountId = String(c.req.query("accountId") || "").trim() || cfCreds(cfg, env).accountId;
    const token = String(c.req.query("apiKey") || "").trim() || cfCreds(cfg, env).token;
    if (!accountId) return json({ ok: false, error: "请先填写 Cloudflare Account ID" }, 400);
    if (!token) return json({ ok: false, error: "请先填写 Cloudflare API 令牌" }, 400);
    // Neurons 按 UTC 自然日统计
    const day = new Date().toISOString().slice(0, 10);
    // 字段名以 GraphQL schema 为准：AccountAiInferenceAdaptiveGroupsSum.totalNeurons
    // （旧文档/示例里的 neurons 字段不存在，会返回 unknown field "neurons"）
    const query =
      "query($acc:String!,$d:Date!){viewer{accounts(filter:{accountTag:$acc}){" +
      "aiInferenceAdaptiveGroups(limit:1,filter:{date_geq:$d,date_leq:$d}){sum{totalNeurons}}}}}";
    const resp = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables: { acc: accountId, d: day } }),
      signal: AbortSignal.timeout(15000),
    });
    const data: any = await resp.json().catch(() => null);
    if (!resp.ok || (Array.isArray(data?.errors) && data.errors.length)) {
      const detail =
        data?.errors?.[0]?.message || `HTTP ${resp.status}（令牌需要「账户分析」读取权限）`;
      return json({ ok: false, status: resp.status, error: String(detail) });
    }
    const groups = data?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
    let used = 0;
    for (const g of groups) used += Number(g?.sum?.totalNeurons) || 0;
    const limit = CF_FREE_NEURONS;
    return json({
      ok: true,
      day,
      used: Math.round(used),
      limit,
      remaining: Math.max(0, Math.round(limit - used)),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---------- 3.59 AI 助手（聊天：流式输出 + 历史记录）----------
// 历史会话存于 D1 表 wl_AiConversation（messages 为 JSON 数组），表按需创建。
let aiTablesReady: Promise<unknown> | null = null;
function ensureAiTables(db: D1Database): Promise<unknown> {
  if (!aiTablesReady) {
    aiTablesReady = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS "wl_AiConversation" (
          "id" INTEGER PRIMARY KEY AUTOINCREMENT,
          "title" TEXT NOT NULL DEFAULT '',
          "messages" TEXT NOT NULL DEFAULT '[]',
          "createdAt" TEXT DEFAULT (datetime('now')),
          "updatedAt" TEXT DEFAULT (datetime('now'))
        )`
      )
      .run()
      .catch((e) => {
        aiTablesReady = null; // 失败则下次重试
        throw e;
      });
  }
  return aiTablesReady;
}

// GET 会话列表（管理员）
app.get("/admin/api/ai/conversations", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  try {
    await ensureAiTables(db);
    const rows = await db
      .prepare(
        `SELECT "id","title","createdAt","updatedAt" FROM "wl_AiConversation" ORDER BY "updatedAt" DESC LIMIT 100`
      )
      .all();
    return json({ ok: true, list: rows.results || [] });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// GET 单个会话（含消息）（管理员）
app.get("/admin/api/ai/conversation", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const id = parseInt(c.req.query("id") || "", 10);
  if (!Number.isFinite(id)) return json({ ok: false, error: "id 无效" }, 400);
  try {
    await ensureAiTables(db);
    const row = await db
      .prepare(
        `SELECT "id","title","messages","createdAt","updatedAt" FROM "wl_AiConversation" WHERE "id"=?1`
      )
      .bind(id)
      .first<{ id: number; title: string; messages: string; createdAt: string; updatedAt: string }>();
    if (!row) return json({ ok: false, error: "未找到会话" }, 404);
    let messages: unknown = [];
    try {
      messages = JSON.parse(row.messages || "[]");
    } catch (e) {}
    return json({
      ok: true,
      conversation: {
        id: row.id,
        title: row.title,
        messages,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// PUT 保存会话（管理员）：body {id?, title?, messages}，id 存在则更新，否则新建
app.put("/admin/api/ai/conversation", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: unknown;
    title?: unknown;
    messages?: unknown;
  };
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const title = String(body.title ?? "").trim().slice(0, 100);
  const id = parseInt(String(body.id ?? ""), 10);
  try {
    await ensureAiTables(db);
    if (Number.isFinite(id) && id > 0) {
      const r = await db
        .prepare(
          `UPDATE "wl_AiConversation" SET "title"=?1,"messages"=?2,"updatedAt"=datetime('now') WHERE "id"=?3`
        )
        .bind(title, JSON.stringify(messages), id)
        .run();
      if (((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0) {
        return json({ ok: true, id, updated: true });
      }
    }
    const ins = await db
      .prepare(`INSERT INTO "wl_AiConversation" ("title","messages") VALUES (?1,?2)`)
      .bind(title, JSON.stringify(messages))
      .run();
    return json({ ok: true, id: (ins.meta as { last_row_id?: number } | undefined)?.last_row_id, created: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// DELETE 删除会话（管理员）
app.delete("/admin/api/ai/conversation", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const id = parseInt(c.req.query("id") || "", 10);
  if (!Number.isFinite(id)) return json({ ok: false, error: "id 无效" }, 400);
  try {
    await ensureAiTables(db);
    const r = await db.prepare(`DELETE FROM "wl_AiConversation" WHERE "id"=?1`).bind(id).run();
    return json({ ok: true, deleted: ((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0 });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// POST 聊天（管理员，流式）：转发到 OpenAI 兼容接口，原样回传 SSE（text/event-stream）
// body {messages, model?, baseUrl?, apiKey?}，未传 model/baseUrl/apiKey 则用已保存配置
app.post("/admin/api/ai/chat", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const cfg = await getAiConfig((c.env as Bindings).DB);
  let baseUrl = String(body.baseUrl || cfg.baseUrl || "").trim();
  let apiKey = String(body.apiKey || cfg.apiKey || "");
  const model = String(body.model || cfg.model || "").trim();
  // Cloudflare Workers AI：模型以 @cf/ 开头或显式 provider=cf，走 Cloudflare 的 OpenAI 兼容接口
  const isCf = String(body.provider || "") === "cf" || model.indexOf("@cf/") === 0;
  if (isCf) {
    const creds = cfCreds(cfg, c.env as Bindings);
    if (!creds.accountId || !creds.token) {
      return json(
        {
          ok: false,
          error: "Cloudflare AI 未配置：部署工作流未注入令牌，请在「设置 → AI 设置」填写 Account ID 与 API 令牌",
        },
        400
      );
    }
    baseUrl = cfBaseUrl(creds.accountId);
    apiKey = creds.token;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const prompt =
    body.prompt === undefined
      ? String(cfg.prompt || "").trim() || AI_DEFAULT_PROMPT
      : String(body.prompt).trim() || AI_DEFAULT_PROMPT;
  // 未自带系统消息时，使用配置中的 AI 提示词作为角色设定
  const msgs =
    prompt && (messages[0] as { role?: string } | undefined)?.role !== "system"
      ? [{ role: "system", content: prompt }, ...messages]
      : messages;
  if (!baseUrl) return json({ ok: false, error: "请先在「设置 → AI 设置」填写并保存 API 地址" }, 400);
  if (!model) return json({ ok: false, error: "请先填写默认模型（或在聊天页指定模型）" }, 400);
  if (!messages.length) return json({ ok: false, error: "messages required" }, 400);
  // 工具调用：前端仅在权限允许时下发 tools，此处原样转发给上游
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]) : null;
  // 思考强度（白名单校验后透传 reasoning_effort）
  const effortRaw = String(body.reasoning_effort || "").trim();
  const reasoningEffort = ["low", "medium", "high"].indexOf(effortRaw) >= 0 ? effortRaw : "";
  try {
    const upstream = await fetch(aiEndpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: msgs,
        stream: true,
        // 让上游在流末尾附带 usage（token 用量 / 缓存命中），供前端展示
        // Cloudflare 的兼容接口不支持这两个扩展字段，跳过避免 400
        ...(isCf ? {} : { stream_options: { include_usage: true } }),
        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
        ...(reasoningEffort && !isCf ? { reasoning_effort: reasoningEffort } : {}),
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      let detail: unknown = text.slice(0, 300) || `HTTP ${upstream.status}`;
      try {
        const d = JSON.parse(text);
        detail = d?.error?.message || d?.error || detail;
      } catch (e) {}
      return json({ ok: false, status: upstream.status, error: String(detail) }, 502);
    }
    // 原样透传上游 SSE
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---------- 3.595 AI 密钥（占位符 {name}）：值不下发给 AI，仅在执行工具时替换 ----------
// 密钥仅管理员可维护；列表接口只返回名称，绝不回传明文，避免密钥进入 AI 上下文。
interface SecretRow {
  name: string;
  value: string;
}

let aiSecretTablesReady: Promise<unknown> | null = null;
function ensureSecretTables(db: D1Database): Promise<unknown> {
  if (!aiSecretTablesReady) {
    aiSecretTablesReady = db
      .prepare(
        `CREATE TABLE IF NOT EXISTS "wl_Secret" (
          "name" TEXT PRIMARY KEY,
          "value" TEXT NOT NULL DEFAULT '',
          "updatedAt" TEXT DEFAULT (datetime('now'))
        )`
      )
      .run()
      .catch((e) => {
        aiSecretTablesReady = null;
        throw e;
      });
  }
  return aiSecretTablesReady;
}

async function getSecrets(db: D1Database): Promise<SecretRow[]> {
  await ensureSecretTables(db);
  const rows = await db.prepare(`SELECT "name","value" FROM "wl_Secret" ORDER BY "name"`).all();
  return (rows.results || []) as unknown as SecretRow[];
}

// 把文本中的 {name} 替换为真实密钥值；未定义的占位符原样保留
function applySecrets(text: string, secrets: SecretRow[]): string {
  if (!text) return text;
  let out = text;
  for (const s of secrets) {
    if (!s.name) continue;
    out = out.split("{" + s.name + "}").join(s.value);
  }
  return out;
}

// GET 密钥名称列表（仅名称）
app.get("/admin/api/secrets", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  try {
    const list = await getSecrets((c.env as Bindings).DB);
    return json({ ok: true, names: list.map((s) => s.name) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// PUT 新增/更新密钥（值仅保存于服务端）
app.put("/admin/api/secrets", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; value?: unknown };
  const name = String(body.name || "").trim();
  const value = String(body.value ?? "");
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name))
    return json({ ok: false, error: "名称仅支持字母、数字与 _ . -（1-64 位）" }, 400);
  if (!value) return json({ ok: false, error: "密钥值不能为空" }, 400);
  try {
    await ensureSecretTables(db);
    await db
      .prepare(
        `INSERT INTO "wl_Secret" ("name","value","updatedAt") VALUES (?1,?2,datetime('now'))
         ON CONFLICT("name") DO UPDATE SET "value"=?2,"updatedAt"=datetime('now')`
      )
      .bind(name, value)
      .run();
    return json({ ok: true, name });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// DELETE 删除密钥
app.delete("/admin/api/secrets", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const name = String(c.req.query("name") || "").trim();
  if (!name) return json({ ok: false, error: "name required" }, 400);
  try {
    await ensureSecretTables(db);
    await db.prepare(`DELETE FROM "wl_Secret" WHERE "name"=?1`).bind(name).run();
    return json({ ok: true, name });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---------- 3.596 AI 工具（AI 主动调用，服务端执行；危险操作由前端按权限确认）----------
// 工具定义遵循 OpenAI function calling 规范
const AI_TOOLS = [
  { type: "function", function: { name: "list_files", description: "列出博客仓库某个目录下的文件（path 为空表示仓库根目录）", parameters: { type: "object", properties: { path: { type: "string", description: "目录路径，如 source/_posts" } } } } },
  { type: "function", function: { name: "read_file", description: "读取仓库中某个文本文件的内容", parameters: { type: "object", properties: { path: { type: "string", description: "文件完整路径" } }, required: ["path"] } } },
  { type: "function", function: { name: "list_branches", description: "列出仓库分支及当前分支", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "write_file", description: "新建或覆盖写入一个文本文件并提交到仓库（会自动触发部署）", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "delete_file", description: "删除仓库中的文件或目录（移入回收站，可恢复）", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "build_status", description: "查询最近的部署构建状态", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "trigger_build", description: "手动触发一次部署构建", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_settings", description: "读取站点设置（站点功能 + 邮件服务器 + 订阅设置/邮件模板，密码以是否已设置表示）", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "set_setting", description: "修改站点设置。key 支持：站点功能 allow_guest_comment / retention_days；邮件服务器 smtp_host / smtp_port / smtp_user / smtp_pass / smtp_from_name / smtp_from_email；订阅设置 sub_site_name / sub_site_url / sub_need_confirm / sub_daily_limit；订阅邮件模板 sub_subject / sub_body / sub_notify_subject / sub_notify_body / sub_unsub_subject / sub_unsub_body。", parameters: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } } },
  { type: "function", function: { name: "save_secret", description: "当用户在对话中直接给出了密钥/授权码/密码并要你保存时调用。name 为占位符名称（如 SMTP_PASS），value 为用户给出的真实值；保存后在写入文件或设置时用 {name} 引用。", parameters: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] } } },
  { type: "function", function: { name: "request_secret", description: "当需要用户提供密钥/授权码/密码，但用户尚未在对话中提供时调用：系统会弹窗让用户在本地输入，输入内容不会发送给你，你只会收到是否设置成功的结果。切勿要求用户把密码直接发到对话里。", parameters: { type: "object", properties: { name: { type: "string", description: "占位符名称，如 SMTP_PASS" }, purpose: { type: "string", description: "用途说明，会展示给用户" } }, required: ["name"] } } },
  { type: "function", function: { name: "send_email", description: "使用已配置的 SMTP 发送邮件。默认发送单封给 to；若 broadcast=true 则群发给全部「已确认」的订阅者（忽略 to）。主题/正文必填，正文支持 HTML，可用 {{site}} {{email}} {{unsubscribe}} 变量。", parameters: { type: "object", properties: { to: { type: "string", description: "收件邮箱（发单封时必填）" }, subject: { type: "string" }, body: { type: "string", description: "正文，支持 HTML" }, broadcast: { type: "boolean", description: "true 时群发给全部已确认订阅者" } }, required: ["subject", "body"] } } },
  { type: "function", function: { name: "http_get", description: "发起一个 HTTP GET 请求并返回状态码、响应头与响应体（用于抓取网页、调用 REST API）。", parameters: { type: "object", properties: { url: { type: "string", description: "完整 URL，必须以 http:// 或 https:// 开头" }, headers: { type: "object", description: "可选请求头键值对，如 {\"Accept\":\"application/json\"}" } }, required: ["url"] } } },
  { type: "function", function: { name: "http_post", description: "发起一个 HTTP POST 请求并返回状态码、响应头与响应体（用于提交表单、调用需要写入的 REST API）。", parameters: { type: "object", properties: { url: { type: "string", description: "完整 URL，必须以 http:// 或 https:// 开头" }, body: { type: "string", description: "请求体文本（如 JSON 字符串）" }, contentType: { type: "string", description: "请求体类型，如 application/json、application/x-www-form-urlencoded；默认 text/plain" }, headers: { type: "object", description: "可选请求头键值对" } }, required: ["url"] } } },
  { type: "function", function: { name: "download_file", description: "从网络下载一个文件并保存到博客仓库（exe/图片/zip/压缩包等二进制均可）。url 也可传 GitHub 仓库的 owner/repo 或 https://github.com/owner/repo 链接，会自动下载该仓库源码 zip。path 为仓库内目标路径：以 / 结尾或省略表示目录（自动使用下载文件名），否则视为完整文件路径。上限约 45MB。", parameters: { type: "object", properties: { url: { type: "string", description: "http(s) 下载地址，或 GitHub 仓库 owner/repo" }, path: { type: "string", description: "仓库内目标路径或目录（目录以 / 结尾），可省略" }, name: { type: "string", description: "可选：保存的文件名" }, branch: { type: "string", description: "可选：分支，默认当前分支" } }, required: ["url"] } } },
  { type: "function", function: { name: "unzip_file", description: "解压仓库内已有的 zip 文件到它所在目录：小于 50MB 由 Cloudflare 即时解压；大于 50MB 自动触发 GitHub 工作流异步解压。", parameters: { type: "object", properties: { path: { type: "string", description: "zip 文件在仓库中的完整路径" }, branch: { type: "string", description: "可选：分支" } }, required: ["path"] } } },
  { type: "function", function: { name: "unzip_status", description: "查询大文件解压工作流（unzip.yml）的运行状态与最近结果。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "get_build_logs", description: "获取某个工作流的运行日志文本，用于排查失败原因。默认 deploy.yml；用 workflow 指定 clone-repo.yml、unzip.yml、update-cf.yml 等；runId 省略则取该工作流最近一次运行。", parameters: { type: "object", properties: { runId: { type: "string", description: "可选：工作流 run id，省略则为该工作流最近一次" }, workflow: { type: "string", description: "可选：工作流文件名，如 deploy.yml / clone-repo.yml / unzip.yml，省略为 deploy.yml" } } } } },
  { type: "function", function: { name: "sleep", description: "等待指定秒数后再继续（适合触发工作流后等它跑一会儿，再查询状态或日志）。seconds：1-60。", parameters: { type: "object", properties: { seconds: { type: "number", description: "等待秒数（1-60）" } }, required: ["seconds"] } } },
  { type: "function", function: { name: "list_workflows", description: "列出博客仓库中所有可用的 GitHub 工作流（名称、文件名、状态）。运行指定工作流前可先调用它确认文件名。", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "workflow_runs", description: "查询工作流的运行记录（默认查全部，可传 workflow 指定某个工作流的文件名，如 deploy.yml、clone-repo.yml），用于了解当前是否有工作流在运行及最近结果。", parameters: { type: "object", properties: { workflow: { type: "string", description: "可选：工作流文件名，省略则查全部工作流" } } } } },
  { type: "function", function: { name: "trigger_workflow", description: "触发运行指定的 GitHub 工作流。workflow_id 传工作流文件名（如 clone-repo.yml、deploy.yml）或工作流名称；可用 inputs 传 workflow_dispatch 的输入参数。", parameters: { type: "object", properties: { workflow_id: { type: "string", description: "工作流文件名（如 clone-repo.yml）或名称" }, ref: { type: "string", description: "可选：分支，默认当前分支" }, inputs: { type: "object", description: "可选：workflow_dispatch 输入参数键值对" } }, required: ["workflow_id"] } } },
  { type: "function", function: { name: "cancel_workflow", description: "取消正在运行的 GitHub 工作流。runId 可省略，默认取消最近一次仍在运行的工作流。", parameters: { type: "object", properties: { runId: { type: "string", description: "可选：要取消的 run id，省略则取消最近一次运行中的工作流" } } } } },
  { type: "function", function: { name: "wait_workflow", description: "等待当前正在运行的 GitHub 工作流全部结束（无论成功还是失败都会返回）后再继续，适合触发部署/解压/克隆后阻塞等它跑完。返回各次运行的最终状态与结论。", parameters: { type: "object", properties: { workflow: { type: "string", description: "可选：只等待指定工作流（文件名如 update-gh.yml / deploy.yml），省略则等待所有正在运行的工作流" }, timeout_minutes: { type: "number", description: "可选：最长等待分钟数，默认 10，最大 30；超时返回 running=true" } } } } },
  { type: "function", function: { name: "clone_repo", description: "把一个外部 Git 仓库克隆到当前博客仓库的指定目录（例如克隆一个 Hexo 主题到 themes/xxx）。由 GitHub 工作流异步完成，约 10 秒。repo_url 支持 owner/repo 或完整 URL。", parameters: { type: "object", properties: { repo_url: { type: "string", description: "要克隆的仓库：owner/repo 或完整 URL" }, target_dir: { type: "string", description: "目标目录，如 themes/next" }, ref: { type: "string", description: "可选：源仓库的分支或标签" }, branch: { type: "string", description: "可选：提交到当前仓库的分支" } }, required: ["repo_url", "target_dir"] } } },
  { type: "function", function: { name: "move_path", description: "移动或重命名仓库中的文件/目录（目录会整体移动，一次提交完成，可用于给主题/资源改名）。目标已存在时自动加序号避免覆盖。", parameters: { type: "object", properties: { from: { type: "string", description: "原路径" }, to: { type: "string", description: "新路径" }, branch: { type: "string", description: "可选：分支" } }, required: ["from", "to"] } } },
  { type: "function", function: { name: "create_folder", description: "在仓库中新建一个文件夹（自动放入 .gitkeep 占位，空目录也能被 Git 保留）。", parameters: { type: "object", properties: { path: { type: "string", description: "文件夹路径，如 source/images" }, branch: { type: "string", description: "可选：分支" } }, required: ["path"] } } },
  { type: "function", function: { name: "search_files", description: "在仓库中搜索：先按文件名匹配；content=true 时同时在文本文件内容里查找关键词（返回文件名与行号片段，受数量上限保护）。可用 dir 限定目录。", parameters: { type: "object", properties: { query: { type: "string", description: "关键词" }, dir: { type: "string", description: "可选：限定目录，如 source/_posts" }, content: { type: "boolean", description: "是否搜索文件内容，默认 false 只搜文件名" }, branch: { type: "string", description: "可选：分支" } }, required: ["query"] } } },
  { type: "function", function: { name: "compare_branches", description: "对比两个分支的差异（提交列表与变更文件），用于排查某分支改了什么。", parameters: { type: "object", properties: { base: { type: "string", description: "基准分支，如 main" }, head: { type: "string", description: "待比较分支" } }, required: ["base", "head"] } } },
  { type: "function", function: { name: "repo_config", description: "一次性读取仓库关键配置文件（_config.yml、wrangler.toml、package.json 等）并列出所有 GitHub 工作流文件，用于部署/构建排错。可用 paths 指定要读的文件。", parameters: { type: "object", properties: { paths: { type: "string", description: "可选：要读取的文件路径，逗号或空格分隔；省略则读默认关键配置" }, branch: { type: "string", description: "可选：分支" } } } } },
  { type: "function", function: { name: "cloudflare_api", description: "调用 Cloudflare API（需先在「设置 → AI 密钥」保存名为 CF_API_TOKEN 的密钥）。path 为 API v4 路径，例如 /zones、/accounts、/accounts/{account_id}/workers/routes、/zones/{zone_id}/dns_records。用于查看/新增 Worker 路由、DNS 记录、绑定域名等。可先调 /accounts、/zones 获取 id。", parameters: { type: "object", properties: { method: { type: "string", description: "GET/POST/PUT/PATCH/DELETE，默认 GET" }, path: { type: "string", description: "API v4 路径，如 /zones" }, body: { type: "string", description: "可选：POST/PUT/PATCH 的 JSON 请求体" } }, required: ["path"] } } },
  { type: "function", function: { name: "http_request", description: "发起任意方法的 HTTP 请求（GET/POST/PUT/PATCH/DELETE/HEAD），返回状态码、响应头与响应体（超长自动截断）。需要其它方法或自定义请求体时用它。", parameters: { type: "object", properties: { method: { type: "string", description: "请求方法" }, url: { type: "string", description: "完整 URL" }, body: { type: "string", description: "可选：请求体文本" }, contentType: { type: "string", description: "可选：如 application/json" }, headers: { type: "object", description: "可选：请求头键值对" } }, required: ["method", "url"] } } },
  { type: "function", function: { name: "fetch_text", description: "抓取网页并提取可读正文（自动去掉 HTML 标签/脚本/样式），适合阅读文章、文档或抓取正文内容。", parameters: { type: "object", properties: { url: { type: "string", description: "完整 URL" }, maxChars: { type: "integer", description: "可选：返回正文的最大字符数，默认 40000" } }, required: ["url"] } } },
];

// set_setting 允许修改的设置项（站点功能走 wl_Settings，其余写入订阅/SMTP 配置）
const AI_SETTING_KEYS = [
  "allow_guest_comment", "retention_days",
  "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_from_name", "smtp_from_email",
  "sub_site_name", "sub_site_url", "sub_subject", "sub_body", "sub_notify_subject", "sub_notify_body",
  "sub_unsub_subject", "sub_unsub_body", "sub_need_confirm", "sub_daily_limit",
];

// 危险工具：需要「重要确认」及以上权限时需用户确认
const AI_DANGER_TOOLS = ["write_file", "delete_file", "trigger_build", "set_setting", "save_secret", "send_email", "http_post", "download_file", "unzip_file", "trigger_workflow", "cancel_workflow", "clone_repo", "move_path", "create_folder", "cloudflare_api", "http_request"];

// 生成工具使用说明（含可用密钥占位符名称，绝不含密钥值）
async function aiToolsHint(db: D1Database): Promise<string> {
  const secrets = await getSecrets(db).catch(() => [] as SecretRow[]);
  const names = secrets.map((s) => s.name);
  return [
    "你已接入该博客后台，可通过工具直接读写仓库文件、触发部署、修改站点设置。",
    "仓库根目录即工作目录；文章位于 source/_posts。修改文件后会自动部署。",
    "危险操作（写文件 / 删除 / 触发构建 / 改设置 / 保存密钥 / 发邮件）可能会被系统拦截并等待用户确认。",
    "密钥用法：严禁把任何真实密钥写进回答。如需使用密钥，请在写入内容里写占位符（如 {MY_API}），系统会在执行时自动替换为真实值；你无法也不应获取真实密钥。",
    "凭据规则：绝对不要要求用户把密码/授权码直接发到对话里。若你确实需要而用户尚未提供，请调用 request_secret（系统会弹窗让用户本地输入，你不会看到内容）；若用户已在对话中直接把密码/授权码给了你并要你保存，请调用 save_secret 保存为占位符。",
    "可用 set_setting 修改的设置项 key：" + AI_SETTING_KEYS.join("、") + "。",
    "发邮件：用 send_email 发单封（to）或 broadcast=true 群发给已确认订阅者；需先在设置里配置 SMTP。发送前可先用 get_settings 确认 smtp.host 与 hasPass。",
    "联网：用 http_get 抓取网页或调用 GET 类接口，用 http_post 提交数据或调用写入类接口（需 http(s):// 开头，可自定义 headers/contentType）。响应体会自动截断，超长内容请分页或改用接口的查询参数。",
    "下载与解压：用 download_file 把网络上的文件（含 GitHub 仓库 owner/repo 源码 zip）保存进仓库；用 unzip_file 解压仓库里的 zip（<50MB 即时完成，>50MB 触发 GitHub 工作流异步解压，可用 unzip_status 查看进度）。",
    "部署排错：用 build_status 查看部署状态；用 get_build_logs 拉取日志文本排查失败原因，workflow 可指定 deploy.yml / clone-repo.yml / unzip.yml / update-cf.yml（省略为 deploy.yml），runId 省略则取该工作流最近一次。运行中也能拉到实时日志（已产出部分）；刚触发还未产出时若提示「日志尚不可用」，先 wait_workflow 或 sleep 几秒再试。",
    "等待：用 wait_workflow 阻塞等到当前工作流跑完（成功/失败都会返回再继续），可传 workflow 只等某个工作流、timeout_minutes 设上限（默认 10 分钟）；只需短暂间隔时用 sleep 等 seconds 秒（1-60）。",
    "工作流控制：用 list_workflows 查看仓库里有哪些工作流；用 workflow_runs 查看运行记录（可传 workflow 文件名）；用 trigger_workflow 运行指定的工作流（workflow_id 传文件名如 deploy.yml，可带 inputs）；触发后如需等它结束再继续（比如等部署完再验证站点），直接调用 wait_workflow，不要反复 sleep+workflow_runs 轮询；用 cancel_workflow 停止当前正在运行的工作流（可传 runId，省略则取消最近一次运行中的）。",
    "克隆仓库：把外部仓库/主题放进仓库优先用 clone_repo（例如 repo_url=theme-next/hexo-theme-next, target_dir=themes/next），由 GitHub 工作流异步完成（约 10-30 秒，可用 sleep 后 workflow_runs/get_build_logs 跟踪）。注意：目标目录必须不存在或为空，否则工作流会中止；若目录已存在，先删除或换个目录名。不要把整仓源码 zip 用 download_file+unzip_file 代替 clone（zip 解压出来会多一层目录，且主题一般不需要）。",
    "文件管理增强：用 move_path 移动或重命名文件/目录（目录整体一次提交）；用 create_folder 新建文件夹（自带 .gitkeep 占位）；用 search_files 按文件名或内容搜索仓库（content=true 搜内容）。",
    "部署排错增强：用 compare_branches 对比两个分支的差异（提交与变更文件）；用 repo_config 一次读取关键配置文件（_config.yml、wrangler.toml 等）并列出所有工作流文件。",
    "Cloudflare 运维：用 cloudflare_api 调用 Cloudflare API v4（需先在「设置 → AI 密钥」保存 CF_API_TOKEN），管理 Worker 路由、DNS 记录、绑定域名等，例如先 path=/zones 或 /accounts 获取 id。",
    "联网增强：用 http_request 发起任意方法（PUT/PATCH/DELETE/HEAD）的请求；用 fetch_text 抓取网页并自动提取可读正文（去标签），适合阅读文章或文档。",
    names.length
      ? "当前可用的密钥占位符：" + names.map((n) => "{" + n + "}").join("、")
      : "当前没有配置任何密钥占位符（管理员可在「设置 → AI 密钥」中添加）。",
  ].join("\n");
}

// 把 AI 传入的 headers 对象转成字符串键值对，并把其中 {NAME} 占位符替换为已保存的密钥
function aiSecretHeaders(headers: unknown, secrets: SecretRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers && typeof headers === "object") {
    for (const k of Object.keys(headers as Record<string, unknown>)) {
      out[k] = applySecrets(String((headers as Record<string, unknown>)[k]), secrets);
    }
  }
  return out;
}

// 发起外网 HTTP 请求（AI 的 http_get / http_post 工具）：返回状态码、响应头、响应体（超长截断）
async function aiHttpRequest(
  method: string,
  url: string,
  body: string,
  headers: unknown,
  contentType: string
): Promise<string> {
  try {
    if (!/^https?:\/\//i.test(url)) return JSON.stringify({ ok: false, error: "url 必须以 http:// 或 https:// 开头" });
    const h: Record<string, string> = {};
    if (headers && typeof headers === "object") {
      for (const k of Object.keys(headers as Record<string, unknown>)) h[k] = String((headers as Record<string, unknown>)[k]);
    }
    const hasCT = Object.keys(h).some((k) => k.toLowerCase() === "content-type");
    if (method === "POST" && contentType && !hasCT) h["Content-Type"] = contentType;
    const m = String(method || "GET").toUpperCase();
    if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].indexOf(m) < 0)
      return JSON.stringify({ ok: false, error: "不支持的 method：" + method });
    const hasBody = m !== "GET" && m !== "HEAD";
    if (hasBody && contentType && !hasCT) h["Content-Type"] = contentType;
    const t0 = Date.now();
    const r = await fetch(url, { method: m, headers: h, body: hasBody ? (body || "") : undefined, redirect: "follow" });
    const ms = Date.now() - t0;
    const text = await r.text().catch(() => "");
    const out = text.length > 100000 ? text.slice(0, 100000) + "\n...(内容过长已截断)" : text;
    const rh: Record<string, string> = {};
    r.headers.forEach((v, k) => { rh[k] = v; });
    return JSON.stringify({ ok: r.ok, status: r.status, ms, headers: rh, body: out });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// 从已保存的密钥中取真实值（仅服务端使用，绝不返回给 AI）
function secretValue(secrets: SecretRow[], names: string[]): string {
  for (const n of names) {
    const hit = secrets.find((s) => s.name === n);
    if (hit && hit.value) return hit.value;
  }
  return "";
}

// 抓取网页并提取可读正文（去掉脚本/样式/HTML 标签）
function aiHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
async function aiFetchText(url: string, maxChars: number): Promise<string> {
  try {
    if (!/^https?:\/\//i.test(url)) return JSON.stringify({ ok: false, error: "url 必须以 http:// 或 https:// 开头" });
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogAdminAI/1.0)", Accept: "text/html,application/xhtml+xml,text/plain,*/*" },
    });
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const raw = await r.text().catch(() => "");
    const isHtml = ct.indexOf("html") >= 0 || /<html|<!doctype html|<body/i.test(raw.slice(0, 800));
    const text = isHtml ? aiHtmlToText(raw) : raw;
    const cap = Math.max(2000, Math.min(Number(maxChars) || 40000, 200000));
    return JSON.stringify({
      ok: r.ok,
      status: r.status,
      content_type: ct,
      truncated: text.length > cap,
      text: text.length > cap ? text.slice(0, cap) + "\n...(已截断)" : text,
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// 搜索仓库文件：先按文件名匹配；content=true 时再在文本文件内容里查找（受数量上限保护）
const AI_BINARY_EXT = ["png","jpg","jpeg","gif","webp","bmp","ico","svgz","pdf","zip","gz","tgz","rar","7z","exe","dll","so","dylib","woff","woff2","ttf","otf","eot","mp3","mp4","mov","avi","webm","psd","class","jar","wasm","bin","dat"];
async function handleSearchFiles(env: Bindings, query: string, dir: string, searchContent: boolean, branch?: string): Promise<string> {
  const q = String(query || "").trim();
  if (!q) return JSON.stringify({ ok: false, error: "query 不能为空" });
  const useBranch = branch || ghConfig(env).branch;
  const info = await ghTreeInfo(env, useBranch);
  if (!info.ok) return JSON.stringify({ ok: false, error: info.error });
  const { repo, headers } = ghConfig(env);
  const norm = String(dir || "").replace(/^\/+|\/+$/g, "");
  const under = (info.tree || []).filter(
    (e: any) => e && e.type === "blob" && (!norm || e.path === norm || String(e.path).startsWith(norm + "/")),
  );
  const ql = q.toLowerCase();
  const out: any = {
    ok: true,
    query: q,
    dir: norm || "/",
    name_matches: under.filter((e: any) => String(e.path).toLowerCase().indexOf(ql) >= 0).map((e: any) => e.path).slice(0, 100),
    content_matches: [],
    scanned: 0,
  };
  if (!searchContent) return JSON.stringify(out);
  const isText = (p: string) => AI_BINARY_EXT.indexOf((p.split(".").pop() || "").toLowerCase()) < 0;
  const cands = under.filter((e: any) => isText(e.path) && (!e.size || e.size <= 200000)).slice(0, 25);
  out.scanned = cands.length;
  for (const e of cands) {
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${e.sha}`, { headers });
      if (!r.ok) continue;
      const b = (await r.json()) as any;
      if (!b || b.encoding !== "base64" || typeof b.content !== "string") continue;
      const bin = atob(b.content.replace(/\s+/g, ""));
      const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      const lines = text.split("\n");
      const hits: any[] = [];
      for (let i = 0; i < lines.length && hits.length < 5; i++) {
        if (lines[i].toLowerCase().indexOf(ql) >= 0) hits.push({ n: i + 1, text: lines[i].slice(0, 300) });
      }
      if (hits.length) out.content_matches.push({ path: e.path, lines: hits });
      if (out.content_matches.length >= 20) break;
    } catch {}
  }
  return JSON.stringify(out);
}

// 对比两个分支的差异（提交与变更文件），用于排查某分支改了什么
async function handleCompareBranches(env: Bindings, base: string, head: string): Promise<string> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return JSON.stringify({ ok: false, error: "GH_TOKEN not configured" });
  const b = String(base || "").replace(/^\/+|\/+$/g, "");
  const h = String(head || "").replace(/^\/+|\/+$/g, "");
  if (!b || !h) return JSON.stringify({ ok: false, error: "base 与 head 必填" });
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/compare/${ghRefPath(b)}...${ghRefPath(h)}`, { headers });
    const d = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) return JSON.stringify({ ok: false, error: d?.message || "HTTP " + r.status });
    return JSON.stringify({
      ok: true,
      status: d.status,
      ahead_by: d.ahead_by,
      behind_by: d.behind_by,
      total_commits: d.total_commits,
      commits: (d.commits || []).slice(-30).map((c: any) => ({ sha: String(c.sha).slice(0, 8), message: String(c.commit?.message || "").split("\n")[0] })),
      files: (d.files || []).slice(0, 100).map((f: any) => ({ path: f.filename, status: f.status, changes: f.changes })),
      files_truncated: (d.files || []).length > 100,
    });
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e) });
  }
}

// 一次性读取仓库关键配置文件 + 列出所有工作流文件（部署排错用）
const AI_COMMON_CONFIG = ["_config.yml", "_config.next.yml", "wrangler.toml", "package.json", "netlify.toml", "vercel.json", "blog-worker/wrangler.toml", "blog-worker/package.json"];
async function handleRepoConfig(env: Bindings, pathsArg: string, branch?: string): Promise<string> {
  const useBranch = branch || ghConfig(env).branch;
  const info = await ghTreeInfo(env, useBranch);
  if (!info.ok) return JSON.stringify({ ok: false, error: info.error });
  const all = info.tree || [];
  const workflows = all
    .filter((e: any) => e.type === "blob" && /^\.github\/workflows\/.+\.ya?ml$/i.test(e.path))
    .map((e: any) => e.path);
  const exist = new Set(all.map((e: any) => e.path));
  const wanted = String(pathsArg || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  const list = (wanted.length ? wanted : AI_COMMON_CONFIG).filter((p) => exist.has(p));
  const files: any[] = [];
  for (const p of list.slice(0, 12)) {
    const r = await handleGetFile(env, p, useBranch);
    const d = (await r.json().catch(() => ({}))) as any;
    if (d && typeof d.content === "string")
      files.push({ path: p, content: d.content.length > 20000 ? d.content.slice(0, 20000) + "\n...(已截断)" : d.content });
  }
  return JSON.stringify({ ok: true, branch: useBranch, workflows, files, note: "如需读取其它文件，用 read_file" });
}

// 调用 Cloudflare API（使用已保存的 CF_API_TOKEN，仅服务端可见）
async function handleCloudflareApi(secrets: SecretRow[], method: string, path: string, body: string): Promise<string> {
  const token = secretValue(secrets, ["CF_API_TOKEN", "CLOUDFLARE_API_TOKEN", "CF_TOKEN"]);
  if (!token)
    return JSON.stringify({
      ok: false,
      error: "未配置 Cloudflare API Token。请在「设置 → AI 密钥」保存名为 CF_API_TOKEN 的密钥（需 Workers Routes / DNS 编辑权限）",
    });
  const m = String(method || "GET").toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE"].indexOf(m) < 0) return JSON.stringify({ ok: false, error: "不支持的 method：" + m });
  let p = String(path || "").trim();
  if (!p) return JSON.stringify({ ok: false, error: "path 不能为空，例如 /zones" });
  if (/^https?:\/\//i.test(p)) {
    const u = new URL(p);
    p = u.pathname + u.search;
  }
  if (p.charAt(0) !== "/") p = "/" + p;
  try {
    const init: any = { method: m, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } };
    if (m !== "GET" && m !== "DELETE" && body) init.body = applySecrets(body, secrets);
    const r = await fetch("https://api.cloudflare.com/client/v4" + p, init);
    const text = await r.text().catch(() => "");
    const out = text.length > 60000 ? text.slice(0, 60000) + "\n...(已截断)" : text;
    return JSON.stringify({ ok: r.ok, status: r.status, body: out });
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

// 执行工具，返回给 AI 的文本结果（JSON 字符串）
async function aiRunTool(env: Bindings, name: string, args: Record<string, unknown>): Promise<string> {
  const db = env.DB;
  const secrets = await getSecrets(db).catch(() => [] as SecretRow[]);
  const s = (k: string) => (args && args[k] !== undefined && args[k] !== null ? String(args[k]) : "");
  const jr = async (r: Response) => JSON.stringify(await r.json().catch(() => ({})));
  switch (name) {
    case "list_files":
      return jr(await handleListFiles(env, s("path")));
    case "read_file": {
      const r = await handleGetFile(env, s("path"));
      const d = (await r.json().catch(() => ({}))) as { content?: unknown };
      if (d && typeof d.content === "string" && d.content.length > 100000)
        d.content = d.content.slice(0, 100000) + "\n...(内容过长已截断)";
      return JSON.stringify(d);
    }
    case "list_branches":
      return jr(await handleListBranches(env));
    case "build_status":
      return jr(await handleBuildStatus(env));
    case "get_build_logs": {
      const r = await handleBuildLog(env, s("runId"), s("workflow"));
      const d = (await r.json().catch(() => ({}))) as { text?: unknown };
      if (d && typeof d.text === "string" && d.text.length > 30000)
        d.text = d.text.slice(-30000) + "\n...(为节省上下文，日志已截断)";
      return JSON.stringify(d);
    }
    case "write_file":
      return jr(await handleSaveFile(env, { path: s("path"), content: applySecrets(s("content"), secrets) }));
    case "delete_file":
      return JSON.stringify(await handleRecyclePaths(env, [s("path")]));
    case "trigger_build":
      return jr(await handleTriggerBuild(env));
    case "get_settings": {
      const allowGuest = (await getSiteSetting(db, "allow_guest_comment", "true")) !== "false";
      const retention = await getSiteSetting(db, "retention_days", "365");
      const sub = await getSubscribeConfig(db);
      return JSON.stringify({
        ok: true,
        allow_guest_comment: allowGuest,
        retention_days: retention,
        smtp: {
          host: sub.host,
          port: sub.port,
          user: sub.user,
          hasPass: !!sub.pass,
          fromName: sub.fromName,
          fromEmail: sub.fromEmail,
        },
        subscription: {
          siteName: sub.siteName,
          siteUrl: sub.siteUrl,
          needConfirm: sub.needConfirm,
          dailyLimit: sub.dailyLimit,
          subject: sub.subject,
          body: sub.body,
          notifySubject: sub.notifySubject,
          notifyBody: sub.notifyBody,
          unsubSubject: sub.unsubSubject,
          unsubBody: sub.unsubBody,
        },
      });
    }
    case "set_setting": {
      const key = s("key");
      if (AI_SETTING_KEYS.indexOf(key) < 0)
        return JSON.stringify({ ok: false, error: "不支持的设置项：" + key + "（允许：" + AI_SETTING_KEYS.join("、") + "）" });
      const val = applySecrets(s("value"), secrets);
      if (key === "allow_guest_comment" || key === "retention_days") {
        await setSiteSetting(db, key, val);
        return JSON.stringify({ ok: true, key, message: "已更新" });
      }
      const cur = await getSubscribeConfig(db);
      const next: SubscribeConfig = { ...cur };
      const asBool = (v: string) => ["true", "1", "yes", "on", "是"].indexOf(v.trim().toLowerCase()) >= 0;
      const asInt = (v: string, fb: number, max: number) => {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 && n <= max ? n : fb;
      };
      switch (key) {
        case "smtp_host": next.host = val.trim(); break;
        case "smtp_port": next.port = asInt(val, cur.port, 65535); break;
        case "smtp_user": next.user = val.trim(); break;
        case "smtp_pass": next.pass = val; break;
        case "smtp_from_name": next.fromName = val; break;
        case "smtp_from_email": next.fromEmail = val.trim(); break;
        case "sub_site_name": next.siteName = val; break;
        case "sub_site_url": next.siteUrl = val.trim(); break;
        case "sub_subject": next.subject = val; break;
        case "sub_body": next.body = val; break;
        case "sub_notify_subject": next.notifySubject = val; break;
        case "sub_notify_body": next.notifyBody = val; break;
        case "sub_unsub_subject": next.unsubSubject = val; break;
        case "sub_unsub_body": next.unsubBody = val; break;
        case "sub_need_confirm": next.needConfirm = asBool(val); break;
        case "sub_daily_limit": next.dailyLimit = asInt(val, cur.dailyLimit, 1000000); break;
      }
      await saveSubscribeConfig(db, next);
      return JSON.stringify({ ok: true, key, message: "已更新" });
    }
    case "save_secret": {
      const name = s("name").trim();
      const value = s("value");
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name))
        return JSON.stringify({ ok: false, error: "名称仅支持字母、数字与 _ . -（1-64 位）" });
      if (!value) return JSON.stringify({ ok: false, error: "值不能为空" });
      await ensureSecretTables(db);
      await db
        .prepare(
          `INSERT INTO "wl_Secret" ("name","value","updatedAt") VALUES (?1,?2,datetime('now'))
           ON CONFLICT("name") DO UPDATE SET "value"=?2,"updatedAt"=datetime('now')`
        )
        .bind(name, value)
        .run();
      return JSON.stringify({ ok: true, name, message: "已保存为占位符 {" + name + "}" });
    }
    case "request_secret":
      return JSON.stringify({ ok: false, error: "request_secret 需由前端弹窗处理，请勿发送到服务端" });
    case "send_email": {
      const cfg = await getSubscribeConfig(db);
      if (!cfg.host || !cfg.port)
        return JSON.stringify({ ok: false, error: "请先在「设置 → SMTP 邮件服务器」配置 SMTP（Workers 仅支持 465 端口）" });
      const subject = applySecrets(s("subject"), secrets).trim();
      const bodyHtml = applySecrets(s("body"), secrets);
      if (!subject || !bodyHtml) return JSON.stringify({ ok: false, error: "subject 与 body 不能为空" });
      const broadcast = args.broadcast === true || String(args.broadcast || "") === "true";
      try {
        if (broadcast) {
          const origin = (env.SITE_URL || "").replace(/\/+$/, "");
          const r = await broadcastToConfirmed(env, subject, bodyHtml, {}, origin);
          if (!r.total) return JSON.stringify({ ok: false, error: "暂无已确认的订阅者" });
          return JSON.stringify({ ok: true, sent: r.sent, failed: r.failed, total: r.total, limited: r.total > 100, message: "群发完成" });
        }
        const to = applySecrets(s("to"), secrets).trim();
        if (!to) return JSON.stringify({ ok: false, error: "请提供收件邮箱 to，或设置 broadcast=true 群发" });
        await sendMail(mailSmtp(cfg), { to, subject, html: wrapMailHtml(bodyHtml) });
        return JSON.stringify({ ok: true, message: "已发送给 " + to });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    case "http_get":
      return await aiHttpRequest("GET", s("url"), "", aiSecretHeaders(args.headers, secrets), "");
    case "http_post":
      return await aiHttpRequest(
        "POST",
        s("url"),
        applySecrets(s("body"), secrets),
        aiSecretHeaders(args.headers, secrets),
        s("contentType")
      );
    case "download_file":
      return jr(
        await handleDownloadFile(env, {
          url: applySecrets(s("url"), secrets),
          path: s("path"),
          name: s("name"),
          branch: s("branch"),
        })
      );
    case "unzip_file":
      return jr(await handleUnzipByPath(env, { path: s("path"), branch: s("branch") }));
    case "unzip_status":
      return jr(await handleUnzipStatus(env));
    case "list_workflows":
      return jr(await handleListWorkflows(env));
    case "workflow_runs":
      return jr(await handleWorkflowRuns(env, s("workflow")));
    case "trigger_workflow":
      return jr(await handleTriggerWorkflow(env, { workflow_id: s("workflow_id"), ref: s("ref"), inputs: args.inputs }));
    case "cancel_workflow":
      return jr(await handleCancelWorkflow(env, { run_id: s("runId") }));
    case "wait_workflow":
      // 等待类工具由前端轮询执行（避免 Worker 子请求/时长限制），正常不会落到这里
      return JSON.stringify({ ok: false, error: "wait_workflow 由前端轮询处理，请重试" });
    case "sleep": {
      const sec = Math.min(Math.max(Math.round(Number(s("seconds")) || 1), 1), 60);
      await new Promise((r) => setTimeout(r, sec * 1000));
      return JSON.stringify({ ok: true, waited: sec });
    }
    case "clone_repo":
      return jr(
        await handleCloneRepo(env, {
          repo_url: s("repo_url"),
          target_dir: s("target_dir"),
          ref: s("ref"),
          branch: s("branch"),
        })
      );
    case "move_path":
      return JSON.stringify(await movePath(env, s("from"), s("to"), s("branch") || ghConfig(env).branch));
    case "create_folder": {
      const p = s("path").replace(/^\/+|\/+$/g, "");
      if (!p) return JSON.stringify({ ok: false, error: "path 不能为空" });
      return jr(await handleSaveFile(env, { path: p + "/.gitkeep", content: "", branch: s("branch") }));
    }
    case "search_files":
      return await handleSearchFiles(env, s("query"), s("dir"), s("content") === "true", s("branch"));
    case "compare_branches":
      return await handleCompareBranches(env, s("base"), s("head"));
    case "repo_config":
      return await handleRepoConfig(env, s("paths"), s("branch"));
    case "cloudflare_api":
      return await handleCloudflareApi(secrets, s("method"), s("path"), s("body"));
    case "http_request":
      return await aiHttpRequest(
        s("method") || "GET",
        applySecrets(s("url"), secrets),
        applySecrets(s("body"), secrets),
        aiSecretHeaders(args.headers, secrets),
        s("contentType")
      );
    case "fetch_text":
      return await aiFetchText(applySecrets(s("url"), secrets), Number(s("maxChars")) || 40000);
    default:
      return JSON.stringify({ ok: false, error: "未知工具：" + name });
  }
}

// GET 工具定义与使用说明（前端据此发起带工具的对话）
app.get("/admin/api/ai/tools", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  try {
    return json({ ok: true, tools: AI_TOOLS, danger: AI_DANGER_TOOLS, hint: await aiToolsHint((c.env as Bindings).DB) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// POST 执行工具（管理员）：body {name, args}
app.post("/admin/api/ai/tool", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { name?: unknown; args?: unknown };
  const name = String(body.name || "");
  const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
  if (!name) return json({ ok: false, error: "name required" }, 400);
  try {
    return json({ ok: true, name, result: await aiRunTool(c.env as Bindings, name, args) });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// ---------- 3.6 邮件订阅 API ----------
// SMTP 配置存于 wl_Settings(key=subscribe_config)，订阅者存于 wl_Subscriber。
// 公开接口（/api/subscribe*）允许跨域，方便在任意站点调用；管理接口走 /admin/api/*。
interface SubscribeConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
  secure: boolean;
  siteName: string;
  siteUrl: string;
  subject: string;
  body: string;
  needConfirm: boolean;
  // 新文章发布通知（构建完成后由工作流回调本 Worker 发送）
  notifySubject: string;
  notifyBody: string;
  // 退订成功提示（仅用户通过邮件链接主动退订时发送）
  unsubSubject: string;
  unsubBody: string;
  // 当日最多订阅量（按东八区计日）：达到上限后当天不再接受新订阅，用于暴力防刷
  dailyLimit: number;
  // 订阅验证方式：none=无 / cf=Cloudflare Turnstile / builtin=内置图形验证码（SVG 自绘）
  verify: "none" | "cf" | "builtin";
  // Turnstile 密钥（verify=cf 时生效）
  cfSiteKey: string;
  cfSecretKey: string;
}

const SUBSCRIBE_DEFAULT_CONFIG: SubscribeConfig = {
  host: "",
  port: 465,
  user: "",
  pass: "",
  fromName: "",
  fromEmail: "",
  secure: true,
  siteName: "我的博客",
  siteUrl: "",
  subject: "【{{site}}】订阅确认",
  body:
    "<p>你好！</p><p>感谢订阅 <b>{{site}}</b>。</p>" +
    '<p>请点击下面的链接确认订阅：</p><p><a href="{{link}}">{{link}}</a></p>' +
    '<p>如果不是你本人操作，请忽略这封邮件。</p>',
  needConfirm: true,
  notifySubject: "【{{site}}】新文章：{{title}}",
  notifyBody:
    "<p>你好！</p><p><b>{{site}}</b> 发布了新文章：</p>" +
    '<p style="font-size:16px"><a href="{{url}}">{{title}}</a></p>' +
    '<p><a href="{{url}}">阅读全文</a></p>' +
    '<hr><p style="color:#888;font-size:12px"><a href="{{unsubscribe}}">不再接收邮件</a></p>',
  unsubSubject: "【{{site}}】已成功退订",
  unsubBody:
    "<p>你好！</p><p>你已成功退订 <b>{{site}}</b> 的邮件通知，之后不会再收到新文章邮件。</p>" +
    "<p>如果这不是你本人的操作，可回到站点重新订阅。</p>",
  dailyLimit: 100,
  verify: "builtin",
  cfSiteKey: "",
  cfSecretKey: "",
};

const subscribeJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...VISIT_CORS },
  });

// 确保订阅相关表存在（自愈建表，与访问量表同样的策略）
let subscribeTablesReady: Promise<unknown> | null = null;
function ensureSubscribeTables(db: D1Database): Promise<unknown> {
  if (!subscribeTablesReady) {
    subscribeTablesReady = db
      .batch([
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_Subscriber" (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "email" TEXT NOT NULL,
            "status" TEXT NOT NULL DEFAULT 'pending',
            "token" TEXT NOT NULL,
            "ip" TEXT,
            "ua" TEXT,
            "createdAt" TEXT DEFAULT (datetime('now')),
            "confirmedAt" TEXT,
            "updatedAt" TEXT DEFAULT (datetime('now'))
          )`
        ),
        db.prepare(
          `CREATE UNIQUE INDEX IF NOT EXISTS "idx_subscriber_email" ON "wl_Subscriber" ("email")`
        ),
        db.prepare(
          `CREATE INDEX IF NOT EXISTS "idx_subscriber_token" ON "wl_Subscriber" ("token")`
        ),
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_Settings" ("key" TEXT PRIMARY KEY, "value" TEXT NOT NULL DEFAULT '', "updatedAt" TEXT DEFAULT (datetime('now')))`
        ),
        // 内置图形验证码：只存哈希，一次性校验（参考 dnsmgr/think-captcha 的一次性哈希思路）
        db.prepare(
          `CREATE TABLE IF NOT EXISTS "wl_Captcha" (
            "id" TEXT PRIMARY KEY,
            "hash" TEXT NOT NULL,
            "createdAt" TEXT DEFAULT (datetime('now'))
          )`
        ),
      ])
      .catch((e) => {
        subscribeTablesReady = null;
        throw e;
      });
  }
  return subscribeTablesReady;
}

async function getSubscribeConfig(db: D1Database): Promise<SubscribeConfig> {
  await ensureSubscribeTables(db);
  const row = await db
    .prepare(`SELECT "value" FROM "wl_Settings" WHERE "key"='subscribe_config'`)
    .first<{ value: string }>();
  if (!row?.value) return { ...SUBSCRIBE_DEFAULT_CONFIG };
  try {
    return { ...SUBSCRIBE_DEFAULT_CONFIG, ...JSON.parse(row.value) };
  } catch (e) {
    return { ...SUBSCRIBE_DEFAULT_CONFIG };
  }
}

async function saveSubscribeConfig(db: D1Database, cfg: SubscribeConfig): Promise<void> {
  await ensureSubscribeTables(db);
  await db
    .prepare(
      `INSERT INTO "wl_Settings" ("key","value","updatedAt") VALUES ('subscribe_config',?1,datetime('now'))
       ON CONFLICT("key") DO UPDATE SET "value"=?1, "updatedAt"=datetime('now')`
    )
    .bind(JSON.stringify(cfg))
    .run();
}

function randomToken(bytes = 24): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- 内置图形验证码（参考 dnsmgr/think-captcha：4 位、去混淆字符集、干扰曲线/杂点、哈希存储、一次性校验）----------
// Worker 里没有 GD，用 SVG 自绘实现等价效果
const CAPTCHA_CODE_SET = "2345678abcdefhijkmnpqrstuvwxyzABCDEFGHJKLMNPQRTUVWXY";
const CAPTCHA_EXPIRE_SECONDS = 600;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomCaptchaCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let out = "";
  for (const b of bytes) out += CAPTCHA_CODE_SET[b % CAPTCHA_CODE_SET.length];
  return out;
}

function captchaSvg(code: string): string {
  const W = 132;
  const H = 46;
  const parts: string[] = [];
  parts.push('<rect width="' + W + '" height="' + H + '" fill="rgb(243,251,254)"/>');
  // 干扰曲线（正弦抖动）
  for (let i = 0; i < 3; i++) {
    const y = 8 + Math.random() * (H - 16);
    const color = "hsl(" + Math.floor(Math.random() * 360) + ",60%,72%)";
    let d = "M0," + y.toFixed(1);
    for (let x = 12; x <= W; x += 12) {
      d +=
        " Q" + (x - 6) + "," + (y + (Math.random() - 0.5) * 12).toFixed(1) +
        " " + x + "," + (y + (Math.random() - 0.5) * 12).toFixed(1);
    }
    parts.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.2"/>');
  }
  // 杂点
  for (let i = 0; i < 32; i++) {
    parts.push(
      '<circle cx="' + (Math.random() * W).toFixed(1) +
      '" cy="' + (Math.random() * H).toFixed(1) +
      '" r="' + (0.8 + Math.random() * 1.4).toFixed(1) +
      '" fill="hsl(' + Math.floor(Math.random() * 360) + ',50%,68%)"/>'
    );
  }
  // 字符：随机旋转 -40~40 度（与 dnsmgr 一致），深色保证可读
  const colors = ["#2b4c7e", "#7c3a1d", "#1f6b3b", "#5b2c6f", "#8a1c1c"];
  for (let i = 0; i < code.length; i++) {
    const x = 18 + i * 28 + (Math.random() - 0.5) * 8;
    const y = H - 12 + (Math.random() - 0.5) * 8;
    const angle = -40 + Math.random() * 80;
    parts.push(
      '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
      '" transform="rotate(' + angle.toFixed(1) + " " + x.toFixed(1) + " " + y.toFixed(1) + ')"' +
      ' font-family="Georgia,\'Times New Roman\',serif" font-size="28" font-weight="bold" fill="' +
      colors[i % colors.length] + '">' + code[i] + "</text>"
    );
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '">' + parts.join("") + "</svg>";
}

// 生成验证码：哈希存库（明文只出现在图里），返回 id + data URI 图片
async function newCaptcha(db: D1Database): Promise<{ id: string; image: string }> {
  await ensureSubscribeTables(db);
  const id = randomToken(12);
  const code = randomCaptchaCode();
  const hash = await sha256Hex(id + ":" + code.toLowerCase());
  // 顺手清理过期验证码
  await db
    .prepare(`DELETE FROM "wl_Captcha" WHERE "createdAt" < datetime('now','-' || ?1 || ' seconds')`)
    .bind(CAPTCHA_EXPIRE_SECONDS)
    .run()
    .catch(() => {});
  await db.prepare(`INSERT INTO "wl_Captcha" ("id","hash") VALUES (?1,?2)`).bind(id, hash).run();
  return { id, image: "data:image/svg+xml," + encodeURIComponent(captchaSvg(code)) };
}

// 校验验证码（一次性：无论成败都销毁，失败后前端重新取图，防同 id 暴力枚举）
async function checkCaptcha(db: D1Database, id: string, code: string): Promise<boolean> {
  if (!id || !code) return false;
  try {
    await ensureSubscribeTables(db);
    const row = await db
      .prepare(`SELECT "hash" FROM "wl_Captcha" WHERE "id"=?1`)
      .bind(id)
      .first<{ hash: string }>();
    await db.prepare(`DELETE FROM "wl_Captcha" WHERE "id"=?1`).bind(id).run();
    if (!row) return false;
    const hash = await sha256Hex(id + ":" + code.trim().toLowerCase());
    return row.hash === hash;
  } catch (e) {
    console.error("check captcha failed", e);
    return false;
  }
}

// Cloudflare Turnstile 服务端校验：POST siteverify（token 一次性、5 分钟有效）
async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  if (!secret || !token) return false;
  try {
    const fd = new URLSearchParams({ secret, response: token });
    if (ip) fd.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fd.toString(),
    });
    const d = (await r.json()) as { success?: boolean };
    return !!d.success;
  } catch (e) {
    console.error("turnstile verify failed", e);
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  );
}

// 独立订阅页（不依赖主题）：/subscribe?email=xxx
// 验证区随订阅设置变化：无 / Cloudflare Turnstile / 内置图形验证码
function subscribePageHtml(cfg: SubscribeConfig, prefillEmail: string): string {
  const site = escapeHtml(cfg.siteName || "本站");
  const email = escapeHtml(prefillEmail);
  const back = cfg.siteUrl
    ? '<p class="foot"><a href="' + escapeHtml(cfg.siteUrl) + '">返回站点</a></p>'
    : "";
  let verifyHtml = "";
  let verifyJs = "";
  if (cfg.verify === "cf" && cfg.cfSiteKey) {
    verifyHtml =
      '<div class="cf-turnstile" data-sitekey="' + escapeHtml(cfg.cfSiteKey) + '" style="margin:12px 0"></div>' +
      '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer><\/script>';
    verifyJs =
      'var tk=document.querySelector(\'[name="cf-turnstile-response"]\');body.cfToken=tk?tk.value:"";';
  } else if (cfg.verify === "builtin") {
    verifyHtml =
      '<div class="cap"><input type="text" id="cap" placeholder="验证码" autocomplete="off">' +
      '<img id="capImg" height="40" alt="验证码" title="点击更换验证码" style="cursor:pointer"></div>';
    verifyJs =
      'body.captchaId=window.__cid||"";body.captchaCode=(document.getElementById("cap")||{}).value||"";';
  }
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>订阅 - ' + site + "</title>" +
    "<style>" +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    "font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',Arial,sans-serif;" +
    'background:#f7f7f8;color:#1f2328}' +
    '.card{max-width:420px;width:calc(100% - 32px);padding:28px;background:#fff;border:1px solid #e3e3e4;border-radius:6px}' +
    'h1{margin:0 0 8px;font-size:18px}.desc{margin:0 0 16px;color:#6b7280}' +
    'input{width:100%;padding:9px 12px;border:1px solid #d0d7de;border-radius:4px;font-size:14px;' +
    'background:#fff;color:#1f2328;box-sizing:border-box}input:focus{outline:none;border-color:#f97316}' +
    'button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:4px;background:#f97316;color:#fff;font-size:14px;cursor:pointer}' +
    'button:hover{background:#ea580c}button[disabled]{opacity:.6;cursor:not-allowed}' +
    '.cap{display:flex;gap:8px;margin-top:12px;align-items:center}.cap input{flex:1}' +
    '.cap img{height:40px;border:1px solid #d0d7de;border-radius:4px;background:#fff}' +
    '.msg{margin:12px 0 0;min-height:20px;color:#6b7280}.msg.ok{color:#1a7f37}.msg.err{color:#dc2626}' +
    '.foot{margin:16px 0 0;text-align:center}.foot a{color:#f97316;text-decoration:none}' +
    "@media(prefers-color-scheme:dark){body{background:#0f1115;color:#e8e8e8}" +
    ".card{background:#181b20;border-color:#2b2f36}.desc,.msg{color:#9ca3af}" +
    "input{background:#14161a;border-color:#2b2f36;color:#e8e8e8}.cap img{background:#fff}}" +
    "</style></head><body>" +
    '<div class="card"><h1>订阅「' + site + '」</h1>' +
    '<p class="desc">输入邮箱，新文章发布时第一时间收到邮件通知。</p>' +
    '<form id="f"><input type="email" id="email" placeholder="you@example.com" value="' + email + '" required>' +
    verifyHtml +
    '<button type="submit" id="btn">订阅</button></form>' +
    '<p class="msg" id="msg"></p>' + back + "</div>" +
    "<script>(function(){" +
    "var f=document.getElementById('f'),msg=document.getElementById('msg'),btn=document.getElementById('btn');" +
    (cfg.verify === "builtin"
      ? "window.__cid='';function refreshCaptcha(){fetch('/api/captcha/new').then(function(r){return r.json();}).then(function(d){" +
        "if(d&&d.ok){window.__cid=d.id;var im=document.getElementById('capImg');if(im)im.src=d.image;}}).catch(function(){});}" +
        "document.getElementById('capImg').addEventListener('click',function(){refreshCaptcha();var ci=document.getElementById('cap');if(ci)ci.value='';});" +
        "refreshCaptcha();"
      : "") +
    "f.addEventListener('submit',function(e){e.preventDefault();" +
    "var email=(document.getElementById('email')||{}).value||'';email=email.trim();if(!email)return;" +
    "btn.disabled=true;msg.className='msg';msg.textContent='提交中…';" +
    "var body={email:email};" + verifyJs +
    "fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})" +
    ".then(function(r){return r.json().catch(function(){return {};});}).then(function(d){btn.disabled=false;" +
    "if(d&&d.ok){msg.className='msg ok';msg.textContent=d.message||'订阅成功';f.style.display='none';}" +
    "else{msg.className='msg err';msg.textContent=(d&&d.error)||'订阅失败，请稍后重试';" +
    (cfg.verify === "builtin" ? "refreshCaptcha();" : "") +
    (cfg.verify === "cf" ? "if(window.turnstile&&window.turnstile.reset)window.turnstile.reset();" : "") +
    "}}).catch(function(){btn.disabled=false;msg.className='msg err';msg.textContent='网络异常，请稍后重试';});});" +
    "})();<\/script></body></html>"
  );
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? "");
}

function mailSmtp(cfg: SubscribeConfig) {
  return {
    host: cfg.host,
    port: Number(cfg.port),
    user: cfg.user,
    pass: cfg.pass,
    fromName: cfg.fromName,
    fromEmail: cfg.fromEmail || cfg.user,
  };
}

function wrapMailHtml(inner: string): string {
  return (
    '<div style="font:14px/1.75 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'PingFang SC\',\'Microsoft YaHei\',Arial,sans-serif;color:#1f2328">' +
    inner +
    "</div>"
  );
}

// 群发给全部已确认订阅者（单次上限 100 封，避免 Worker 超时）
async function broadcastToConfirmed(
  env: Bindings,
  subjectTpl: string,
  bodyTpl: string,
  extraVars: Record<string, string>,
  origin: string
): Promise<{ sent: number; failed: number; total: number }> {
  const cfg = await getSubscribeConfig(env.DB);
  if (!cfg.host || !cfg.port) throw new Error("请先配置 SMTP");
  await ensureSubscribeTables(env.DB);
  const rows = await env.DB.prepare(
    `SELECT "email","token" FROM "wl_Subscriber" WHERE "status"='confirmed'`
  ).all<{ email: string; token: string }>();
  const list = rows.results || [];
  // 模板未包含退订按钮时，自动在邮件末尾补一个，确保每封邮件都能退订
  const tplHasUnsub = /\{\{\s*unsubscribe\s*\}\}/.test(bodyTpl);
  let sent = 0;
  let failed = 0;
  for (const s of list) {
    if (sent + failed >= 100) break;
    const vars: Record<string, string> = {
      site: cfg.siteName || "本站",
      email: s.email,
      unsubscribe: origin + "/api/subscribe/unsubscribe?token=" + s.token,
      ...extraVars,
    };
    try {
      let html = renderTemplate(bodyTpl, vars);
      if (!tplHasUnsub) {
        html +=
          '<hr><p style="color:#888;font-size:12px"><a href="' +
          vars.unsubscribe +
          '">不再接收邮件</a></p>';
      }
      await sendMail(mailSmtp(cfg), {
        to: s.email,
        subject: renderTemplate(subjectTpl, vars),
        html: wrapMailHtml(html),
      });
      sent++;
    } catch (e) {
      failed++;
      console.error("broadcast to " + s.email + " failed", e);
    }
  }
  return { sent, failed, total: list.length };
}

// 退订确认页：点击邮件里的退订链接先弹出确认，点「确认退订」才真正执行（POST），
// 避免误点或邮件安全软件预取链接导致误退订
function subscribeConfirmPage(
  title: string,
  message: string,
  siteUrl?: string,
  actionUrl?: string
): string {
  const back = siteUrl
    ? '<p style="margin-top:16px"><a href="' + siteUrl + '" style="color:#6b7280">暂不退订，返回站点</a></p>'
    : "";
  const form = actionUrl
    ? '<form method="post" action="' + actionUrl + '" style="margin-top:18px">' +
      '<button type="submit" style="padding:8px 24px;border:0;border-radius:4px;background:#dc2626;color:#fff;' +
      'font-size:14px;cursor:pointer">确认退订</button></form>'
    : "";
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    title +
    "</title></head>" +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    "font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',Arial,sans-serif;" +
    'background:#f7f7f8;color:#1f2328">' +
    '<div style="max-width:420px;width:calc(100% - 32px);padding:28px;background:#fff;border:1px solid #e3e3e4;border-radius:6px;text-align:center">' +
    '<h1 style="margin:0 0 10px;font-size:18px">' +
    title +
    '</h1><p style="color:#6b7280;margin:0">' +
    message +
    "</p>" +
    form +
    back +
    "</div></body></html>"
  );
}

function subscribeResultPage(
  title: string,
  message: string,
  siteUrl?: string,
  unsubUrl?: string
): string {
  const back = siteUrl
    ? '<p style="margin-top:16px"><a href="' + siteUrl + '" style="color:#f97316">返回站点</a></p>'
    : "";
  const unsub = unsubUrl
    ? '<p style="margin-top:16px"><a href="' +
      unsubUrl +
      '" style="display:inline-block;padding:8px 18px;border:1px solid #d0d7de;border-radius:4px;color:#1f2328;text-decoration:none">取消订阅</a></p>'
    : "";
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    title +
    "</title></head>" +
    '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    "font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',Arial,sans-serif;" +
    'background:#f7f7f8;color:#1f2328">' +
    '<div style="max-width:420px;width:calc(100% - 32px);padding:28px;background:#fff;border:1px solid #e3e3e4;border-radius:6px;text-align:center">' +
    '<h1 style="margin:0 0 10px;font-size:18px">' +
    title +
    '</h1><p style="color:#6b7280;margin:0">' +
    message +
    "</p>" +
    unsub +
    back +
    "</div></body></html>"
  );
}

// 订阅者提交（公开）：POST /api/subscribe  body: {"email":"a@b.com"}
app.options("/api/subscribe", (c) => new Response(null, { status: 204, headers: VISIT_CORS }));

app.post("/api/subscribe", async (c) => {
  const db = (c.env as Bindings).DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return subscribeJson({ ok: false, error: "邮箱格式不正确" }, 400);
  }
  try {
    const cfg = await getSubscribeConfig(db);
    // 订阅验证（订阅管理 → 订阅设置 可配置：无 / Cloudflare Turnstile / 内置图形验证码）
    if (cfg.verify === "cf") {
      const token = String(body?.cfToken || body?.["cf-turnstile-response"] || "");
      const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";
      if (!(await verifyTurnstile(cfg.cfSecretKey, token, ip))) {
        return subscribeJson({ ok: false, error: "请完成人机验证", needVerify: "cf" }, 400);
      }
    } else if (cfg.verify === "builtin") {
      const ok = await checkCaptcha(
        db,
        String(body?.captchaId || ""),
        String(body?.captchaCode || "")
      );
      if (!ok) {
        return subscribeJson(
          { ok: false, error: "验证码错误或已过期，请重新输入", needVerify: "builtin" },
          400
        );
      }
    }
    if (!cfg.host || !cfg.port) {
      return subscribeJson({ ok: false, error: "订阅功能尚未配置" }, 503);
    }
    // 已订阅（待确认/已确认）的邮箱不再重复发送确认邮件；已退订的可重新订阅
    const existing = await db
      .prepare(`SELECT "status" FROM "wl_Subscriber" WHERE "email"=?1`)
      .bind(email)
      .first<{ status: string }>();
    if (existing && existing.status !== "unsubscribed") {
      return subscribeJson({
        ok: true,
        needConfirm: existing.status === "pending",
        message:
          existing.status === "confirmed"
            ? "该邮箱已订阅，无需重复订阅"
            : "该邮箱已提交订阅，请到邮箱完成确认",
      });
    }
    // 当日订阅上限（东八区）：达到后拒绝新订阅，防暴力刷订阅
    const limit = cfg.dailyLimit > 0 ? cfg.dailyLimit : 0;
    if (limit > 0) {
      const todayRow = await db
        .prepare(
          `SELECT COUNT(*) AS c FROM "wl_Subscriber" WHERE date("createdAt",'+8 hours')=?1`
        )
        .bind(visitDay())
        .first<{ c: number }>();
      if ((todayRow?.c ?? 0) >= limit) {
        return subscribeJson(
          { ok: false, error: `今日订阅名额已满（上限 ${limit}），请明天再试` },
          429
        );
      }
    }
    const token = randomToken();
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "";
    const ua = c.req.header("user-agent") || "";
    const status = cfg.needConfirm ? "pending" : "confirmed";
    await db
      .prepare(
        `INSERT INTO "wl_Subscriber" ("email","status","token","ip","ua","confirmedAt")
         VALUES (?1,?2,?3,?4,?5, CASE WHEN ?2='confirmed' THEN datetime('now') ELSE NULL END)
         ON CONFLICT("email") DO UPDATE SET "token"=?3,"status"=?2,"ip"=?4,"ua"=?5,"updatedAt"=datetime('now')`
      )
      .bind(email, status, token, ip, ua)
      .run();

    if (cfg.needConfirm) {
      const origin = new URL(c.req.url).origin;
      const vars = {
        site: cfg.siteName || "本站",
        email,
        link: origin + "/api/subscribe/confirm?token=" + token,
        unsubscribe: origin + "/api/subscribe/unsubscribe?token=" + token,
      };
      await sendMail(mailSmtp(cfg), {
        to: email,
        subject: renderTemplate(cfg.subject, vars),
        html: wrapMailHtml(renderTemplate(cfg.body, vars)),
      });
    }
    return subscribeJson({
      ok: true,
      needConfirm: cfg.needConfirm,
      message: cfg.needConfirm ? "确认邮件已发送，请查收邮箱完成订阅" : "订阅成功",
    });
  } catch (e) {
    console.error("subscribe failed", e);
    return subscribeJson(
      { ok: false, error: "订阅失败：" + (e instanceof Error ? e.message : String(e)) },
      500
    );
  }
});

// 订阅验证配置（公开，供自定义表单渲染验证码用）：GET /api/subscribe/verify
app.get("/api/subscribe/verify", async (c) => {
  try {
    const cfg = await getSubscribeConfig((c.env as Bindings).DB);
    return subscribeJson({
      ok: true,
      verify: cfg.verify === "cf" && !cfg.cfSiteKey ? "none" : cfg.verify,
      cfSiteKey: cfg.cfSiteKey || "",
    });
  } catch (e) {
    return subscribeJson({ ok: true, verify: "none", cfSiteKey: "" });
  }
});

// 内置验证码取图（公开，一次性）：GET /api/captcha/new → {id, image(data URI)}
// 自定义表单接入：取图 → 用户输入 → POST /api/subscribe 带 captchaId + captchaCode
app.options("/api/captcha/new", (c) => new Response(null, { status: 204, headers: VISIT_CORS }));
app.get("/api/captcha/new", async (c) => {
  try {
    const d = await newCaptcha((c.env as Bindings).DB);
    return subscribeJson({ ok: true, ...d });
  } catch (e) {
    console.error("captcha new failed", e);
    return subscribeJson({ ok: false, error: "验证码生成失败" }, 500);
  }
});

// 独立订阅页（不依赖主题）：/subscribe?email=xxx
// 主题订阅框提交后跳转到这里完成验证；也可直接分享此链接
app.get("/subscribe", async (c) => {
  const cfg = await getSubscribeConfig((c.env as Bindings).DB).catch(
    () => SUBSCRIBE_DEFAULT_CONFIG
  );
  const email = (c.req.query("email") || "").slice(0, 200);
  c.header("Cache-Control", "no-store, must-revalidate");
  return c.html(subscribePageHtml(cfg, email));
});

// 确认订阅：GET /api/subscribe/confirm?token=xxx
app.get("/api/subscribe/confirm", async (c) => {
  const token = c.req.query("token") || "";
  const cfg = await getSubscribeConfig((c.env as Bindings).DB).catch(
    () => SUBSCRIBE_DEFAULT_CONFIG
  );
  if (!token) {
    return c.html(subscribeResultPage("链接无效", "缺少确认参数。", cfg.siteUrl), 400);
  }
  try {
    const r = await (c.env as Bindings).DB.prepare(
      `UPDATE "wl_Subscriber" SET "status"='confirmed',"confirmedAt"=datetime('now'),"updatedAt"=datetime('now') WHERE "token"=?1`
    )
      .bind(token)
      .run();
    const ok = ((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
    const unsubUrl =
      new URL(c.req.url).origin + "/api/subscribe/unsubscribe?token=" + token;
    return c.html(
      ok
        ? subscribeResultPage("订阅成功", "你已成功订阅，感谢关注！", cfg.siteUrl, unsubUrl)
        : subscribeResultPage("链接无效", "该确认链接已失效或不存在。", cfg.siteUrl),
      ok ? 200 : 404
    );
  } catch (e) {
    console.error("subscribe confirm failed", e);
    return c.html(subscribeResultPage("处理失败", "请稍后重试。", cfg.siteUrl), 500);
  }
});

// 退订：GET /api/subscribe/unsubscribe?token=xxx → 确认页（点「确认退订」后 POST 才执行）
app.get("/api/subscribe/unsubscribe", async (c) => {
  const token = c.req.query("token") || "";
  const cfg = await getSubscribeConfig((c.env as Bindings).DB).catch(
    () => SUBSCRIBE_DEFAULT_CONFIG
  );
  if (!token) {
    return c.html(subscribeResultPage("链接无效", "缺少退订参数。", cfg.siteUrl), 400);
  }
  return c.html(
    subscribeConfirmPage(
      "确认退订",
      "你正在退订 <b>" + (cfg.siteName || "本站") + "</b> 的邮件通知，确认后将不再收到新文章邮件。",
      cfg.siteUrl,
      "/api/subscribe/unsubscribe?token=" + encodeURIComponent(token)
    )
  );
});

// 退订确认：POST /api/subscribe/unsubscribe（表单里的「确认退订」按钮触发）
app.post("/api/subscribe/unsubscribe", async (c) => {
  const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>;
  const token = c.req.query("token") || String(body.token || "");
  const cfg = await getSubscribeConfig((c.env as Bindings).DB).catch(
    () => SUBSCRIBE_DEFAULT_CONFIG
  );
  if (!token) {
    return c.html(subscribeResultPage("链接无效", "缺少退订参数。", cfg.siteUrl), 400);
  }
  try {
    const r = await (c.env as Bindings).DB.prepare(
      `UPDATE "wl_Subscriber" SET "status"='unsubscribed',"updatedAt"=datetime('now') WHERE "token"=?1`
    )
      .bind(token)
      .run();
    const ok = ((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
    // 用户主动退订成功后，发一封「已退订」提示邮件（后台删除不在此逻辑内）
    if (ok && cfg.host && cfg.port) {
      try {
        const sub = await (c.env as Bindings).DB.prepare(
          `SELECT "email" FROM "wl_Subscriber" WHERE "token"=?1`
        )
          .bind(token)
          .first<{ email: string }>();
        if (sub?.email) {
          const vars = {
            site: cfg.siteName || "本站",
            email: sub.email,
            unsubscribe: new URL(c.req.url).origin + "/api/subscribe/unsubscribe?token=" + token,
          };
          await sendMail(mailSmtp(cfg), {
            to: sub.email,
            subject: renderTemplate(cfg.unsubSubject, vars),
            html: wrapMailHtml(renderTemplate(cfg.unsubBody, vars)),
          });
        }
      } catch (e) {
        console.error("send unsubscribe mail failed", e);
      }
    }
    return c.html(
      ok
        ? subscribeResultPage("已退订", "你已成功退订，不会再收到邮件。", cfg.siteUrl)
        : subscribeResultPage("链接无效", "该退订链接已失效或不存在。", cfg.siteUrl),
      ok ? 200 : 404
    );
  } catch (e) {
    console.error("subscribe unsubscribe failed", e);
    return c.html(subscribeResultPage("处理失败", "请稍后重试。", cfg.siteUrl), 500);
  }
});

// 订阅数统计（公开）：GET /api/subscribe/stats
app.get("/api/subscribe/stats", async (c) => {
  try {
    const db = (c.env as Bindings).DB;
    await ensureSubscribeTables(db);
    const row = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM "wl_Subscriber") AS total,
                (SELECT COUNT(*) FROM "wl_Subscriber" WHERE "status"='confirmed') AS confirmed`
      )
      .first<{ total: number; confirmed: number }>();
    return subscribeJson({
      ok: true,
      total: row?.total ?? 0,
      confirmed: row?.confirmed ?? 0,
    });
  } catch (e) {
    return subscribeJson({ ok: false, total: 0, confirmed: 0 });
  }
});

// 读取订阅/SMTP 配置（管理员，密码不回传）
app.get("/admin/api/subscribe/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  try {
    const cfg = await getSubscribeConfig((c.env as Bindings).DB);
    return json({
      ok: true,
      ...cfg,
      pass: "",
      hasPass: !!cfg.pass,
      cfSecretKey: "",
      hasCfSecret: !!cfg.cfSecretKey,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 保存订阅/SMTP 配置（管理员，pass 留空表示不修改）
app.put("/admin/api/subscribe/settings", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const asStr = (v: unknown, fb: string) => (v == null ? fb : String(v));
  const asBool = (v: unknown, fb: boolean) => (v == null ? fb : !!v);
  const asNum = (v: unknown, fb: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : fb;
  };
  const asLimit = (v: unknown, fb: number) => {
    const n = parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) && n > 0 && n <= 1000000 ? n : fb;
  };
  try {
    const cur = await getSubscribeConfig(db);
    const next: SubscribeConfig = {
      host: asStr(body.host, cur.host).trim(),
      port: asNum(body.port, cur.port),
      user: asStr(body.user, cur.user).trim(),
      pass: body.pass === undefined || body.pass === "" ? cur.pass : String(body.pass),
      fromName: asStr(body.fromName, cur.fromName),
      fromEmail: asStr(body.fromEmail, cur.fromEmail).trim(),
      secure: asBool(body.secure, cur.secure),
      siteName: asStr(body.siteName, cur.siteName),
      siteUrl: asStr(body.siteUrl, cur.siteUrl).trim(),
      subject: asStr(body.subject, cur.subject),
      body: asStr(body.body, cur.body),
      needConfirm: asBool(body.needConfirm, cur.needConfirm),
      notifySubject: asStr(body.notifySubject, cur.notifySubject),
      notifyBody: asStr(body.notifyBody, cur.notifyBody),
      unsubSubject: asStr(body.unsubSubject, cur.unsubSubject),
      unsubBody: asStr(body.unsubBody, cur.unsubBody),
      dailyLimit: asLimit(body.dailyLimit, cur.dailyLimit),
      verify: (["none", "cf", "builtin"] as const).includes(body.verify as never)
        ? (body.verify as SubscribeConfig["verify"])
        : cur.verify,
      cfSiteKey: asStr(body.cfSiteKey, cur.cfSiteKey).trim(),
      cfSecretKey:
        body.cfSecretKey === undefined || body.cfSecretKey === ""
          ? cur.cfSecretKey
          : String(body.cfSecretKey),
    };
    await saveSubscribeConfig(db, next);
    return json({
      ok: true,
      ...next,
      pass: "",
      hasPass: !!next.pass,
      cfSecretKey: "",
      hasCfSecret: !!next.cfSecretKey,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 发送测试邮件（管理员）：POST /admin/api/subscribe/test  body {"to":"..."}
app.post("/admin/api/subscribe/test", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { to?: unknown };
  const to = String(body?.to ?? "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return json({ ok: false, error: "收件邮箱格式不正确" }, 400);
  }
  try {
    const cfg = await getSubscribeConfig((c.env as Bindings).DB);
    if (!cfg.host || !cfg.port) {
      return json({ ok: false, error: "请先填写并保存 SMTP 配置" }, 400);
    }
    await sendMail(mailSmtp(cfg), {
      to,
      subject: "【测试】" + (cfg.siteName || "邮件配置"),
      html: wrapMailHtml(
        "<p>这是一封测试邮件。</p><p>收到即表示你的 SMTP 配置可用，可以正常发送订阅邮件了。</p>"
      ),
    });
    return json({ ok: true, message: "测试邮件已发送，请查收" });
  } catch (e) {
    console.error("subscribe test failed", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// 订阅者列表（管理员）：GET /admin/api/subscribe/list?status=&q=&page=&pageSize=
app.get("/admin/api/subscribe/list", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const db = (c.env as Bindings).DB;
  try {
    await ensureSubscribeTables(db);
    const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
    const pageSize = Math.min(
      200,
      Math.max(1, parseInt(c.req.query("pageSize") || "50", 10) || 50)
    );
    const status = c.req.query("status") || "";
    const q = (c.req.query("q") || "").trim();
    const where: string[] = [];
    const binds: unknown[] = [];
    if (["pending", "confirmed", "unsubscribed"].includes(status)) {
      where.push('"status"=?');
      binds.push(status);
    }
    if (q) {
      where.push('"email" LIKE ?');
      binds.push("%" + q + "%");
    }
    const clause = where.length ? " WHERE " + where.join(" AND ") : "";
    const totalRow = await db
      .prepare(`SELECT COUNT(*) AS count FROM "wl_Subscriber"` + clause)
      .bind(...binds)
      .first<{ count: number }>();
    const rows = await db
      .prepare(
        `SELECT "id","email","status","createdAt","confirmedAt" FROM "wl_Subscriber"` +
          clause +
          ` ORDER BY "id" DESC LIMIT ? OFFSET ?`
      )
      .bind(...binds, pageSize, (page - 1) * pageSize)
      .all();
    const stats = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM "wl_Subscriber") AS total,
                (SELECT COUNT(*) FROM "wl_Subscriber" WHERE "status"='confirmed') AS confirmed,
                (SELECT COUNT(*) FROM "wl_Subscriber" WHERE "status"='pending') AS pending,
                (SELECT COUNT(*) FROM "wl_Subscriber" WHERE "status"='unsubscribed') AS unsubscribed,
                (SELECT COUNT(*) FROM "wl_Subscriber" WHERE date("createdAt",'+8 hours')=?1) AS today`
      )
      .bind(visitDay())
      .first();
    return json({
      ok: true,
      page,
      pageSize,
      total: totalRow?.count ?? 0,
      stats,
      list: rows.results || [],
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 删除订阅者（管理员）：DELETE /admin/api/subscribe/subscriber?id=1
app.delete("/admin/api/subscribe/subscriber", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const id = parseInt(c.req.query("id") || "", 10);
  if (!Number.isFinite(id)) return json({ error: "id 无效" }, 400);
  try {
    await (c.env as Bindings).DB.prepare(`DELETE FROM "wl_Subscriber" WHERE "id"=?1`)
      .bind(id)
      .run();
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 手动通过（管理员）：POST /admin/api/subscribe/approve  body {"id":1}
// 将「待确认」订阅者直接置为「已确认」，无需对方点邮件确认
app.post("/admin/api/subscribe/approve", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { id?: unknown };
  const id = parseInt(String(body?.id ?? ""), 10);
  if (!Number.isFinite(id)) return json({ ok: false, error: "id 无效" }, 400);
  try {
    const r = await (c.env as Bindings).DB.prepare(
      `UPDATE "wl_Subscriber" SET "status"='confirmed',"confirmedAt"=datetime('now'),"updatedAt"=datetime('now')
       WHERE "id"=?1 AND "status"!='confirmed'`
    )
      .bind(id)
      .run();
    const changed = ((r.meta as { changes?: number } | undefined)?.changes ?? 0) > 0;
    return json({ ok: true, changed });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
});

// 群发邮件给全部已确认订阅者（管理员）：POST /admin/api/subscribe/send
// body {"subject":"...","body":"<html>"}，单次最多 100 封（避免 Worker 超时）
app.post("/admin/api/subscribe/send", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as {
    subject?: unknown;
    body?: unknown;
  };
  const subject = String(body?.subject ?? "").trim();
  const content = String(body?.body ?? "").trim();
  if (!subject || !content) return json({ ok: false, error: "主题和正文不能为空" }, 400);
  try {
    const origin = new URL(c.req.url).origin;
    const r = await broadcastToConfirmed(c.env as Bindings, subject, content, {}, origin);
    if (!r.total) return json({ ok: false, error: "暂无已确认的订阅者" }, 400);
    return json({ ok: true, ...r, limited: r.total > 100 });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// 新文章发布通知（内部接口）：由 GitHub Actions 在博客构建完成后回调
// 鉴权：请求头 x-notify-secret 必须等于 Worker 的 GH_TOKEN（与工作流的 secrets.GH_TOKEN 同值）
// body {"title":"文章标题","url":"文章链接"}
app.post("/api/internal/notify-published", async (c) => {
  const env = c.env as Bindings;
  const secret = c.req.header("x-notify-secret") || "";
  if (!env.GH_TOKEN || secret !== env.GH_TOKEN) {
    return json({ error: "unauthorized" }, 401);
  }
  const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; url?: unknown };
  const title = String(body?.title ?? "").trim();
  const url = String(body?.url ?? "").trim();
  if (!title) return json({ ok: false, error: "title required" }, 400);
  try {
    const cfg = await getSubscribeConfig(env.DB);
    const origin = new URL(c.req.url).origin;
    const r = await broadcastToConfirmed(
      env,
      cfg.notifySubject,
      cfg.notifyBody,
      { title, url },
      origin
    );
    return json({ ok: true, ...r });
  } catch (e) {
    console.error("notify published failed", e);
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// ---------- 文件管理（GitHub Contents API）----------
app.get("/admin/api/branches", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleListBranches(c.env as Bindings);
});

app.get("/admin/api/files", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const path = c.req.query("path") || "";
  const branch = c.req.query("branch") || "";
  return handleListFiles(c.env as Bindings, path, branch || undefined);
});

app.get("/admin/api/file", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const path = c.req.query("path") || "";
  if (!path) return json({ error: "path required" }, 400);
  const branch = c.req.query("branch") || "";
  return handleGetFile(c.env as Bindings, path, branch || undefined);
});

app.put("/admin/api/file", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleSaveFile(c.env as Bindings, await c.req.json());
});

// 回收站：批量移入 / 恢复 / 彻底删除（回收站为同分支下的 _recycle 目录，不单独开分支）
app.post("/admin/api/files/recycle", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { paths?: unknown; branch?: unknown };
  return json(await handleRecyclePaths(c.env as Bindings, body.paths, body.branch));
});

app.post("/admin/api/files/restore", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { paths?: unknown; branch?: unknown };
  return json(await handleRestorePaths(c.env as Bindings, body.paths, body.branch));
});

app.post("/admin/api/files/purge", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { paths?: unknown; branch?: unknown };
  return json(await handlePurgePaths(c.env as Bindings, body.paths, body.branch));
});

// 重命名 / 移动文件或目录（目录整体一次提交）
app.post("/admin/api/files/move", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  const body = (await c.req.json().catch(() => ({}))) as { from?: unknown; to?: unknown; branch?: unknown };
  const from = String(body.from || "").trim().replace(/^\/+|\/+$/g, "");
  const to = String(body.to || "").trim().replace(/^\/+|\/+$/g, "");
  if (!from || !to) return json({ ok: false, error: "from/to required" }, 400);
  const branch = String(body.branch || "").trim() || ghConfig(c.env as Bindings).branch;
  return json(await movePath(c.env as Bindings, from, to, branch));
});

app.post("/admin/api/upload", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleUploadFile(c.env as Bindings, c.req.raw);
});

app.post("/admin/api/unzip", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleUnzipFile(c.env as Bindings, c.req.raw);
});

app.post("/admin/api/unzip-path", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleUnzipByPath(c.env as Bindings, await c.req.json());
});

// 从网络下载文件保存进仓库
app.post("/admin/api/download", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleDownloadFile(c.env as Bindings, await c.req.json().catch(() => ({})));
});

// 大文件解压工作流状态
app.get("/admin/api/unzip-status", async (c) => {
  if (!isAdmin(c.get("userInfo"))) return json({ error: "unauthorized" }, 401);
  return handleUnzipStatus(c.env as Bindings);
});

// ---------- 5. /admin 统一管理后台（独立页面：管理文章 / 写作 / 评论 / 文件）----------
// 独立登录页：未登录跳转到 /admin/login
app.get("/admin/login", (c) => c.html(renderAdminLoginPage(c.env.SITE_URL || "")));
app.get("/admin/login/", (c) => c.html(renderAdminLoginPage(c.env.SITE_URL || "")));
// 服务端鉴权：bl_token 无效直接 302 到登录页（后台页不会闪现）
const adminPage = async (c: any, initial: string) => {
  const p = await adminPayload(adminCookieToken(c), c.env.JWT_SECRET);
  if (!p) return c.redirect("/admin/login");
  c.header("Cache-Control", "no-store, must-revalidate");
  return c.html(renderAdminPage(c.env.SITE_URL || "", c.env.GH_REPO || "", initial));
};
app.get("/admin", (c) => adminPage(c, "manage"));
app.get("/admin/", (c) => adminPage(c, "manage"));
app.get("/admin/manage", (c) => adminPage(c, "manage"));
app.get("/admin/manage/", (c) => adminPage(c, "manage"));
app.get("/admin/upload", (c) => adminPage(c, "upload"));
app.get("/admin/upload/", (c) => adminPage(c, "upload"));
app.get("/admin/write", (c) => adminPage(c, "write"));
app.get("/admin/write/", (c) => adminPage(c, "write"));
app.get("/admin/comments", (c) => adminPage(c, "comments"));
app.get("/admin/comments/", (c) => adminPage(c, "comments"));
app.get("/admin/files", (c) => adminPage(c, "files"));
app.get("/admin/files/", (c) => adminPage(c, "files"));
app.get("/admin/build", (c) => adminPage(c, "build"));
app.get("/admin/build/", (c) => adminPage(c, "build"));
app.get("/admin/theme", (c) => adminPage(c, "theme"));
app.get("/admin/theme/", (c) => adminPage(c, "theme"));
app.get("/admin/visit", (c) => adminPage(c, "visit"));
app.get("/admin/visit/", (c) => adminPage(c, "visit"));
app.get("/admin/subscribe", (c) => adminPage(c, "subscribe"));
app.get("/admin/subscribe/", (c) => adminPage(c, "subscribe"));
app.get("/admin/ai", (c) => adminPage(c, "ai"));
app.get("/admin/ai/", (c) => adminPage(c, "ai"));
// 带会话 id：/admin/ai/<id>，刷新后仍停留在该对话
app.get("/admin/ai/:id", (c) => adminPage(c, "ai"));
app.get("/admin/ai/:id/", (c) => adminPage(c, "ai"));
app.get("/admin/settings", (c) => adminPage(c, "settings"));
app.get("/admin/settings/", (c) => adminPage(c, "settings"));

// ---------- 6. 其余路径：反向代理 GitHub Pages 静态站点 ----------
app.all("*", async (c) => {
  const env = c.env as Bindings;
  const url = new URL(c.req.url);
  const path = url.pathname;

  // /ui（原 waline 后台）并入统一后台 /admin
  if (path === "/ui" || path.startsWith("/ui/")) {
    return Response.redirect(`${url.origin}/admin`, 302);
  }

  const pagesBase = pagesBaseUrl(env);
  // 注意：不能用 new URL(path, pagesBase)，因为前导 "/" 会丢掉 pagesBase 的路径前缀。
  // 项目站点的 pagesBase 形如 https://<owner>.github.io/<repo>，必须把 /<repo> 拼回去。
  const target = new URL(pagesBase + "/");
  const basePath = target.pathname.replace(/\/+$/, ""); // 用户站点为 ""，项目站点为 "/<repo>"
  let reqPath = path.startsWith("/") ? path : "/" + path;
  // 项目站点的 Hexo root 会是 /<repo>/，页面资源会带该前缀；这里先剥掉，避免拼成 /<repo>/<repo>/...
  if (basePath && reqPath === basePath) reqPath = "/";
  else if (basePath && reqPath.startsWith(basePath + "/")) reqPath = reqPath.slice(basePath.length);
  target.pathname = basePath + reqPath;
  target.search = url.search;
  if (reqPath.endsWith("/")) {
    target.pathname += "index.html";
  }
  try {
    const resp = await fetch(target.toString());
    if (resp.status === 404 && path !== "/") {
      const root = await fetch(pagesBase + "/");
      return new Response(root.body, {
        status: 200,
        headers: root.headers,
      });
    }
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch (e) {
    return new Response("Worker proxy error: " + String(e), { status: 502 });
  }
});

// ==================== GitHub 文章 CRUD 逻辑 ====================

function ghConfig(env: Bindings) {
  const token = env.GH_TOKEN;
  const repo = env.GH_REPO || "kf1145fan/kf1145fan.github.io";
  const branch = env.GH_BRANCH || "main";
  const postsDir = env.POSTS_DIR || "source/_posts";
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "blog-worker",
    "content-type": "application/json",
  };
  return { token, repo, branch, postsDir, headers };
}

async function handleListPosts(env: Bindings): Promise<Response> {
  const { token, repo, postsDir, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(postsDir)}`,
      { headers },
    );
    // 404 = 目录为空或尚未创建，视为没有文章而不是失败
    if (res.status === 404) return json({ ok: true, posts: [], allCategories: [], allTags: [] });
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any;
    const files = (Array.isArray(data) ? data : []).filter((f) => f.name?.endsWith(".md"));

    // 分批读取每篇 front matter（全并发会触发 GitHub 二级限流导致部分文章丢日期、排序错乱）
    const fetchMeta = async (f: any) => {
      let categories: string[] = [];
      let tags: string[] = [];
      let date = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const g = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeURIComponent(f.path)}`, { headers });
          if (g.ok) {
            const d = (await g.json()) as any;
            const raw = decodeURIComponent(escape(atob(d.content)));
            const parsed = parseFrontMatter(raw);
            categories = parsed.categories || [];
            tags = parsed.tags || [];
            date = parsed.date || "";
          }
          break;
        } catch {}
      }
      // 日期回退：优先 front matter date，其次文件名内 YYYY-MM-DD 前缀，最后用名字兜底
      const nameDate = String(f.name || "").match(/(\d{4}[-.]\d{2}[-.]\d{2})/);
      const sortDate = date || (nameDate ? nameDate[1].replace(/\./g, "-") : "");
      return { name: f.name, path: f.path, sha: f.sha, size: f.size, categories, tags, date: sortDate };
    };
    const posts: any[] = [];
    const CHUNK = 5;
    for (let i = 0; i < files.length; i += CHUNK) {
      posts.push(...(await Promise.all(files.slice(i, i + CHUNK).map(fetchMeta))));
      if (i + CHUNK < files.length) await new Promise((r) => setTimeout(r, 200));
    }

    // 按日期倒序（最新在前）
    posts.sort((a, b) => (b.date || "").localeCompare(a.date || "") || String(b.name).localeCompare(String(a.name)));

    // 聚合历史分类/标签（供输入框下拉建议）
    const allCategories = [...new Set(posts.flatMap((p) => p.categories))];
    const allTags = [...new Set(posts.flatMap((p) => p.tags))];

    return json({ ok: true, posts, allCategories, allTags });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleGetPost(env: Bindings, path: string): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`,
      { headers },
    );
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any;
    const raw = decodeURIComponent(escape(atob(data.content)));
    const parsed = parseFrontMatter(raw);
    return json({
      ok: true,
      post: { path: data.path, sha: data.sha, content: raw, ...parsed },
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ---------- 内容变更后是否自动运行工作流（后台「设置 → 后台设置 → 工作流触发模式」）----------
// auto：发文/删文/批量上传后自动触发 update-gh.yml 重建站点（新文章构建完成后通知订阅者）；
// manual：只推送到 GitHub，返回 need_workflow，由前端在日志位置提示管理员去运行工作流。
async function afterContentChange(
  env: Bindings,
  opts: { notify?: boolean; postTitle?: string; postUrl?: string } = {},
): Promise<{ workflow_mode: "auto" | "manual"; build_triggered?: boolean; need_workflow?: boolean }> {
  const mode = await workflowModeOf(env);
  if (mode === "manual") return { workflow_mode: "manual", need_workflow: true };
  const { repo, branch, headers } = ghConfig(env);
  const payload: { ref: string; inputs?: Record<string, string> } = { ref: branch };
  if (opts.notify) {
    payload.inputs = {
      notify: "true",
      post_title: opts.postTitle || "",
      post_url: opts.postUrl || "",
    };
  }
  const disp = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/update-gh.yml/dispatches`,
    { method: "POST", headers, body: JSON.stringify(payload) },
  ).catch(() => null);
  return { workflow_mode: "auto", build_triggered: !!disp && disp.ok };
}

async function handleWritePost(
  env: Bindings,
  body: any,
  isUpdate: boolean,
): Promise<Response> {
  const { token, repo, branch, postsDir, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);

  const title = String(body.title || "").trim();
  const content = String(body.content || "");
  const tags = Array.isArray(body.tags) ? body.tags.map((x: any) => String(x)) : [];
  const categories = Array.isArray(body.categories)
    ? body.categories.map((x: any) => String(x))
    : [];
  const date = String(body.date || new Date().toISOString().slice(0, 10));
  const targetPath = String(body.path || "").trim();

  if (!title) return json({ ok: false, error: "title required" }, 400);
  if (!content) return json({ ok: false, error: "content required" }, 400);

  const slug = title
    .replace(/[^\w\u4e00-\u9fa5\- ]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  const filename = isUpdate && targetPath ? targetPath.split("/").pop()! : `${date}-${slug || "post"}.md`;
  const path = isUpdate && targetPath ? targetPath : `${postsDir}/${filename}`;

  // front matter
  const fm: string[] = ["---", `title: '${title.replace(/'/g, "\\'")}'`, `date: ${date} 00:00:00`];
  if (categories.length) fm.push(`categories:\n  ${categories.map((x: any) => `- ${x}`).join("\n  ")}`);
  if (tags.length) fm.push(`tags:\n  ${tags.map((x: any) => `- ${x}`).join("\n  ")}`);
  fm.push("---", "");
  const fileContent = fm.join("\n") + (isUpdate ? stripFrontMatter(content) : content) + "\n";

  const rawApi = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`;
  let sha: string | undefined;
  try {
    const exist = await fetch(rawApi, { headers });
    if (exist.ok) sha = ((await exist.json()) as any).sha;
  } catch {}

  const payload: any = {
    message: isUpdate ? `docs: update post ${filename}` : `docs: add post ${filename}`,
    content: btoa(unescape(encodeURIComponent(fileContent))),
    branch,
  };
  if (sha) payload.sha = sha;

  try {
    const res = await fetch(rawApi, { method: "PUT", headers, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ ok: false, error: "github error: " + (data as any).message || res.status }, 502);

    // 发布/更新文章后按「工作流触发模式」处理（设置 → 后台设置）：
    // auto=自动触发 update-gh.yml 重建站点（新文章构建完通知订阅者）；manual=只推 GitHub，由前端提示运行工作流。
    let postUrl = path;
    if (!isUpdate) {
      const pagesUrl = (env.SITE_URL || "").trim().replace(/\/+$/, "") || pagesBaseUrl(env);
      const pageTitle = filename.replace(/\.md$/, "");
      postUrl = pagesUrl
        ? pagesUrl +
          "/" +
          (date.replace(/-/g, "/") + "/" + pageTitle)
            .split("/")
            .map(encodeURIComponent)
            .join("/") +
          "/"
        : path;
    }
    const build = await afterContentChange(
      env,
      isUpdate ? {} : { notify: true, postTitle: title, postUrl },
    );
    return json({
      ok: true,
      path,
      filename,
      ...build,
      message:
        build.workflow_mode === "manual"
          ? "已提交并推送到 GitHub，需运行工作流才会更新站点"
          : isUpdate
            ? "已提交，工作流会自动重建博客"
            : "已提交，正在构建博客；构建完成后会自动邮件通知订阅者",
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ---------- 回收站（同分支 _recycle 目录，可恢复 / 彻底删除）----------
const RECYCLE_DIR = "_recycle";

type OpResult = { path: string; ok: boolean; moved?: string; error?: string };

// 分支名可能含 /，按段编码保留斜杠（Git 引用路径）
function ghRefPath(branch: string): string {
  return String(branch || "").split("/").map(encodeURIComponent).join("/");
}

// 读取分支的「最新提交 sha + 根树 sha + 递归文件清单」（Git 数据 API）
// 用途：一次性批量移动/删除整个目录，避免逐文件请求触发 Worker 子请求上限
async function ghTreeInfo(
  env: Bindings,
  branch: string,
): Promise<{ ok: boolean; commitSha?: string; treeSha?: string; tree?: any[]; error?: string }> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return { ok: false, error: "GH_TOKEN not configured" };
  try {
    const refRes = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${ghRefPath(branch)}`, { headers });
    if (!refRes.ok) return { ok: false, error: "读取分支失败 " + refRes.status };
    const ref = (await refRes.json()) as any;
    const commitSha = ref?.object?.sha;
    if (!commitSha) return { ok: false, error: "读取分支失败" };
    const cRes = await fetch(`https://api.github.com/repos/${repo}/git/commits/${commitSha}`, { headers });
    if (!cRes.ok) return { ok: false, error: "读取提交失败 " + cRes.status };
    const commit = (await cRes.json()) as any;
    const treeSha = commit?.tree?.sha;
    if (!treeSha) return { ok: false, error: "读取树失败" };
    const tRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${treeSha}?recursive=1`, { headers });
    if (!tRes.ok) return { ok: false, error: "读取树失败 " + tRes.status };
    const t = (await tRes.json()) as any;
    return { ok: true, commitSha, treeSha, tree: Array.isArray(t?.tree) ? t.tree : [] };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 一次提交应用一批树变更（sha 为 null 表示删除该路径），共 3 个子请求
async function ghCommitTree(
  env: Bindings,
  branch: string,
  parentSha: string,
  baseTreeSha: string,
  entries: any[],
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return { ok: false, error: "GH_TOKEN not configured" };
  try {
    const tRes = await fetch(`https://api.github.com/repos/${repo}/git/trees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ base_tree: baseTreeSha, tree: entries }),
    });
    if (!tRes.ok) return { ok: false, error: "创建树失败 " + tRes.status };
    const tree = (await tRes.json()) as any;
    const cRes = await fetch(`https://api.github.com/repos/${repo}/git/commits`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
    });
    if (!cRes.ok) return { ok: false, error: "创建提交失败 " + cRes.status };
    const commit = (await cRes.json()) as any;
    const rRes = await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${ghRefPath(branch)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    if (!rRes.ok) return { ok: false, error: "更新分支失败 " + rRes.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// 取出目录下所有文件（含子目录；跳过子模块/树节点），返回递归清单中的 blob 条目
function treeFilesUnder(tree: any[], dir: string): any[] {
  const norm = String(dir).replace(/^\/+|\/+$/g, "");
  return (tree || []).filter(
    (e: any) => e && e.type === "blob" && (e.path === norm || String(e.path).startsWith(norm + "/")),
  );
}

// 用一次提交把整个目录移到新位置（同一提交里：新路径引用原 blob，原路径置空删除）
async function moveDirByTree(
  env: Bindings,
  from: string,
  to: string,
  branch: string,
): Promise<{ ok: boolean; moved?: string; error?: string }> {
  const info = await ghTreeInfo(env, branch);
  if (!info.ok) return { ok: false, error: info.error };
  const all = info.tree || [];
  const normFrom = String(from).replace(/^\/+|\/+$/g, "");
  const normTo = String(to).replace(/^\/+|\/+$/g, "");
  const under = treeFilesUnder(all, normFrom);
  if (!under.length) return { ok: false, error: "目录为空或不存在" };
  // 目标已存在时自动加序号，避免覆盖
  const paths = new Set(all.map((e: any) => e.path));
  const taken = (p: string) => paths.has(p) || all.some((e: any) => String(e.path).startsWith(p + "/"));
  let target = normTo;
  if (taken(target)) {
    for (let i = 1; i <= 100; i++) {
      const cand = normTo + "-" + i;
      if (!taken(cand)) { target = cand; break; }
    }
  }
  const entries: any[] = [];
  for (const e of under) {
    const rel = String(e.path).slice(normFrom.length).replace(/^\/+/, "");
    entries.push({ path: target + "/" + rel, mode: e.mode || "100644", type: "blob", sha: e.sha });
    entries.push({ path: e.path, mode: e.mode || "100644", type: "blob", sha: null });
  }
  const r = await ghCommitTree(env, branch, info.commitSha as string, info.treeSha as string, entries, `docs: move ${normFrom} -> ${target}`);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, moved: target };
}

// 用一次提交彻底删除整个目录
async function deleteDirByTree(env: Bindings, path: string, branch: string): Promise<Response> {
  const info = await ghTreeInfo(env, branch);
  if (!info.ok) return json({ ok: false, error: info.error }, 500);
  const norm = String(path).replace(/^\/+|\/+$/g, "");
  const under = treeFilesUnder(info.tree || [], norm);
  if (!under.length) return json({ ok: false, error: "目录为空或不存在" }, 404);
  const entries = under.map((e: any) => ({ path: e.path, mode: e.mode || "100644", type: "blob", sha: null }));
  const r = await ghCommitTree(env, branch, info.commitSha as string, info.treeSha as string, entries, `docs: delete ${norm}`);
  if (!r.ok) return json({ ok: false, error: r.error }, 502);
  return json({ ok: true, message: "已删除目录 " + norm });
}

// 读取仓库节点（文件或目录）；不存在返回 null
async function ghGetNode(env: Bindings, path: string, branch: string): Promise<any | null> {
  const { repo, headers } = ghConfig(env);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${ghPath(path)}?ref=${encodeURIComponent(branch)}`,
      { headers },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// 目标已存在时自动加序号，避免覆盖
async function freePath(env: Bindings, path: string, branch: string): Promise<string> {
  if (!(await ghGetNode(env, path, branch))) return path;
  const idx = path.lastIndexOf("/");
  const dir = idx >= 0 ? path.slice(0, idx) : "";
  const base = idx >= 0 ? path.slice(idx + 1) : path;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; i <= 100; i++) {
    const cand = (dir ? dir + "/" : "") + `${stem}-${i}${ext}`;
    if (!(await ghGetNode(env, cand, branch))) return cand;
  }
  return `${path}-${Date.now()}`;
}

// 移动文件/目录（目录递归），返回实际落点
async function movePath(
  env: Bindings,
  from: string,
  to: string,
  branch: string,
): Promise<{ ok: boolean; moved?: string; error?: string }> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return { ok: false, error: "GH_TOKEN not configured" };
  const node = await ghGetNode(env, from, branch);
  if (!node) return { ok: false, error: "未找到 " + from };

  if (Array.isArray(node)) {
    // 目录：用 Git 数据 API 一次提交整体移动，避免大目录逐文件请求触顶
    return moveDirByTree(env, from, to, branch);
  }

  const target = await freePath(env, to, branch);
  let content: string = node.content || "";
  if (!content && node.git_url) {
    // 超过 1MB 的文件 contents API 不返回内容，改取 blob
    try {
      const b = await fetch(node.git_url, { headers });
      if (b.ok) content = ((await b.json()) as any).content || "";
    } catch {}
  }
  const put = await fetch(`https://api.github.com/repos/${repo}/contents/${ghPath(target)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ message: `docs: move ${from} -> ${target}`, content, branch }),
  });
  if (!put.ok) return { ok: false, error: "写入目标失败 " + put.status };
  const del = await fetch(`https://api.github.com/repos/${repo}/contents/${ghPath(from)}`, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ sha: node.sha, message: `docs: move ${from} -> ${target}`, branch }),
  });
  if (!del.ok) return { ok: false, error: "删除源失败 " + del.status };
  return { ok: true, moved: target };
}

function normalizePaths(input: unknown): string[] {
  return Array.isArray(input)
    ? input.map((x: unknown) => String(x).replace(/^\/+|\/+$/g, "")).filter(Boolean)
    : [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 删除文章时同步清理对应评论（按文件 slug 匹配页面 URL，如 /2026/07/18/xxx/）
// Hexo :title 默认为完整文件名（可能含日期前缀），两种都匹配以免漏删
async function deleteCommentsForPost(env: Bindings, path: string): Promise<number> {
  const name = path.split("/").pop() || "";
  if (!/\.(md|markdown|txt)$/i.test(name)) return 0;
  const full = name.replace(/\.(md|markdown|txt)$/i, "");
  const slim = full.replace(/^\d{4}-\d{2}-\d{2}-?/, "");
  const slugs = [...new Set([full, slim].filter(Boolean))];
  if (!slugs.length) return 0;
  try {
    const conds = slugs.map((_, i) => `url LIKE ?${i * 3 + 1} OR url LIKE ?${i * 3 + 2} OR url = ?${i * 3 + 3}`).join(" OR ");
    const binds = slugs.flatMap((s) => [`%/${s}/%`, `%/${s}`, `/${s}`]);
    const r = await (env as { DB: D1Database }).DB
      .prepare(`DELETE FROM wl_Comments WHERE ${conds}`)
      .bind(...binds)
      .run();
    return r.meta?.changes ?? 0;
  } catch {
    return 0;
  }
}

// 移入回收站（文章删除、文件管理删除、批量删除共用）
async function handleRecyclePaths(env: Bindings, input: unknown, branchIn?: unknown) {
  const branch = String(branchIn || "").trim() || ghConfig(env).branch;
  const paths = normalizePaths(input);
  const results: OpResult[] = [];
  if (!paths.length) return { ok: false, error: "paths required", moved: 0, total: 0, results };
  const { postsDir } = ghConfig(env);
  for (const p of paths) {
    if (p === RECYCLE_DIR || p.startsWith(RECYCLE_DIR + "/")) {
      results.push({ path: p, ok: false, error: "已在回收站中" });
      continue;
    }
    // 逐项重试（GitHub 二级限流会导致部分请求失败而丢文件），仍失败则记录明细
    let r: { ok: boolean; moved?: string; error?: string } = { ok: false, error: "未执行" };
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await movePath(env, p, `${RECYCLE_DIR}/${p}`, branch);
      if (r.ok) break;
      await sleep(500);
    }
    results.push({ path: p, ok: r.ok, moved: r.moved, error: r.error });
    // 删除文章（posts 目录下的 md/markdown/txt）时同步删除其评论
    if (r.ok && postsDir && p.startsWith(postsDir + "/")) {
      const c = await deleteCommentsForPost(env, p);
      if (c > 0) console.log(`recycle ${p}: removed ${c} comments`);
    }
    await sleep(150);
  }
  const moved = results.filter((r) => r.ok).length;
  return { ok: moved > 0, moved, total: paths.length, results };
}

// 从回收站恢复（回到原路径）
async function handleRestorePaths(env: Bindings, input: unknown, branchIn?: unknown) {
  const branch = String(branchIn || "").trim() || ghConfig(env).branch;
  const paths = normalizePaths(input);
  const results: OpResult[] = [];
  if (!paths.length) return { ok: false, error: "paths required", restored: 0, total: 0, results };
  for (const p of paths) {
    if (!p.startsWith(RECYCLE_DIR + "/")) {
      results.push({ path: p, ok: false, error: "不在回收站中" });
      continue;
    }
    const r = await movePath(env, p, p.slice(RECYCLE_DIR.length + 1), branch);
    results.push({ path: p, ok: r.ok, moved: r.moved, error: r.error });
    await sleep(150);
  }
  const restored = results.filter((r) => r.ok).length;
  return { ok: restored > 0, restored, total: paths.length, results };
}

// 彻底删除（不可恢复）
async function handlePurgePaths(env: Bindings, input: unknown, branchIn?: unknown) {
  const branch = String(branchIn || "").trim() || ghConfig(env).branch;
  const paths = normalizePaths(input);
  const results: OpResult[] = [];
  if (!paths.length) return { ok: false, error: "paths required", purged: 0, total: 0, results };
  for (const p of paths) {
    const r = await deletePath(env, p, branch);
    const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    results.push({ path: p, ok: r.ok && !!d.ok, error: d?.error });
    await sleep(100);
  }
  const purged = results.filter((r) => r.ok).length;
  return { ok: purged > 0, purged, total: paths.length, results };
}

// 批量上传 Markdown 文章：自动补 front matter，重名自动加序号
async function handleUploadPosts(env: Bindings, files: unknown): Promise<Response> {
  const { token, repo, branch, postsDir, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  const list = Array.isArray(files) ? (files as any[]) : [];
  if (!list.length) return json({ ok: false, error: "files required" }, 400);

  const results: Array<{ name: string; path?: string; ok: boolean; error?: string }> = [];
  for (const item of list) {
    const rawName = String(item?.name || "").trim();
    const content = String(item?.content ?? "");
    try {
      if (!rawName) throw new Error("文件名为空");
      if (!content.trim()) throw new Error("文件内容为空");
      let base = (rawName.split(/[\\/]/).pop() || "").replace(/[^\w\u4e00-\u9fa5.\- ]/g, "").trim();
      if (!base) throw new Error("文件名无效");
      if (!/\.(md|markdown)$/i.test(base)) base = base.replace(/\.(txt|text)$/i, "") + ".md";

      // 同名文件自动加序号，避免覆盖
      let filename = base;
      for (let n = 1; n <= 100; n++) {
        const exists = await fetch(
          `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(`${postsDir}/${filename}`)}`,
          { headers },
        );
        if (!exists.ok) break;
        filename = base.replace(/\.md$/i, "") + "-" + n + ".md";
      }
      const path = `${postsDir}/${filename}`;

      let body = content;
      if (!/^---\r?\n/.test(content)) {
        const title = filename.replace(/\.md$/i, "");
        const date = new Date().toISOString().slice(0, 10);
        body = `---\ntitle: '${title.replace(/'/g, "\\'")}'\ndate: ${date} 00:00:00\n---\n\n${content}\n`;
      } else if (!body.endsWith("\n")) {
        body += "\n";
      }

      const put = await fetch(
        `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(path)}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            message: `docs: add post ${filename}`,
            content: btoa(unescape(encodeURIComponent(body))),
            branch,
          }),
        },
      );
      if (!put.ok) throw new Error("github error " + put.status);
      results.push({ name: rawName, path, ok: true });
    } catch (e) {
      results.push({
        name: rawName || "(未命名)",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  const created = results.filter((r) => r.ok).length;
  const build = created > 0 ? await afterContentChange(env) : {};
  return json({ ok: created > 0, created, total: results.length, results, ...build });
}

// ---------- front matter 解析（逐行，稳健）----------
function parseFrontMatter(raw: string): {
  title: string;
  date: string;
  categories: string[];
  tags: string[];
  body: string;
} {
  let title = "";
  const categories: string[] = [];
  const tags: string[] = [];
  let date = "";
  // 剥掉 UTF-8 BOM（Windows 记事本保存的文件开头会带），否则 /^---/ 匹配失败、整个 front-matter 解析不出
  raw = raw.replace(/^\uFEFF/, "");
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    body = m[2];
    const lines = m[1].split(/\r?\n/);
    let key = ""; // categories / tags
    const cleanList = (v: string): string[] =>
      v.replace(/\[|\]|"|'/g, "").split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      const kv = line.match(/^([a-zA-Z0-9_]+)\s*:\s*(.*)$/);
      if (kv) {
        const k = kv[1].toLowerCase();
        const v = kv[2];
        if (k === "title") {
          // 去掉发布时包裹的引号（title: 'xxx' / "xxx"），并把 \' 转义还原
          const t = v.trim();
          title = t
            .replace(/^['"](.*)['"]$/, "$1")
            .replace(/\\(['"])/g, "$1");
        }
        else if (k === "date") {
          // 兼容多种写法：2026-07-18 / 2026/7/18 / 2026.07.18 / 2026年7月18日 / 引号包裹 / 带时间时区
          const t = v.trim().replace(/^['"]|['"]$/g, "");
          const d = t.match(/(\d{4})[-/.年\s]+(\d{1,2})[-/.月\s]+(\d{1,2})/);
          if (d && +d[2] >= 1 && +d[2] <= 12 && +d[3] >= 1 && +d[3] <= 31)
            date = `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`;
        } else if (k === "categories") {
          key = "categories";
          if (v.trim()) categories.push(...cleanList(v));
          else categories.length = 0;
        } else if (k === "tags") {
          key = "tags";
          if (v.trim()) tags.push(...cleanList(v));
          else tags.length = 0;
        } else if (k === "theme") {
          // 忽略
        } else {
          // 其他键（title/date 之外的历史选项），停止收集列表项
          if (!/^(categories|tags)$/.test(k)) key = "";
        }
      } else {
        // 列表项：连字符开头
        const item = line.trim();
        if (key && /^[-*]\s+/.test(item)) {
          const v = item.replace(/^[-*]\s*/, "").trim();
          if (v) (key === "categories" ? categories : tags).push(v);
        }
      }
    }
  }
  return { title, date, categories, tags, body: body.replace(/<!--\s*more\s*-->[\s\S]*$/, "").trimStart() };
}

function stripFrontMatter(content: string): string {
  const m = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (m ? m[1] : content).trimStart();
}

// ---------- 部署工作流状态 ----------
async function handleBuildStatus(env: Bindings): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    // 查询最近几次 workflow run（deploy.yml 由 push / workflow_dispatch 触发）
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/runs?per_page=5`,
      { headers },
    );
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any;
    const runs = ((data.workflow_runs || []) as any[]).map((r: any) => ({
      id: r.id,
      event: r.event || "",
      status: r.status,
      conclusion: r.conclusion || "",
      created_at: r.created_at || "",
      html_url: r.html_url || "",
    }));
    const latest = runs[0] || null;
    if (!latest) return json({ ok: true, running: false, status: "none", conclusion: "none", runs: [] });
    const isActive = (s: string) => s === "in_progress" || s === "queued" || s === "pending" || s === "waiting";
    // 只要最近几次里还有正在运行的，就视为整体运行中
    const running = runs.some((r: any) => isActive(r.status));
    return json({
      ok: true,
      running,
      status: latest.status,
      conclusion: latest.conclusion || "",
      name: data.workflow_runs?.[0]?.name || data.workflow_runs?.[0]?.display_title || "",
      started: latest.created_at || "",
      html_url: latest.html_url || "",
      latest,
      runs,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 手动触发部署工作流（改完文章/文件后一键重建站点）
async function handleTriggerBuild(env: Bindings): Promise<Response> {
  const { token, repo, branch, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/dispatches`,
      { method: "POST", headers, body: JSON.stringify({ ref: branch }) },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ ok: false, error: "触发失败 github error " + res.status, detail }, 502);
    }
    return json({ ok: true, message: "已触发部署工作流" });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 部署历史记录（最近 20 次）
async function handleBuildHistory(env: Bindings): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/runs?per_page=20`,
      { headers },
    );
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any;
    const runs = ((data.workflow_runs || []) as any[]).map((r: any) => ({
      id: r.id,
      name: r.display_title || r.name || "",
      status: r.status,
      conclusion: r.conclusion || "",
      created_at: r.created_at || "",
      head_sha: (r.head_sha || "").slice(0, 7),
      html_url: r.html_url || "",
    }));
    return json({ ok: true, runs });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 部署工作流日志（Cloudflare 代理）：
// - 运行已结束：拉取 GitHub 日志 zip 并解压为纯文本（完整日志）
// - 运行进行中：zip 尚未生成，改为逐个 job 拉取 /actions/jobs/{id}/logs 纯文本（实时已产出部分），
//   并附每个 job 的步骤状态清单，运行中也能看到日志（解决「日志不全/拿不到」）
// GitHub 的 /actions/runs/{id}/logs 会 302 到签名地址（zip），fetch 自动跟随；用 fflate 解压。
async function handleBuildLog(env: Bindings, runId: string, workflow?: string): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  const wf = String(workflow || "").trim() || "deploy.yml";
  const ACTIVE = new Set(["in_progress", "queued", "pending", "waiting", "requested"]);
  try {
    let id = String(runId || "").trim();
    let runStatus = "";
    let runConclusion = "";
    let runName = "";
    if (!id) {
      const lr = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/runs?per_page=1`,
        { headers },
      );
      if (lr.status === 404) return json({ ok: false, error: `找不到工作流 ${wf}` }, 404);
      if (!lr.ok) return json({ ok: false, error: "github error " + lr.status }, 502);
      const ld = (await lr.json()) as any;
      const latest = ld.workflow_runs?.[0];
      id = String(latest?.id || "");
      runStatus = String(latest?.status || "");
      runConclusion = String(latest?.conclusion || "");
      if (!id) return json({ ok: false, error: `工作流 ${wf} 还没有运行记录` }, 404);
    } else {
      // 给定 runId 时补一次运行信息（状态/名称），用于判断是否运行中
      const rd = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${id}`, { headers }).catch(() => null);
      if (rd && rd.ok) {
        const rm = (await rd.json()) as any;
        runStatus = String(rm?.status || "");
        runConclusion = String(rm?.conclusion || "");
        runName = String(rm?.display_title || rm?.name || "");
      }
    }
    const running = ACTIVE.has(runStatus);
    if (running) {
      const live = await ghRunJobLogs(env, repo, headers, id, true);
      if (live) return json({ ok: true, id, running: true, live: true, name: runName, status: runStatus, text: live });
      return json(
        {
          ok: false,
          id,
          status: runStatus || "in_progress",
          error: "日志尚不可用：该次运行还在排队/尚未产出日志。请 wait_workflow 或稍等几秒再试。",
        },
        409,
      );
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${id}/logs`, { headers });
    if (!res.ok) {
      // 运行尚未结束时 GitHub 不提供日志（返回 404）；结束但 zip 拉取失败时兜底用 job 日志
      if (res.status === 404 || res.status === 410) {
        const live = await ghRunJobLogs(env, repo, headers, id, false);
        if (live) return json({ ok: true, id, running: false, live: true, name: runName, status: runStatus, text: live });
        return json(
          {
            ok: false,
            id,
            status: runStatus || "in_progress",
            error: "日志尚不可用：该次运行可能仍在进行中（日志需运行结束后才生成）。请 wait_workflow 或稍等几秒后再试。",
          },
          409,
        );
      }
      const live = await ghRunJobLogs(env, repo, headers, id, false);
      if (live) return json({ ok: true, id, running: false, live: true, name: runName, status: runStatus, text: live });
      const detail = await res.text().catch(() => "");
      return json({ ok: false, error: "获取日志失败 github error " + res.status, detail: detail.slice(0, 300) }, 502);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    let text = "";
    try {
      const files = unzipSync(buf);
      const names = Object.keys(files).sort();
      const parts: string[] = [];
      for (const name of names) {
        parts.push("===== " + name + " =====\n" + new TextDecoder().decode(files[name]));
      }
      text = parts.join("\n\n");
    } catch {
      // 极少数情况下不是 zip，直接按文本解码
      text = new TextDecoder().decode(buf);
    }
    const max = 200000;
    const truncated = text.length > max;
    if (truncated) text = "...(日志过长，已截断，仅保留末尾)\n" + text.slice(-max);
    return json({ ok: true, id, running: false, name: runName, status: runStatus, conclusion: runConclusion, truncated, text });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 拉取一次运行里所有 job 的实时日志（/actions/jobs/{id}/logs 返回纯文本，运行中也可用）。
// 输出：每个 job 一段（步骤状态清单 + 日志正文）；running=false 时仅作兜底（zip 拉取失败时用）。
async function ghRunJobLogs(
  env: Bindings,
  repo: string,
  headers: Record<string, string>,
  runId: string,
  running: boolean,
): Promise<string | null> {
  try {
    const jr = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=30`, { headers });
    if (!jr.ok) return null;
    const jd = (await jr.json()) as any;
    const jobs = ((jd.jobs || []) as any[]).slice(0, 8);
    if (!jobs.length) return null;
    const dec = new TextDecoder();
    const parts: string[] = [];
    for (const job of jobs) {
      const steps = ((job.steps || []) as any[])
        .map((s: any) => "  [" + (s.conclusion || s.status || "?") + "] " + (s.name || ""))
        .join("\n");
      let body = "";
      const lr = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`, { headers });
      if (lr.ok) {
        const t = dec.decode(await lr.arrayBuffer());
        const max = 100000;
        body = t.length > max ? "...(该 job 日志过长，已截断，仅保留末尾)\n" + t.slice(-max) : t;
      } else if (running) {
        body = "（该 job 还没有产出日志）";
      } else {
        body = "（获取该 job 日志失败 github error " + lr.status + "）";
      }
      parts.push(
        "===== [job] " + (job.name || job.id) + " · " + (job.status || "?") + (job.conclusion ? "/" + job.conclusion : "") +
          " =====\n" + (steps ? steps + "\n\n" : "") + body,
      );
    }
    return parts.join("\n\n");
  } catch {
    return null;
  }
}

// ---------- 通用工作流管理（列出 / 运行 / 取消 / 运行记录 / 克隆仓库）----------
const GH_ACTIVE_STATES = ["in_progress", "queued", "pending", "waiting", "requested"];

// 列出仓库中所有工作流（名称、文件名、状态）
async function handleListWorkflows(env: Bindings): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows?per_page=100`, { headers });
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any;
    const workflows = ((data.workflows || []) as any[]).map((w: any) => ({
      id: w.id,
      name: w.name || "",
      file: w.path ? String(w.path).split("/").pop() : "",
      path: w.path || "",
      state: w.state || "",
    }));
    return json({ ok: true, workflows });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 查询工作流运行记录（workflow 为文件名，省略则查全部）
async function handleWorkflowRuns(env: Bindings, workflow: string, limit = 20): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  const wf = String(workflow || "").trim();
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  try {
    const url = wf
      ? `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/runs?per_page=${n}`
      : `https://api.github.com/repos/${repo}/actions/runs?per_page=${n}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any;
    const runs = ((data.workflow_runs || []) as any[]).map((r: any) => ({
      id: r.id,
      name: r.name || r.display_title || "",
      workflow: r.path ? String(r.path).split("/").pop() : "",
      status: r.status,
      conclusion: r.conclusion || "",
      created_at: r.created_at || "",
      head_sha: (r.head_sha || "").slice(0, 7),
      html_url: r.html_url || "",
    }));
    const running = runs.some((r: any) => GH_ACTIVE_STATES.indexOf(r.status) >= 0);
    return json({ ok: true, workflow: wf, running, latest: runs[0] || null, runs });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 触发指定工作流（workflow_id 支持文件名 / 名称）
async function handleTriggerWorkflow(env: Bindings, body: any): Promise<Response> {
  const { token, repo, branch, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  let wid = String(body.workflow_id || "").trim();
  if (!wid) return json({ ok: false, error: "workflow_id required" }, 400);
  const ref = String(body.ref || "").trim() || branch;
  const inputs = body.inputs && typeof body.inputs === "object" ? body.inputs : undefined;
  try {
    // 传名称时先列出工作流匹配出文件名
    if (!/\.ya?ml$/i.test(wid) && !/^\d+$/.test(wid)) {
      const lr = await fetch(`https://api.github.com/repos/${repo}/actions/workflows?per_page=100`, { headers });
      if (lr.ok) {
        const d = (await lr.json()) as any;
        const w = ((d.workflows || []) as any[]).find((x: any) => x.name === wid);
        if (w && w.path) wid = String(w.path).split("/").pop() || wid;
      }
    }
    const payload: any = { ref };
    if (inputs) payload.inputs = inputs;
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(wid)}/dispatches`,
      { method: "POST", headers, body: JSON.stringify(payload) },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ ok: false, error: "触发失败 github error " + res.status, detail: detail.slice(0, 300) }, 502);
    }
    return json({ ok: true, workflow: wid, message: "已触发工作流 " + wid });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 取消运行中的工作流（run_id 省略则取消最近一次运行中的）
async function handleCancelWorkflow(env: Bindings, body: any): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    let id = String(body.run_id || "").trim();
    if (!id) {
      const lr = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=20`, { headers });
      if (!lr.ok) return json({ ok: false, error: "github error " + lr.status }, 502);
      const ld = (await lr.json()) as any;
      const active = ((ld.workflow_runs || []) as any[]).find((r: any) => GH_ACTIVE_STATES.indexOf(r.status) >= 0);
      if (!active) return json({ ok: false, error: "当前没有正在运行的工作流" }, 404);
      id = String(active.id);
    }
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${id}/cancel`, { method: "POST", headers });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ ok: false, error: "取消失败 github error " + res.status, detail: detail.slice(0, 300) }, 502);
    }
    return json({ ok: true, runId: id, message: "已取消工作流运行 #" + id });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 克隆外部仓库到当前仓库目录（触发 clone-repo.yml）
async function handleCloneRepo(env: Bindings, body: any): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  const useBranch = String(body.branch || "").trim() || ghConfig(env).branch;
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  const repoUrl = String(body.repo_url || "").trim();
  const targetDir = String(body.target_dir || "").trim().replace(/^\/+|\/+$/g, "");
  const srcRef = String(body.ref || "").trim();
  if (!repoUrl) return json({ ok: false, error: "repo_url required" }, 400);
  if (!targetDir) return json({ ok: false, error: "target_dir required" }, 400);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/clone-repo.yml/dispatches`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: useBranch,
          inputs: { repo_url: repoUrl, target_dir: targetDir, branch: useBranch, ref: srcRef, keep_git: "false" },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ ok: false, error: "触发克隆工作流失败 github error " + res.status, detail: detail.slice(0, 300) }, 502);
    }
    return json({
      ok: true,
      workflow: true,
      running: true,
      message: "已触发克隆工作流，正在把 " + repoUrl + " 克隆到 " + targetDir + "（约 10 秒完成）",
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ---------- 主题管理 ----------
// 列出 themes 目录下的主题：子文件夹含 _config.yml 或 layout/ 目录才算有效主题；
// 同时读根目录 _config.yml 的 theme 字段作为当前主题
async function handleListThemes(env: Bindings): Promise<Response> {
  const { token, repo, headers, branch } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    let current = "";
    const cfg = await fetch(
      `https://api.github.com/repos/${repo}/contents/_config.yml?ref=${encodeURIComponent(branch)}`,
      { headers },
    );
    if (cfg.ok) {
      const d = (await cfg.json()) as any;
      const raw = decodeURIComponent(escape(atob(d.content || "")));
      const m = /^theme:\s*["']?([^\s"']+)["']?\s*$/m.exec(raw);
      if (m) current = m[1];
    }
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/themes?ref=${encodeURIComponent(branch)}`,
      { headers },
    );
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any[];
    const dirs = (data || []).filter((f) => f.type === "dir").map((f) => String(f.name));
    // 逐个校验目录是否为有效主题（并行请求）
    const themes = await Promise.all(
      dirs.map(async (name) => {
        let valid = false;
        try {
          const enc = encodeURIComponent(name);
          const a = await fetch(
            `https://api.github.com/repos/${repo}/contents/themes/${enc}/_config.yml?ref=${encodeURIComponent(branch)}`,
            { headers },
          );
          if (a.ok) valid = true;
          else {
            const b = await fetch(
              `https://api.github.com/repos/${repo}/contents/themes/${enc}/layout?ref=${encodeURIComponent(branch)}`,
              { headers },
            );
            valid = b.ok;
          }
        } catch {
          /* ignore */
        }
        return { name, valid, current: name === current };
      }),
    );
    return json({ ok: true, current, themes });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 切换主题：修改根目录 _config.yml 的 theme 字段，并触发部署工作流重建站点
async function handleSwitchTheme(env: Bindings, body: any): Promise<Response> {
  const { token, repo, headers, branch } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  const name = String(body.name || "").trim().replace(/^\/+|\/+$/g, "");
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\"))
    return json({ ok: false, error: "name required" }, 400);
  try {
    const cfg = await fetch(
      `https://api.github.com/repos/${repo}/contents/_config.yml?ref=${encodeURIComponent(branch)}`,
      { headers },
    );
    if (!cfg.ok) return json({ ok: false, error: "读取 _config.yml 失败 github error " + cfg.status }, 502);
    const d = (await cfg.json()) as any;
    const raw = decodeURIComponent(escape(atob(d.content || "")));
    const re = /^theme:\s*.*$/m;
    const next = re.test(raw)
      ? raw.replace(re, "theme: " + name)
      : raw.replace(/\s*$/, "") + "\ntheme: " + name + "\n";
    const saved = await handleSaveFile(env, { path: "_config.yml", content: next, branch });
    const savedData = (await saved.json().catch(() => ({}))) as any;
    if (!savedData.ok) return json({ ok: false, error: savedData.error || "保存 _config.yml 失败" }, 502);
    // 只触发「更新 GitHub Pages」工作流重建站点（不跑完整部署）
    const disp = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/update-gh.yml/dispatches`,
      { method: "POST", headers, body: JSON.stringify({ ref: branch }) },
    ).catch(() => null);
    return json({
      ok: true,
      theme: name,
      build_triggered: !!disp && disp.ok,
      message: "已切换主题为 " + name + "，正在更新 GitHub Pages",
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// ---------- 文件管理 ----------
function ghPath(path: string): string {
  return String(path || "").replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function handleListBranches(env: Bindings): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/branches?per_page=100`, { headers });
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any[];
    const branches = (data || []).map((b: any) => b.name).filter(Boolean);
    const current = ghConfig(env).branch;
    return json({ ok: true, branches, current });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleListFiles(env: Bindings, path: string, branch?: string): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  const useBranch = branch || ghConfig(env).branch;
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const clean = String(path || "").replace(/^\/+|\/+$/g, "");
    const url = clean
      ? `https://api.github.com/repos/${repo}/contents/${ghPath(clean)}?ref=${encodeURIComponent(useBranch)}`
      : `https://api.github.com/repos/${repo}/contents/?ref=${encodeURIComponent(useBranch)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 404) return json({ ok: false, error: "目录不存在" }, 404);
      return json({ ok: false, error: "github error " + res.status }, 502);
    }
    const data = (await res.json()) as any[];
    const items = (data || []).map((f: any) => ({
      name: f.name,
      path: f.path,
      type: f.type,
      size: f.size || 0,
    }));
    return json({ ok: true, path: clean, branch: useBranch, items });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleGetFile(env: Bindings, path: string, branch?: string): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  const useBranch = branch || ghConfig(env).branch;
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/${ghPath(path)}?ref=${encodeURIComponent(useBranch)}`, { headers });
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const d = (await res.json()) as any;
    if (d.type !== "file") return json({ ok: false, error: "不是文件" }, 400);
    // 二进制文件（图片等）仅返回元信息
    const raw = decodeURIComponent(escape(atob(d.content)));
    const isBinary = /[\x00-\x08\x0e-\x1f]/.test(raw.slice(0, 4096));
    return json({
      ok: true,
      path: d.path,
      sha: d.sha,
      size: d.size,
      content: isBinary ? "" : raw,
      binary: isBinary,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleSaveFile(env: Bindings, body: any): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  const useBranch = String(body.branch || "").trim() || ghConfig(env).branch;
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  const path = String(body.path || "").trim();
  const content = String(body.content ?? "");
  if (!path) return json({ ok: false, error: "path required" }, 400);
  try {
    const rawApi = `https://api.github.com/repos/${repo}/contents/${ghPath(path)}`;
    let sha: string | undefined;
    const exist = await fetch(`${rawApi}?ref=${encodeURIComponent(useBranch)}`, { headers });
    if (exist.ok) sha = ((await exist.json()) as any).sha;
    const payload: any = {
      message: `docs: update ${path}`,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: useBranch,
    };
    if (sha) payload.sha = sha;
    const res = await fetch(rawApi, { method: "PUT", headers, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ ok: false, error: "github error: " + ((data as any).message || res.status) }, 502);
    return json({ ok: true, path, branch: useBranch, message: "已保存" });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 递归删除文件/目录（GitHub 目录需逐个删文件）
async function deletePath(env: Bindings, path: string, branch?: string): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  const useBranch = branch || ghConfig(env).branch;
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const rawApi = `https://api.github.com/repos/${repo}/contents/${ghPath(path)}`;
    const exist = await fetch(`${rawApi}?ref=${encodeURIComponent(useBranch)}`, { headers });
    if (!exist.ok) return json({ ok: false, error: "未找到 " + path }, 404);
    const data = (await exist.json()) as any;
    if (Array.isArray(data)) {
      // 目录：用 Git 数据 API 一次提交整体删除，避免大目录逐文件请求触顶
      return deleteDirByTree(env, path, useBranch);
    }
    const res = await fetch(rawApi, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ sha: data.sha, message: `docs: delete ${path}`, branch: useBranch }),
    });
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    return json({ ok: true, message: "已删除 " + path });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 上传文件（multipart：path=目标目录, branch=分支, files=多个文件）
async function handleUploadFile(env: Bindings, req: Request): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const form = await req.formData();
    const dir = String((form.get("path") || "") as string).replace(/^\/+|\/+$/g, "");
    const useBranch = String((form.get("branch") || "") as string).trim() || ghConfig(env).branch;
    const files = (form.getAll("files") as any[]).filter((f) => f && typeof f === "object") as File[];
    if (!files.length) return json({ ok: false, error: "没有文件" }, 400);
    const saved: string[] = [];
    for (const f of files) {
      const name = f.name.split("/").pop() || "";
      const target = dir ? `${dir}/${name}` : name;
      const buf = new Uint8Array(await f.arrayBuffer());
      const content = bytesToBase64(buf);
      const rawApi = `https://api.github.com/repos/${repo}/contents/${ghPath(target)}`;
      let sha: string | undefined;
      const exist = await fetch(`${rawApi}?ref=${encodeURIComponent(useBranch)}`, { headers });
      if (exist.ok) sha = ((await exist.json()) as any).sha;
      const payload: any = { message: `docs: upload ${target}`, content, branch: useBranch };
      if (sha) payload.sha = sha;
      const res = await fetch(rawApi, { method: "PUT", headers, body: JSON.stringify(payload) });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        return json({ ok: false, error: `上传 ${name} 失败: ${(d as any).message || res.status}` }, 502);
      }
      saved.push(target);
    }
    return json({ ok: true, saved, message: `已上传 ${saved.length} 个文件` });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 解压 zip（multipart：path=目标目录, branch=分支, zip=zip 文件）
async function handleUnzipFile(env: Bindings, req: Request): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const form = await req.formData();
    const dir = String((form.get("path") || "") as string).replace(/^\/+|\/+$/g, "");
    const useBranch = String((form.get("branch") || "") as string).trim() || ghConfig(env).branch;
    const zipFile = form.get("zip") as File | null;
    if (!zipFile) return json({ ok: false, error: "没有 zip 文件" }, 400);
    const buf = new Uint8Array(await zipFile.arrayBuffer());
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(buf);
    } catch {
      return json({ ok: false, error: "zip 解析失败，请确认是有效的 zip 文件" }, 400);
    }
    const saved: string[] = [];
    const failed: string[] = [];
    const names = Object.keys(entries || {}).filter((n) => n && !n.endsWith("/"));
    for (const name of names) {
      const target = dir ? `${dir}/${name}` : name;
      const rawApi = `https://api.github.com/repos/${repo}/contents/${ghPath(target)}`;
      let sha: string | undefined;
      const exist = await fetch(`${rawApi}?ref=${encodeURIComponent(useBranch)}`, { headers });
      if (exist.ok) sha = ((await exist.json()) as any).sha;
      const payload: any = { message: `docs: unzip ${target}`, content: bytesToBase64(entries[name]), branch: useBranch };
      if (sha) payload.sha = sha;
      const res = await fetch(rawApi, { method: "PUT", headers, body: JSON.stringify(payload) });
      if (!res.ok) { failed.push(name); continue; }
      saved.push(target);
    }
    return json({
      ok: true,
      saved,
      failed,
      message: `解压完成：成功 ${saved.length} 个` + (failed.length ? `，失败 ${failed.length} 个（${failed.slice(0, 3).join("、")}）` : ""),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 小于该大小：Cloudflare 直接解压；超过：交给 GitHub Actions 工作流
const UNZIP_INLINE_LIMIT = 50 * 1024 * 1024;
// 从网络下载并写进仓库的单个文件上限（受 Worker 内存与 base64 开销限制）
const DOWNLOAD_MAX_BYTES = 45 * 1024 * 1024;

// 触发 GitHub 解压工作流（大文件走这里）
async function triggerUnzipWorkflow(env: Bindings, zipPath: string, branch: string, dir: string): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/unzip.yml/dispatches`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ref: branch,
          inputs: { zip_path: zipPath, branch, target_dir: dir || "", delete_zip: "true" },
        }),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return json({ ok: false, error: "触发解压工作流失败 github error " + res.status, detail }, 502);
    }
    return json({
      ok: true,
      workflow: true,
      running: true,
      message: "文件较大，已触发 GitHub 解压工作流，正在解压（10 秒左右完成）",
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 解压仓库内的已在目录里的 zip 文件到当前目录（不要求再上传）
// <50MB 由 Cloudflare 即时解压；>50MB 触发 GitHub 工作流异步解压
async function handleUnzipByPath(env: Bindings, body: any): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  const useBranch = String(body.branch || "").trim() || ghConfig(env).branch;
  const zipPath = String(body.path || "").trim();
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  if (!zipPath) return json({ ok: false, error: "path required" }, 400);
  // 目标目录 = zip 所在目录
  const dir = zipPath.split("/").filter(Boolean).slice(0, -1).join("/");
  try {
    // 1) 读取 zip 文件元信息（拿到大小，决定解压方式）
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${ghPath(zipPath)}?ref=${encodeURIComponent(useBranch)}`;
    const metaRes = await fetch(apiUrl, { headers });
    if (!metaRes.ok) return json({ ok: false, error: "读取 zip 失败 " + metaRes.status }, 502);
    const meta = (await metaRes.json()) as any;
    if (meta.type !== "file") return json({ ok: false, error: "不是文件" }, 400);
    const size = Number(meta.size || 0);
    // 2) 大文件：触发 GitHub 工作流
    if (size > UNZIP_INLINE_LIMIT) {
      return await triggerUnzipWorkflow(env, zipPath, useBranch, dir);
    }
    // 3) 小文件：Cloudflare 直接读取原始字节并解压
    //    注意：>1MB 的文件 contents API 默认不返回 content，需用 raw accept 头取原始内容
    const rawRes = await fetch(apiUrl, { headers: { ...headers, accept: "application/vnd.github.raw" } });
    if (!rawRes.ok) return json({ ok: false, error: "下载 zip 失败 " + rawRes.status }, 502);
    const bytes = new Uint8Array(await rawRes.arrayBuffer());
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      return json({ ok: false, error: "zip 解析失败，请确认是有效的 zip 文件" }, 400);
    }
    const saved: string[] = [];
    const failed: string[] = [];
    const names = Object.keys(entries || {}).filter((n) => n && !n.endsWith("/"));
    for (const name of names) {
      const target = dir ? `${dir}/${name}` : name;
      const rawApi = `https://api.github.com/repos/${repo}/contents/${ghPath(target)}`;
      let sha: string | undefined;
      const exist = await fetch(`${rawApi}?ref=${encodeURIComponent(useBranch)}`, { headers });
      if (exist.ok) sha = ((await exist.json()) as any).sha;
      const payload: any = { message: `docs: unzip ${target}`, content: bytesToBase64(entries[name]), branch: useBranch };
      if (sha) payload.sha = sha;
      const res = await fetch(rawApi, { method: "PUT", headers, body: JSON.stringify(payload) });
      if (!res.ok) { failed.push(name); continue; }
      saved.push(target);
    }
    return json({
      ok: true,
      saved,
      failed,
      size,
      message: `解压完成：成功 ${saved.length} 个` + (failed.length ? `，失败 ${failed.length} 个（${failed.slice(0, 3).join("、")}）` : ""),
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 大文件解压工作流运行状态
async function handleUnzipStatus(env: Bindings): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/unzip.yml/runs?per_page=5`,
      { headers },
    );
    if (!res.ok) return json({ ok: false, error: "github error " + res.status }, 502);
    const data = (await res.json()) as any;
    const isActive = (s: string) => s === "in_progress" || s === "queued" || s === "pending" || s === "waiting";
    const runs = ((data.workflow_runs || []) as any[]).map((r: any) => ({
      id: r.id,
      status: r.status,
      conclusion: r.conclusion || "",
      created_at: r.created_at || "",
      html_url: r.html_url || "",
    }));
    const running = runs.some((r: any) => isActive(r.status));
    return json({ ok: true, running, latest: runs[0] || null, runs });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 从网络下载文件并保存进仓库
async function handleDownloadFile(env: Bindings, body: any): Promise<Response> {
  const { token, repo, headers } = ghConfig(env);
  const useBranch = String(body.branch || "").trim() || ghConfig(env).branch;
  if (!token) return json({ ok: false, error: "GH_TOKEN not configured" }, 500);
  let url = String(body.url || "").trim();
  const target = String(body.path || "").trim();
  if (!url) return json({ ok: false, error: "url required" }, 400);
  try {
    // GitHub 仓库 owner/repo 简写或仓库主页地址 → 转为源码 zip 下载地址
    const gh = url.match(/^([\w.-]+)\/([\w.-]+)$/) || url.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (gh) {
      const owner = gh[1], name = gh[2];
      let defBranch = "main";
      const info = await fetch(`https://api.github.com/repos/${owner}/${name}`, { headers });
      if (info.ok) defBranch = ((await info.json()) as any).default_branch || "main";
      url = `https://codeload.github.com/${owner}/${name}/zip/refs/heads/${defBranch}`;
    }
    if (!/^https?:\/\//i.test(url)) return json({ ok: false, error: "url 必须以 http:// 或 https:// 开头" }, 400);
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return json({ ok: false, error: `下载失败 HTTP ${res.status}` }, 502);
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > DOWNLOAD_MAX_BYTES)
      return json({ ok: false, error: `文件过大（${(len / 1048576).toFixed(1)}MB），超过 ${DOWNLOAD_MAX_BYTES / 1048576}MB 上限` }, 400);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length) return json({ ok: false, error: "下载内容为空" }, 400);
    if (buf.length > DOWNLOAD_MAX_BYTES)
      return json({ ok: false, error: `文件过大（${(buf.length / 1048576).toFixed(1)}MB），超过 ${DOWNLOAD_MAX_BYTES / 1048576}MB 上限` }, 400);
    // 目标路径：以 / 结尾或省略视为目录，自动使用文件名；否则视为完整文件路径
    const name = String(body.name || "").trim() || guessDownloadName(url, res.headers);
    let full: string;
    if (!target || /\/$/.test(target)) full = (target.replace(/\/+$/, "") ? target.replace(/\/+$/, "") + "/" : "") + name;
    else full = target;
    const rawApi = `https://api.github.com/repos/${repo}/contents/${ghPath(full)}`;
    let sha: string | undefined;
    const exist = await fetch(`${rawApi}?ref=${encodeURIComponent(useBranch)}`, { headers });
    if (exist.ok) sha = ((await exist.json()) as any).sha;
    const payload: any = { message: `docs: download ${full}`, content: bytesToBase64(buf), branch: useBranch };
    if (sha) payload.sha = sha;
    const put = await fetch(rawApi, { method: "PUT", headers, body: JSON.stringify(payload) });
    const putData = await put.json().catch(() => ({}));
    if (!put.ok) return json({ ok: false, error: "保存失败：" + ((putData as any).message || put.status) }, 502);
    return json({ ok: true, path: full, size: buf.length, message: `已下载并保存到 ${full}（${(buf.length / 1024).toFixed(1)} KB）` });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

// 从响应头/URL 推断文件名
function guessDownloadName(url: string, headers: Headers): string {
  const cd = headers.get("content-disposition") || "";
  const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (m) {
    try { return decodeURIComponent(m[1].replace(/"/g, "").trim()); } catch { /* ignore */ }
  }
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop() || "";
    if (seg) return decodeURIComponent(seg);
  } catch { /* ignore */ }
  return "download.bin";
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export default app;