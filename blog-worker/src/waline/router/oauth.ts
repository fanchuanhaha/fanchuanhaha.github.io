import { Hono } from "hono";
import type { Env, Variables } from "../env.js";
import { signJwt, verifyJwt } from "../middleware/auth.js";

export const oauthRoutes = new Hono<{
	Bindings: Env;
	Variables: Variables;
}>();

const DEFAULT_OAUTH_URL = "https://oauth.lithub.cc";

/**
 * GET /api/oauth - OAuth login flow (matching original Waline implementation)
 *
 * Step 1 (no code): Redirect user to external OAuth provider
 * Step 2 (with code): Exchange code for user info, create/link user, issue JWT
 */
oauthRoutes.get("/", async (c) => {
	const type = c.req.query("type");
	const code = c.req.query("code");
	const state = c.req.query("state") || "";
	const oauthUrl = c.env.OAUTH_URL || DEFAULT_OAUTH_URL;

	// 当前 oauth 端点的真实路径（可能是 /waline/api/oauth 或 /waline/oauth），
	// 回调地址与默认跳转都必须基于它，否则会丢挂载前缀落到站点首页。
	const reqUrl = new URL(c.req.url);
	const oauthPath = reqUrl.pathname.replace(/\/+$/, "") || "/";
	const basePath = oauthPath.replace(/\/api\/oauth$/, "").replace(/\/oauth$/, "");
	const redirect = sanitizeRedirect(
		c.req.query("redirect"),
		reqUrl.origin,
		`${basePath}/ui`,
	);

	if (!type) {
		return c.json({ errno: 1, errmsg: "type is required" }, 400);
	}

	// Step 1: No code → redirect to OAuth provider
	if (!code) {
		// Build callback URL (back to this endpoint with redirect & type preserved)
		const callbackUrl = `${reqUrl.origin}${oauthPath}?redirect=${encodeURIComponent(redirect)}&type=${encodeURIComponent(type)}`;

		// Match original: ${oauthUrl}/${type}?redirect=${callbackUrl}&state=${token}
		// state passes through the user's JWT token (for account linking from profile page)
		const loginUrl = `${oauthUrl}/${type}?redirect=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(state)}`;
		return c.redirect(loginUrl);
	}

	// Step 2: Have code → exchange for user info
	try {
		// Match original: ${oauthUrl}/${type}?code=${code}&state=${state}
		const params = new URLSearchParams({ code });
		if (state) params.set("state", state);

		const userInfoUrl = `${oauthUrl}/${type}?${params.toString()}`;
		const resp = await fetch(userInfoUrl, {
			headers: { "User-Agent": "@waline" },
		});

		if (!resp.ok) {
			return c.redirect(withQuery(redirect, { error: "oauth_failed" }));
		}

		const oauthUser = (await resp.json()) as Record<string, any>;
		const socialId = String(
			oauthUser.id || oauthUser.login || oauthUser.name || "",
		);
		const socialName = String(
			oauthUser.name || oauthUser.login || oauthUser.display_name || "",
		);
		const socialEmail = String(oauthUser.email || "");
		const socialAvatar = String(oauthUser.avatar_url || oauthUser.avatar || "");
		const socialUrl = String(
			oauthUser.html_url || oauthUser.url || oauthUser.blog || "",
		);

		if (!socialId) {
			return c.redirect(withQuery(redirect, { error: "oauth_no_id" }));
		}

		const socialField = getSocialField(type);
		const jwtSecret = c.env.JWT_SECRET;

		// Account-linking flow: state carries the logged-in user's JWT
		if (state && jwtSecret && socialField) {
			try {
				const payload = await verifyJwt(state, jwtSecret);
				if (payload?.id) {
					const linkTarget = await c.env.DB.prepare(
						"SELECT * FROM wl_Users WHERE id = ?",
					)
						.bind(payload.id)
						.first();

					if (linkTarget) {
						// Check if this social ID is already bound to a different account
						const conflict = await c.env.DB.prepare(
							`SELECT id FROM wl_Users WHERE ${socialField} = ? AND id != ?`,
						)
							.bind(socialId, payload.id)
							.first();

						if (conflict) {
							return c.redirect(
								withQuery(redirect, { error: "oauth_already_bound" }),
							);
						}

						await c.env.DB.prepare(
							`UPDATE wl_Users SET ${socialField} = ?, updatedAt = datetime('now') WHERE id = ?`,
						)
							.bind(socialId, payload.id)
							.run();

						const token = await signJwt({ id: payload.id }, jwtSecret);
						return c.redirect(withQuery(redirect, { token }));
					}
				}
			} catch {
				// state is not a valid JWT — fall through to normal login flow
			}
		}

		// Normal OAuth login: find existing user by social link or email
		// Try to find existing user by social link
		let user: Record<string, unknown> | null = null;

		if (socialField) {
			user = await c.env.DB.prepare(
				`SELECT * FROM wl_Users WHERE ${socialField} = ?`,
			)
				.bind(socialId)
				.first();
		}

		// If not found by social, try by email
		if (!user && socialEmail) {
			user = await c.env.DB.prepare("SELECT * FROM wl_Users WHERE email = ?")
				.bind(socialEmail)
				.first();

			// Link social account
			if (user && socialField) {
				await c.env.DB.prepare(
					`UPDATE wl_Users SET ${socialField} = ?, updatedAt = datetime('now') WHERE id = ?`,
				)
					.bind(socialId, user.id)
					.run();
			}
		}

		// Create new user if not found
		if (!user) {
			const userCount = await c.env.DB.prepare(
				"SELECT COUNT(*) as count FROM wl_Users",
			).first();
			const isFirst = ((userCount?.count as number) || 0) === 0;

			const email = socialEmail || `${type}_${socialId}@oauth.local`;

			await c.env.DB.prepare(
				`INSERT INTO wl_Users (display_name, email, password, type, url, avatar, ${socialField || "github"})
         VALUES (?, ?, '', ?, ?, ?, ?)`,
			)
				.bind(
					socialName || socialId,
					email,
					isFirst ? "administrator" : "guest",
					socialUrl,
					socialAvatar,
					socialId,
				)
				.run();

			user = await c.env.DB.prepare("SELECT * FROM wl_Users WHERE email = ?")
				.bind(email)
				.first();
		}

		if (!user) {
			return c.redirect(withQuery(redirect, { error: "oauth_create_failed" }));
		}

		if ((user.type as string) === "banned") {
			return c.redirect(withQuery(redirect, { error: "account_banned" }));
		}

		// Issue JWT
		if (!jwtSecret) {
			return c.redirect(withQuery(redirect, { error: "server_error" }));
		}

		const token = await signJwt({ id: user.id as number }, jwtSecret);

		// Return just JWT token string (matching original Waline)
		return c.redirect(withQuery(redirect, { token }));
	} catch {
		return c.redirect(withQuery(redirect, { error: "oauth_error" }));
	}
});

/** 在跳转地址后追加参数（兼容带查询串 / 绝对 URL 的回跳地址） */
function withQuery(url: string, params: Record<string, string>): string {
	const sep = url.includes("?") ? "&" : "?";
	return `${url}${sep}${new URLSearchParams(params).toString()}`;
}

/**
 * 校验回跳地址：
 * - 允许站点内相对路径（如 /waline/ui/profile）
 * - 允许同源的绝对地址（Waline 客户端会把当前页面 URL 原样传过来）
 * 其他地址一律回落到后台页面，避免 token 被带到外部站点。
 */
function sanitizeRedirect(
	input: string | undefined,
	origin: string,
	fallback: string,
): string {
	const raw = (input || "").trim();
	if (!raw) return fallback;
	if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
	try {
		const u = new URL(raw);
		if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === origin) {
			return u.toString();
		}
	} catch {
		// 非法 URL，走默认值
	}
	return fallback;
}

function getSocialField(type: string): string | null {
	const map: Record<string, string> = {
		github: "github",
		twitter: "twitter",
		facebook: "facebook",
		google: "google",
		weibo: "weibo",
		qq: "qq",
	};
	return map[type] || null;
}
