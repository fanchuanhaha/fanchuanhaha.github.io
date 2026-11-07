import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, Variables } from "./env.js";
import { auth } from "./middleware/auth.js";
import { articleRoutes } from "./router/article.js";
import { commentRoutes } from "./router/comment.js";
import { dbRoutes } from "./router/db.js";
import { oauthRoutes } from "./router/oauth.js";
import { settingsRoutes } from "./router/settings.js";
import { tokenRoutes } from "./router/token.js";
import { userRoutes } from "./router/user.js";
import { getSetting } from "./router/settings.js";
import { originAllowed } from "./utils/cors.js";
import { getAdminPage } from "./ui/admin-panel.js";
import { getCustomSettingsPage } from "./ui/custom-admin.js";
import { getWalinePage } from "./ui/waline-page.js";

/**
 * Waline 评论子应用，挂载到主应用 /waline/* 下。
 * 通过 app.route("/waline", walineApp) 复用，API 路径自动变为 /waline/api/comment 等。
 */
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Resolve the effective CORS allowlist on every request (env SECURE_DOMAINS merged with DB setting).
app.use("*", async (c, next) => {
	const parts: string[] = [];
	if (c.env.SECURE_DOMAINS) parts.push(c.env.SECURE_DOMAINS);
	try {
		const uiSetting = await getSetting(c.env.DB, "secure_domains");
		if (uiSetting) parts.push(uiSetting);
	} catch (err) {
		// wl_Settings may not exist yet (fresh DB) — env-only allowlist still works.
		console.error(
			"[CORS] failed to read secure_domains setting:",
			err instanceof Error ? err.message : String(err),
		);
	}
	c.set("secureDomainsResolved", parts.join(","));
	await next();
});

// CORS
app.use(
	"*",
	cors({
		origin: (origin, c) => {
			const allowlist = c.get("secureDomainsResolved");
			if (!allowlist) return origin;
			return originAllowed(origin, allowlist) ? origin : "";
		},
		allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		exposeHeaders: ["Content-Length", "x-waline-version"],
		credentials: true,
	}),
);

// Waline version header (used by admin panel for export __version field)
app.use("*", async (c, next) => {
	await next();
	c.header("x-waline-version", "1.1.0");
});

// Auth middleware - parse JWT on all routes (non-blocking, skips if no token)
app.use("*", auth);

// Global error handler (catches malformed JSON bodies, etc.)
app.onError((err, c) => {
	if (err instanceof SyntaxError) {
		return c.json({ errno: 1, errmsg: "Invalid JSON body" }, 400);
	}
	console.error("[Unhandled Error]", err?.message || err);
	return c.json({ errno: 1, errmsg: "Internal Server Error" }, 500);
});

// Routes
app.route("/api/comment", commentRoutes);
app.route("/api/article", articleRoutes);
app.route("/api/user", userRoutes);
app.route("/api/token", tokenRoutes);
app.route("/api/settings", settingsRoutes);
app.route("/api/oauth", oauthRoutes);
// 兼容直接访问 ${serverURL}/oauth 的老客户端（新版客户端走 /ui/login → /api/oauth）
app.route("/oauth", oauthRoutes);
app.route("/api/db", dbRoutes);

// Worker custom settings page — auth is enforced client-side so direct URL access works
app.get("/ui/worker-setting", async (c) => {
	return c.html(getCustomSettingsPage(c.req.url));
});

// Admin panel UI (original @waline/admin from CDN) — reachable at /waline/ui
app.get("/ui", async (c) => {
	return c.html(await getAdminPage(c.env, c.req.url));
});
app.get("/ui/*", async (c) => {
	return c.html(await getAdminPage(c.env, c.req.url));
});

// Waline frontend UI (root page) — reachable at /waline
app.get("/", (c) => {
	return c.html(getWalinePage());
});

export default app;