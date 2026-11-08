/**
 * 统一后台页：/admin（独立于登录页 /admin/login）。
 * - 无大圆角、简约、适配深色模式、字号偏小
 * - 顶部标签：管理文章（默认首页）/ 评论管理；写作页从「＋ 添加新文章」按钮进入，
 *   批量上传页不占顶部标签栏，从写作页「批量上传」按钮（或管理页按钮）进入
 * - 登录态：由服务端 Cookie(bl_token) 判定是否返回本页（独立管理员体系，与评论区账号无关）；
 *   无效则跳转 /admin/login，刷新不再闪登录界面
 * - 编辑器：Vditor「分屏复杂模式」（SV，参考 cp.802213.xyz）
 * - 评论管理：全部 / 待审批 / 已通过 / 垃圾 + 通过/垃圾/删除
 */

const VDIRTOR_CSS = "https://cdn.jsdelivr.net/npm/vditor@3.11.1/dist/index.css";
const VDIRTOR_JS = "https://cdn.jsdelivr.net/npm/vditor@3.11.1/dist/index.min.js";
// AI 消息 Markdown 渲染：使用完整的 GFM 解析器（支持表格、任务列表、删除线等），并用 DOMPurify 防 XSS
const MARKED_JS = "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js";
const DOMPURIFY_JS = "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js";
// 文件编辑器语法高亮：ACE 1.43.3（MIT，按需懒加载，不拖慢其它页面；支持行号/高亮/自动补全/按文件名识别语言）
// 依次尝试多个 CDN，任一可用即可；全部失败时回退到纯文本编辑器，保证一定能打开
const ACE_BASES = [
  "https://cdnjs.cloudflare.com/ajax/libs/ace/1.43.3",
  "https://cdn.jsdelivr.net/npm/ace-builds@1.43.3/src-min-noconflict",
];
const ACE_EXTS = ["ext-language_tools.js", "ext-modelist.js"];

const STYLE = `
:root{color-scheme:light dark;--accent:#f97316;--accent-h:#ea580c;--accent-rgb:249,115,22;
--bg:#f7f7f8;--card:#fff;--fg:#1f2328;--muted:#6b7280;--border:#e3e3e4;--nav:#16181d;
--nav-fg:#e5e7eb;--nav-active:#ffffff;--hover:#f0f0f1;--input-bg:#fff;--danger:#dc2626}
/* 深色变量：跟随系统（除非手动选了浅色）/ 手动指定深色时都生效 */
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
--bg:#0f1115;--card:#181b20;--fg:#e8e8e8;--muted:#9ca3af;--border:#2b2f36;--nav:#0a0c10;
--nav-fg:#a3a3a3;--nav-active:#ffffff;--hover:#23272e;--input-bg:#14161a;--danger:#f87171}}
/* 手动指定主题（设置 → 外观）：优先级高于系统 */
:root[data-theme="dark"]{
--bg:#0f1115;--card:#181b20;--fg:#e8e8e8;--muted:#9ca3af;--border:#2b2f36;--nav:#0a0c10;
--nav-fg:#a3a3a3;--nav-active:#ffffff;--hover:#23272e;--input-bg:#14161a;--danger:#f87171;
color-scheme:dark}
:root[data-theme="light"]{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg)}
a{color:var(--accent);text-decoration:none}
/* 顶栏 */
.wk-nav{background:var(--nav);height:46px;display:flex;align-items:center;padding:0 20px;position:sticky;top:0;z-index:10}
.wk-nav .inner{max-width:1080px;margin:0 auto;width:100%;display:flex;align-items:center;gap:14px}
.wk-nav .brand{display:flex;align-items:center;gap:8px;color:var(--nav-active);font-size:14px;font-weight:600}
.wk-nav .spacer{flex:1}
.wk-nav .user{color:var(--nav-fg);font-size:12px}
.wk-nav .logout{color:var(--nav-fg);font-size:12px;cursor:pointer;border:1px solid var(--border);padding:3px 10px;border-radius:3px;background:transparent}
.wk-nav .logout:hover{color:var(--nav-active);border-color:var(--nav-fg)}
.wk-nav a.site{color:var(--nav-fg);font-size:12px}
.wk-nav a.site:hover{color:var(--nav-active)}
/* 标签页 */
.wk-tabs{display:flex;gap:0;max-width:1080px;margin:14px auto 0;padding:0 16px;border-bottom:1px solid var(--border)}
.wk-tab{padding:8px 16px;font-size:13px;border:none;background:transparent;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent}
.wk-tab.active{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.wk-tab:hover{color:var(--fg)}
/* 构建状态横幅 */
.build-banner{margin:10px 0 0;padding:8px 12px;font-size:12px;border:1px solid var(--border);border-radius:3px;background:var(--hover)}
.build-banner.ok{color:#1a7f37;background:#d1f5d3;border-color:transparent}
.build-banner.err{color:var(--danger);background:rgba(220,38,38,.08);border-color:transparent}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .build-banner.ok{color:#4ade80;background:rgba(74,222,128,.12)}}
:root[data-theme="dark"] .build-banner.ok{color:#4ade80;background:rgba(74,222,128,.12)}
/* 横幅右侧「关闭」按钮（仅终态成功/失败提供，运行中不给） */
.build-x{margin-left:auto;border:0;background:transparent;color:inherit;opacity:.6;font-size:16px;line-height:1;cursor:pointer;padding:2px 7px;border-radius:4px}
.build-x:hover{opacity:1;background:rgba(128,128,128,.18)}
/* 顶部展示「所有正在运行的工作流」的条目标签 */
.build-run-item{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:3px;background:rgba(251,191,36,.16);color:#8a6d00;font-weight:500}
.build-dot{width:7px;height:7px;border-radius:50%;background:#f59e0b;flex:0 0 auto;animation:buildPulse 1.2s ease-in-out infinite}
@keyframes buildPulse{0%,100%{opacity:1}50%{opacity:.2}}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .build-run-item{color:#fbbf24;background:rgba(251,191,36,.12)}}
:root[data-theme="dark"] .build-run-item{color:#fbbf24;background:rgba(251,191,36,.12)}
/* 内容容器 */
.wk-wrap{max-width:1080px;margin:14px auto;padding:0 16px}
/* 卡片（无大圆角） */
.wk-card{background:var(--card);border:1px solid var(--border);border-radius:2px;padding:16px}
.wk-card+.wk-card{margin-top:12px}
.wk-title{font-size:14px;font-weight:600;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid var(--border)}
/* 可展开/收起的卡片（设置页） */
.wk-collapse{background:var(--card);border:1px solid var(--border);border-radius:2px;overflow:hidden}
.wk-collapse+.wk-collapse{margin-top:12px}
.wk-collapse>summary{list-style:none;cursor:pointer;padding:12px 16px;font-size:14px;font-weight:600;color:var(--fg);display:flex;align-items:center;justify-content:space-between;gap:10px;user-select:none;-webkit-tap-highlight-color:transparent}
.wk-collapse>summary::-webkit-details-marker{display:none}
.wk-collapse>summary::after{content:'▾';color:var(--muted);font-size:12px;line-height:1;transition:transform .2s}
.wk-collapse[open]>summary::after{transform:rotate(180deg)}
.wk-collapse>summary:hover{background:var(--hover)}
.wk-collapse .wk-collapse-body{padding:2px 16px 16px;border-top:1px solid var(--border)}
.wk-api-h{font-size:12px;font-weight:600;color:var(--fg);margin:14px 0 6px;padding-left:6px;border-left:2px solid var(--accent)}
.wk-api-h:first-child{margin-top:0}
/* 表单 */
.wk-label{font-size:12px;color:var(--muted);margin:8px 0 4px;display:block}
.wk-input{width:100%;border:1px solid var(--border);border-radius:3px;padding:6px 10px;font-size:13px;font-family:inherit;outline:none;background:var(--input-bg);color:var(--fg)}
.wk-input:focus{border-color:var(--accent);box-shadow:0 0 0 2px rgba(var(--accent-rgb),.12)}
.wk-row{display:flex;gap:12px}
@media(max-width:640px){
.wk-row{flex-direction:column;gap:0}.wk-row>.wk-field{flex-basis:auto;width:100%}
/* 工具栏统一允许换行，避免一行排不下时把右侧按钮顶出屏幕 */
.toolbar{flex-wrap:wrap}
/* 列表行：一行放不下时把操作按钮折到名字下一行，不再横向溢出/与文件名重叠 */
.wk-list li{flex-wrap:wrap}
.wk-list .ops{flex-wrap:wrap;row-gap:6px;max-width:100%}
/* 文件管理：标题+分支切换独占一行（两端分布），操作按钮独立成行换行排布；分支选择器可收缩 */
#page-files .toolbar>div:first-child{width:100%;justify-content:space-between}
#page-files #fileOps{width:100%}
#page-files #branchSel{min-width:0;max-width:52vw}
}
.wk-row>.wk-field{flex:1}
/* 按钮 */
.wk-btn{background:var(--accent);color:#fff;border:none;border-radius:3px;padding:7px 14px;font-size:13px;cursor:pointer;font-weight:500}
.wk-btn:hover{background:var(--accent-h)}
.wk-btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
.wk-btn.ghost:hover{background:var(--hover);color:var(--fg)}
.wk-btn.act{background:var(--nav);color:var(--nav-active);border:none}
.wk-btn.act:hover{background:var(--hover);color:var(--fg)}
.wk-btn.danger{background:transparent;color:var(--danger);border:1px solid var(--border)}
.wk-btn.danger:hover{background:var(--hover)}
.wk-btn:disabled{opacity:.5;cursor:not-allowed}
.wk-btn.sm{padding:3px 10px;font-size:12px;border-radius:3px}
/* 列表 */
.wk-list{list-style:none;margin:0;padding:0}
.wk-list li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 6px;border-bottom:1px solid var(--border)}
.wk-list li:last-child{border-bottom:none}
.wk-list .name{font-size:13px;font-weight:500}
.wk-list .meta{font-size:11px;color:var(--muted);margin-top:1px}
.wk-list .chip{display:inline-block;font-size:11px;color:var(--accent);background:rgba(var(--accent-rgb),.1);border:1px solid rgba(var(--accent-rgb),.25);border-radius:3px;padding:1px 7px;margin-top:4px;margin-right:6px}
.wk-list .chipTag{color:var(--muted);background:var(--hover);border-color:var(--border)}
.wk-list .ops{display:flex;gap:6px;flex-shrink:0}
/* 评论条目 */
.wk-comment{display:flex;gap:10px;padding:10px 6px;border-bottom:1px solid var(--border)}
.wk-comment:last-child{border-bottom:none}
.wk-comment .avatar{width:32px;height:32px;border-radius:3px;background:var(--hover);flex-shrink:0;overflow:hidden}
.wk-comment .avatar img{width:100%;height:100%;object-fit:cover}
.wk-comment .nick{font-size:13px;font-weight:600}
.wk-comment .mail{font-size:11px;color:var(--muted);margin-left:6px}
.wk-comment .path{font-size:11px;color:var(--muted);margin-left:8px;word-break:break-all}
.wk-comment .time{font-size:11px;color:var(--muted);margin-left:8px}
.wk-comment .body{margin-top:3px;font-size:13px;word-break:break-word}
.wk-comment .status{display:inline-block;font-size:10px;padding:0 6px;border-radius:2px;margin-left:8px;vertical-align:middle}
.wk-comment .status.waiting{background:#fff3cd;color:#8a6d00}
.wk-comment .status.approved{background:#d1f5d3;color:#147d19}
.wk-comment .status.spam{background:#fde3e3;color:#d1241f}
.wk-comment .status.admin{background:#f97316;color:#fff;font-weight:600}
.wk-comment .ops{margin-top:4px;display:flex;gap:6px}
.wk-comment .ip{font-size:10px;color:var(--muted);margin-left:4px}
/* 站长回复输入框（内联展开在评论下方） */
.wk-comment .reply-box{margin-top:6px;display:flex;flex-direction:column;gap:6px}
.wk-comment .reply-box textarea{width:100%;min-height:64px;padding:6px 8px;border:1px solid var(--border);border-radius:3px;background:var(--input-bg);color:var(--fg);font:inherit;resize:vertical;outline:none}
.wk-comment .reply-box textarea:focus{border-color:var(--accent)}
.wk-comment .reply-box .reply-ops{display:flex;gap:6px}
/* 编辑区 */
#edt{min-height:480px;border:1px solid var(--border);border-radius:3px}
.hidden{display:none!important}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:10px}
.empty{color:var(--muted);text-align:center;padding:26px 0;font-size:13px}
.filters{display:flex;gap:6px;flex-wrap:wrap}
.filters .wk-btn{padding:3px 12px;font-size:12px;border-radius:3px}
.msg{font-size:12px;min-height:18px}.msg.err{color:var(--danger)}.msg.ok{color:#1a7f37}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .msg.ok{color:#4ade80}}
:root[data-theme="dark"] .msg.ok{color:#4ade80}
/* 部署历史 */
/* 分类/标签历史建议（浏览器原生 datalist，可输入或选择） */
/* 标签联想下拉（多标签：英文逗号分隔，逗号后继续联想） */
.tag-sug{position:absolute;top:100%;left:0;right:0;z-index:30;background:var(--card);border:1px solid var(--border);border-top:none;max-height:180px;overflow:auto;box-shadow:0 4px 12px rgba(0,0,0,.12)}
.tag-sug-item{padding:5px 10px;font-size:12px;cursor:pointer}
.tag-sug-item:hover,.tag-sug-item.active{background:var(--hover);color:var(--accent)}
/* 访问量统计卡片 */
.stats-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:12px}
.stats{display:flex;gap:12px;min-width:max-content}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:2px;padding:14px 22px;min-width:130px}
.stat-card .num{font-size:22px;font-weight:700;color:var(--accent);line-height:1.3}
.stat-card .lbl{font-size:11px;color:var(--muted)}
/* 订阅者表格 */
.wk-table{width:100%;border-collapse:collapse;font-size:13px}
.wk-table th{text-align:left;font-size:11px;color:var(--muted);font-weight:500;padding:8px 6px;border-bottom:1px solid var(--border);white-space:nowrap}
.wk-table td{padding:8px 6px;border-bottom:1px solid var(--border);word-break:break-all}
.wk-table tr:last-child td{border-bottom:none}
.visit-site-row{cursor:pointer}
.visit-site-row:hover td{background:var(--hover)}
.visit-site-row.active td{background:var(--hover);box-shadow:inset 2px 0 0 var(--accent)}
.wk-tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:3px;border:1px solid var(--border);color:var(--muted)}
.wk-tag.ok{color:#1a7f37;border-color:rgba(26,127,55,.35);background:rgba(26,127,55,.08)}
.wk-tag.wait{color:#b45309;border-color:rgba(180,83,9,.35);background:rgba(180,83,9,.08)}
.wk-tag.off{color:var(--muted)}
/* 访问趋势折线图 */
#visitChart{position:relative}
/* 图表下方：区间总量 + 各站点拆分 */
.vb-box{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;font-size:12px}
.vb-total{color:var(--fg);font-weight:600}
.vb-total b{color:var(--accent);font-size:15px;margin:0 2px}
.vb-chip{border:1px solid var(--border);border-radius:3px;padding:2px 8px;color:var(--muted);background:var(--input-bg)}
.vb-chip b{color:var(--fg)}
.chart-svg{max-width:100%}
.chart-svg .cl-grid{stroke:var(--border);stroke-width:1}
.chart-svg .cl-ytxt{fill:var(--muted);font-size:11px}
.chart-svg .cl-xtxt{fill:var(--muted);font-size:11px}
.chart-svg .cl-line{fill:none;stroke:var(--accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.chart-svg .cl-area{fill:var(--accent);opacity:.1;stroke:none}
.chart-svg .cl-dot{fill:var(--accent)}
.chart-svg .cl-cross{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;pointer-events:none}
.chart-svg .cl-mark{fill:var(--card);stroke:var(--accent);stroke-width:2;pointer-events:none}
.chart-tip{position:absolute;transform:translate(-50%,0);background:var(--nav);color:var(--nav-active);font-size:12px;line-height:1.5;padding:4px 8px;border-radius:3px;white-space:nowrap;pointer-events:none;z-index:5;text-align:left}
@media(max-width:640px){.chart-svg .cl-ytxt,.chart-svg .cl-xtxt{font-size:15px}}
/* 顶部标签栏：移动端横向滑动 */
.wk-tabs{display:flex;gap:0;max-width:1080px;margin:14px auto 0;padding:0 16px;border-bottom:1px solid var(--border);overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.wk-tabs::-webkit-scrollbar{display:none}
.wk-tab{padding:8px 16px;font-size:13px;border:none;background:transparent;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;flex:0 0 auto}
/* 部署记录表格：移动端横向滚动 */
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.wk-build-table{width:100%;border-collapse:collapse;font-size:12px;min-width:600px}
.wk-build-table th,.wk-build-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);vertical-align:middle;white-space:nowrap}
.wk-build-table code{background:var(--hover);padding:1px 5px;border-radius:2px;font-size:11px}
.wk-badge{display:inline-block;font-size:11px;padding:1px 8px;border-radius:2px;white-space:nowrap}
.wk-badge.success{background:#d1f5d3;color:#147d19}
.wk-badge.fail{background:#fde3e3;color:#d1241f}
.wk-badge.running{background:#fff3cd;color:#8a6d00}
.wk-badge.wait{background:var(--hover);color:var(--muted)}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .wk-badge.success{color:#4ade80;background:rgba(74,222,128,.12)}:root:not([data-theme="light"]) .wk-badge.fail{color:#f87171;background:rgba(248,113,113,.12)}:root:not([data-theme="light"]) .wk-badge.running{color:#fbbf24;background:rgba(251,191,36,.12)}}
:root[data-theme="dark"] .wk-badge.success{color:#4ade80;background:rgba(74,222,128,.12)}
:root[data-theme="dark"] .wk-badge.fail{color:#f87171;background:rgba(248,113,113,.12)}
:root[data-theme="dark"] .wk-badge.running{color:#fbbf24;background:rgba(251,191,36,.12)}

/* AI 助手（聊天）：扁平风格，方形直角，贴合后台原有样式 */
.ai-chat{position:relative;display:flex;gap:0;padding:0;height:calc(100vh - 128px);min-height:420px;overflow:hidden}
.ai-chat.ai-full{position:fixed;inset:0;width:100vw;height:100vh;min-height:0;margin:0;z-index:200;border:none;border-radius:0}
.ai-chat.ai-full .ai-col{max-width:none;padding-left:32px;padding-right:32px}
.ai-side{width:216px;flex-shrink:0;display:flex;flex-direction:column;min-width:0;border-right:1px solid var(--border);padding:12px;background:var(--hover);overflow:hidden;transition:width .26s ease,padding .26s ease,border-right-width .26s ease}
.ai-side-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.ai-side-title{font-size:11px;color:var(--muted);margin:14px 0 6px;letter-spacing:.06em}
.ai-conv-list{flex:1;overflow:auto;display:flex;flex-direction:column;gap:2px;margin:0 -6px;padding:0 6px}
.ai-conv{display:flex;align-items:center;gap:6px;padding:6px 8px;border:1px solid transparent;border-left:2px solid transparent;border-radius:2px;cursor:pointer;font-size:13px;color:var(--fg)}
.ai-conv:hover{background:var(--card)}
.ai-conv.active{background:var(--card);border-color:var(--border);border-left-color:var(--accent)}
.ai-conv-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-main{flex:1;display:flex;flex-direction:column;min-width:0}
.ai-bar{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0;min-width:0}
/* 始终预留滚动条位置：输出内容时滚动条出现/消失不再让中间内容左右跳 */
.ai-scroll{flex:1;overflow-y:scroll;overflow-x:auto;min-height:0;overflow-anchor:none;scrollbar-gutter:stable}
.ai-col{max-width:748px;width:100%;margin:0 auto;padding:18px 16px 4px;display:flex;flex-direction:column;gap:16px}
.ai-msg{display:flex;flex-direction:column;gap:4px;min-width:0}
.ai-msg.user{align-items:flex-end}
.ai-msg.assistant{align-items:stretch}
.ai-who{font-size:11px;color:var(--muted)}
/* 正文严格限制在气泡内换行：长链接/长串也不会顶出左右两边 */
.ai-body{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;max-width:100%;line-height:1.7;font-size:14px;border-radius:2px}
.ai-msg.assistant .ai-body{background:transparent;border:none;padding:0}
.ai-msg.user .ai-body{max-width:82%;padding:8px 12px;background:var(--hover);border:1px solid var(--border)}
/* Markdown 渲染 */
.ai-body.md{white-space:normal}
.ai-body.md>*:first-child{margin-top:0}
.ai-body.md p{margin:0 0 8px}
.ai-body.md p:last-child{margin-bottom:0}
.ai-body.md ul,.ai-body.md ol{margin:0 0 8px;padding-left:22px}
.ai-body.md li{margin:2px 0}
.ai-body.md h1,.ai-body.md h2,.ai-body.md h3,.ai-body.md h4,.ai-body.md h5,.ai-body.md h6{margin:12px 0 6px;line-height:1.4;font-size:15px}
.ai-body.md h1{font-size:18px}
.ai-body.md h2{font-size:16px}
.ai-body.md code{background:var(--hover);border:1px solid var(--border);padding:0 4px;border-radius:2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
.ai-body.md pre{background:var(--hover);border:1px solid var(--border);border-radius:2px;padding:8px 10px;overflow:auto;margin:0 0 8px}
.ai-body.md pre code{background:transparent;border:none;padding:0;font-size:12.5px;line-height:1.6}
.ai-body.md blockquote{margin:0 0 8px;padding:2px 10px;border-left:2px solid var(--border);color:var(--muted)}
.ai-body.md hr{border:none;border-top:1px solid var(--border);margin:10px 0}
.ai-body.md a{text-decoration:underline}
.ai-body.md img{max-width:100%;height:auto}
/* GFM 表格（marked 渲染）：窄屏可横向滚动 */
.ai-body.md table{border-collapse:collapse;margin:0 0 8px;display:block;width:max-content;max-width:100%;overflow:auto}
.ai-body.md th,.ai-body.md td{border:1px solid var(--border);padding:4px 10px;text-align:left;vertical-align:top}
.ai-body.md th{background:var(--hover);font-weight:600}
.ai-body.md tbody tr:nth-child(even){background:color-mix(in srgb,var(--hover) 45%,transparent)}
/* 任务列表 */
.ai-body.md li:has(input[type=checkbox]){list-style:none;margin-left:-18px}
.ai-body.md input[type=checkbox]{width:auto;margin:0 6px 0 0;vertical-align:middle}
/* 思考与工具调用过程：默认收起成一行；生成中这一行显示实时状态，结束后显示「已深度思考 · N 次工具调用 · 用时 Xs」，点开看完整过程 */
.ai-proc{border:1px solid var(--border);border-radius:2px;background:var(--hover);margin:0 0 8px}
/* 过程块摘要行（「已深度思考 · 最后调用 …」）：吸在滚动区顶部作为该回合的「天花板」，
   往下可自由滚动，往上滚到这行即停；随时可点一下收起整个过程块 */
.ai-proc>summary{position:sticky;top:0;z-index:6;background:var(--hover);cursor:pointer;font-size:12px;color:var(--muted);padding:6px 10px;outline:none}
.ai-proc>summary:hover{color:var(--fg)}
.ai-proc-body{padding:2px 10px 8px;max-height:420px;overflow:auto;font-size:12.5px;color:var(--muted)}
.ai-proc-seg{margin:0 0 8px}
.ai-proc-tag{font-size:11px;color:var(--muted);opacity:.85;margin-bottom:2px}
.ai-proc-text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;line-height:1.7}
/* 最终回答：与过程分开，始终显示 */
.ai-answer{margin:0}
/* 单个工具调用 + 结果：可单独展开收起 */
.ai-tool-fold{border:1px solid var(--border);border-radius:2px;margin:0 0 6px;background:var(--card)}
.ai-tool-fold>summary{cursor:pointer;padding:5px 8px;list-style:none;outline:none;word-break:break-word}
.ai-tool-fold>summary::-webkit-details-marker{display:none}
.ai-tool-fold>summary:before{content:'▸ ';color:var(--muted)}
.ai-tool-fold[open]>summary:before{content:'▾ '}
.ai-tool-fold-body{padding:0 8px 8px}
.ai-tool-fold-sec{margin:0 0 6px}
.ai-tool-fold-pre{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;line-height:1.6;max-height:240px;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.ai-tool-fold-pre.err{color:#d9534f}
/* 等待模型响应的提示已移到输入框上方的底部状态行（#aiChatMsg），不再占用消息区 */
/* 输入区上方一行的「i」按钮：查看已用 token / 缓存命中 */
#aiUsageBtn{margin-left:auto;flex:0 0 auto;width:26px;height:26px;padding:0;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;line-height:1}
.ai-usage-pop{position:fixed;z-index:1200;background:var(--card);border:1px solid var(--border);border-radius:4px;box-shadow:0 6px 24px rgba(0,0,0,.18);padding:10px 12px;min-width:190px;font-size:12px}
.ai-usage-pop-h{font-size:12px;font-weight:600;margin-bottom:8px}
.ai-usage-row{display:flex;justify-content:space-between;gap:18px;padding:3px 0;color:var(--muted)}
.ai-usage-row b{color:var(--fg);font-weight:600}
.ai-usage-empty{color:var(--muted);max-width:210px;line-height:1.6}
.ai-input{display:flex;gap:8px;align-items:flex-end;padding:8px 14px 12px;flex-shrink:0}
/* 「继续未完成回复」提示条：打开未跑完的历史会话时出现 */
.ai-continue{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;padding:7px 10px;font-size:12px;border:1px solid var(--border);border-radius:3px;background:rgba(251,191,36,.14);color:#8a6d00}
.ai-continue span{flex:1 1 auto}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]) .ai-continue{color:#fbbf24;background:rgba(251,191,36,.12)}}
:root[data-theme="dark"] .ai-continue{color:#fbbf24;background:rgba(251,191,36,.12)}
/* 输入框：随内容自动增高；右下角手柄可手动拖拽调整高度（拖拽后固定，内容更多时到 600 上限内部滚动） */
.ai-input textarea{flex:1;resize:vertical;min-height:34px;max-height:600px;overflow-y:hidden;border-radius:2px}
/* 中断的过程块摘要：与「已完成」区分 */
.ai-proc summary .ai-int{color:var(--danger)}
/* 生成中：发送键原地变成灰色「停止」 */
#aiSendBtn{flex:0 0 auto}
#aiSendBtn.stop{background:var(--muted);color:#fff}
#aiSendBtn.stop:hover{background:var(--muted);opacity:.88}
.ai-foot{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;overflow-x:auto;padding:10px 14px 0;border-top:1px solid var(--border);flex-shrink:0}
.ai-foot .wk-label{flex:0 0 auto;white-space:nowrap}
.ai-foot select.wk-input{flex-shrink:1}
.ai-model-list{max-height:240px;overflow:auto;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start}
.ai-pick{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border);border-radius:2px;padding:3px 8px;font-size:12px;cursor:pointer;background:var(--input-bg)}
.ai-pick:hover{background:var(--hover)}
.ai-pick.on{border-color:var(--accent);color:var(--accent)}
.ai-pick input{width:auto;margin:0}
.ai-pick-n{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-chat.side-off .ai-side{width:0;padding-left:0;padding-right:0;border-right-width:0}
.ai-chat-title{font-size:14px;font-weight:600;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text}
/* 顶栏右侧操作区：编辑/全屏/停止 强制同一行、靠右上角 */
.ai-bar-acts{display:flex;align-items:center;gap:6px;flex:0 0 auto;margin-left:auto}
#aiChatHint{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-icon-btn{display:inline-flex;align-items:center;justify-content:center;padding:4px 6px;line-height:0}
.ai-acts{display:flex;gap:12px;margin-top:2px}
.ai-msg.user .ai-acts{justify-content:flex-end}
.ai-acts button{border:none;background:transparent;color:var(--muted);font-size:11px;cursor:pointer;padding:0;font-family:inherit}
.ai-acts button:hover{color:var(--accent);text-decoration:underline}
.ai-secret-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
.ai-secret-box{background:var(--card);border:1px solid var(--border);border-radius:4px;padding:16px;max-width:430px;width:100%}
.ai-secret-title{font-size:14px;font-weight:600;margin-bottom:8px}
.ai-secret-desc{font-size:12px;color:var(--muted);margin:0 0 12px;line-height:1.7}
.ai-tool-note{font-size:12px;color:var(--muted);border-left:2px solid var(--border);padding:4px 10px;margin:0;word-break:break-all;background:var(--hover)}
.ai-tool-note.err{border-left-color:#dc2626}
.ai-tool-tag{display:inline-block;font-size:11px;padding:0 6px;margin-right:6px;border:1px solid var(--border);border-radius:2px;color:var(--muted)}
.ai-tool-inline{opacity:.8}
.ai-tool-confirm{border:1px solid var(--accent);border-radius:2px;padding:10px 12px;background:var(--card)}
.ai-tool-head{font-size:13px;font-weight:600;margin-bottom:6px}
.ai-tool-pre{margin:0;max-height:200px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-all;background:var(--hover);padding:8px;border-radius:2px}
@media(max-width:640px){
/* 手机端：聊天区占满可视高度，输入框贴到屏幕底部（精确高度由 aiFitHeight() 计算，此处为兜底） */
.ai-chat{height:calc(100dvh - 114px);min-height:0;border-radius:0}
.ai-side{position:absolute;top:0;left:0;bottom:0;width:min(78vw,260px);z-index:6;transition:transform .26s ease}
.ai-chat.side-off .ai-side{width:min(78vw,260px);padding:12px;border-right-width:1px;transform:translateX(-100%)}
.ai-scroll{min-height:0}
/* 顶栏：所有按钮强制一行靠右上角，标题溢出省略，提示文字手机端隐藏 */
.ai-bar{gap:4px;padding:8px 10px}
.ai-bar .wk-btn{padding:4px 6px;font-size:12px;flex:0 0 auto;white-space:nowrap}
.ai-bar-acts{gap:4px}
.ai-chat-title{font-size:13px}
#aiChatHint{display:none}
/* 进入 AI 页时不保留容器下边距，避免底部出现可滚动的空隙 */
.wk-wrap:has(#page-ai:not(.hidden)){margin-bottom:0}
/* 控制行：隐藏文字标签，选择器尽量紧凑，单行不换行（不够时横向滑动） */
.ai-foot{gap:6px;padding:6px 10px 0;flex-wrap:nowrap;overflow-x:auto;flex-shrink:0}
.ai-foot .wk-label{display:none}
.ai-foot select.wk-input{flex:0 0 auto!important;width:auto!important;min-width:0!important;max-width:38vw!important;padding:3px 4px!important;font-size:12px;text-overflow:ellipsis}
#aiChatModel{max-width:34vw!important}
.ai-input{padding:6px 10px calc(6px + env(safe-area-inset-bottom))}
}
/* 文件编辑器：容器填满剩余高度（ACE 挂载于此，未加载好时先用原生 textarea 兜底） */
#fileEditArea{flex:1;min-height:0;position:relative;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
#fileEditArea textarea.fileedit-fallback{position:absolute;inset:0;width:100%;height:100%;box-sizing:border-box;border:none;border-radius:0;padding:14px;background:var(--input-bg);color:var(--fg);outline:none;resize:none;font:inherit}
#fileEditArea .ace_editor{font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
/* 按钮加载中的小转圈 */
.wk-spin{display:inline-block;width:11px;height:11px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:wk-spin .7s linear infinite;vertical-align:-1px;margin-right:4px}
@keyframes wk-spin{to{transform:rotate(360deg)}}
`;

const SCRIPT = `
const API_BASE = '/admin/api';
const storage = {
  get: k => { try { return localStorage.getItem(k)||sessionStorage.getItem(k)||'' } catch(e){ return '' } },
  set: (k,v) => { try { localStorage.setItem(k,v) } catch(e){} }
};
let token = '';
let editor = null;
let editorInited = false;
let editingPath = '';
let pendingEditorValue = '';
let editorReadyWait = 0;
let activePage = 'manage';

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const api = async (url, opt={}) => {
  const h = Object.assign({'Content-Type':'application/json'}, opt.headers||{});
  if (token) h['Authorization'] = 'Bearer ' + token;
  // 30 秒超时：请求挂起时不再无限等待，前端能拿到明确错误
  const ctl = (typeof AbortController!=='undefined') ? new AbortController() : null;
  const t = ctl ? setTimeout(()=>{ try{ ctl.abort(); }catch(e){} }, 30000) : null;
  let r;
  try {
    r = await fetch(url, Object.assign({}, opt, {headers:h, signal: ctl?ctl.signal:undefined}));
  } catch(e) {
    if(t) clearTimeout(t);
    return { ok:false, status:0, data:{ error:'网络请求失败或超时（30 秒），请检查网络后重试' } };
  }
  if(t) clearTimeout(t);
  let d = null; try { d = await r.json(); } catch(e){}
  return { ok: r.ok, status: r.status, data: d };
};

// 自定义确认弹窗：替代原生 confirm（浏览器连续弹窗后会被用户勾选「阻止更多对话框」屏蔽，
// 导致删除等操作静默无反应；自定义弹窗不受影响），Promise 化：await askConfirm('...')
function askConfirm(msg){
  return new Promise((resolve)=>{
    let m=$('#askMask');
    if(!m){
      m=document.createElement('div'); m.id='askMask';
      m.style.cssText='position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:20px';
      m.innerHTML='<div style="background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:3px;max-width:430px;width:100%;padding:18px;box-shadow:0 8px 30px rgba(0,0,0,.25)">'+
        '<div id="askMsg" style="font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word"></div>'+
        '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">'+
        '<button class="wk-btn ghost sm" id="askNo">取消</button>'+
        '<button class="wk-btn sm" id="askYes">确认</button></div></div>';
      document.body.appendChild(m);
      // Esc / 点遮罩 = 取消（只注册一次）
      document.addEventListener('keydown',function(ev){
        const mm=$('#askMask');
        if(mm && mm.style.display!=='none' && ev.key==='Escape'){ mm.style.display='none'; if(mm.__resolve) mm.__resolve(false); }
      });
      m.addEventListener('click',function(ev){ if(ev.target===m){ m.style.display='none'; if(m.__resolve) m.__resolve(false); } });
    }
    const done=(v)=>{ m.style.display='none'; m.__resolve=null; const y=$('#askYes'); if(y) y.disabled=false; resolve(v); };
    m.__resolve=done;
    $('#askNo').onclick=()=>done(false);
    $('#askYes').onclick=()=>done(true);
    $('#askMsg').textContent=msg;
    m.style.display='flex';
    setTimeout(()=>{ try{ $('#askYes').focus(); }catch(e){} },30);
  });
}
// 静默收起操作横幅（加载类操作完成且无需提示时用）
function opBannerHide(){
  if(opBannerTimer){ clearTimeout(opBannerTimer); opBannerTimer=null; }
  if(opBannerWatchdog){ clearTimeout(opBannerWatchdog); opBannerWatchdog=null; }
  opBannerBusy=false;
  const b=$('#globalBuildBanner'); if(b) b.classList.add('hidden');
}

function toast(msg, isErr){
  let el = $('#msg');
  if(!el || el.offsetParent===null){
    // 全局兜底：当前激活页没有可见的 #msg 时，用一个全局浮层
    el = $('#wk-toast');
    if(!el){
      el = document.createElement('div');
      el.id='wk-toast';
      el.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2000;padding:8px 16px;font-size:13px;border-radius:3px;color:#fff;background:#111827;box-shadow:0 2px 8px rgba(0,0,0,.2);max-width:80vw';
      document.body.appendChild(el);
    }
    el.style.background = isErr ? '#dc2626' : '#111827';
  }
  el.textContent = msg;
  el.className = 'msg ' + (isErr ? 'err' : 'ok') + (el.id==='wk-toast' ? ' wk-toast' : '');
  el.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>{ el.style.opacity='0'; }, 2400);
}

// 读取登录态：Cookie(bl_token) 由服务端签发与校验；非法则跳登录页（由 /admin 服务端已保证 Cookie 存在）
function getToken(){
  const c = document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith('bl_token='));
  if (c) { try { return decodeURIComponent(c.slice('bl_token='.length)); } catch(e){} }
  return '';
}

// ---------- tab（独立路由 /admin/xxx，SPA 切换：仅改地址栏，绝不刷新）----------
const TAB_NAMES=['manage','upload','comments','files','build','theme','visit','subscribe','ai','settings','write'];
function showPage(name){ activePage=name; $$('.wk-page').forEach(p=>p.classList.toggle('hidden', p.id!=='page-'+name)); }
// 进入写作页（新建/编辑共用）：首次初始化编辑器与草稿
let writeInited=false;
// 本地时区的「今天」（toISOString 是 UTC，东八区早上会变前一天，这里按浏览器本地日期）
function localToday(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function enterWritePage(){
  if(!writeInited){
    writeInited=true;
    if(!editingPath){
      // 新文章日期始终为当前日期（即使恢复草稿也一样），用户仍可手动改
      $('#date').value=localToday();
      restoreDraft();
    }
    initEditorOnce();
    loadTaxonomySuggest();
  }
  showPage('write');
  window.scrollTo(0,0);
}
// 统一切换：先显示页面，再更新地址栏（replaceState 不新增历史，稳定不刷新）
function go(name){
  name=TAB_NAMES.includes(name)?name:'manage';
  $$('.wk-tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===name));
  if(name==='write'){ enterWritePage(); }
  else {
    showPage(name);
    if(name==='manage'){ loadPosts(); initBuildStatus(); }
    if(name==='upload') renderUploadList();
    if(name==='comments') loadComments();
    if(name==='files'){ loadFiles(); resumeUnzipStatus(); }
    if(name==='build'){ loadBuildWorkflows(); loadBuildHistory(); }
    if(name==='theme') loadThemes();
    if(name==='visit') loadVisit();
    if(name==='subscribe') loadSubscribe();
    if(name==='ai'){ loadAiChat(); aiFitHeight(); }
    if(name==='settings'){ loadSubscribeSettings(); loadSiteSettings(); loadAiSettings(); loadSecrets(); }
    window.scrollTo(0,0);
  }
  // AI 页保留会话 id（/admin/ai/<id>）；文件管理页带上当前目录（?pwd=分支/路径），刷新回到原位置；其余用 /admin/<name>
  let url;
  if(name === 'ai' && aiConvId) url = '/admin/ai/' + aiConvId;
  else if(name === 'files') url = '/admin/files?pwd=' + encodeURIComponent(curBranch() + (filePath ? '/' + filePath : ''));
  else url = '/admin/' + name;
  try{ history.replaceState(null,'',url); }catch(e){}
}
function switchTab(name){ go(name); }

// ---------- 主题管理（自动检测 themes/ 目录 + 切换 + 克隆添加）----------
let themeListData = [];
async function loadThemes(){
  const box = $('#themeList');
  if(box) box.innerHTML = '<div class="empty">加载中...</div>';
  try{
    const r = await api('/admin/api/themes');
    if(!r.ok || !r.data){
      if(box) box.innerHTML = '<div class="empty">加载失败：' + esc((r.data && r.data.error) || '未知错误') + '</div>';
      return;
    }
    themeListData = r.data.themes || [];
    if(!box) return;
    if(!themeListData.length){ box.innerHTML = '<div class="empty">themes/ 目录下没有主题，可在下方添加</div>'; return; }
    let h = '<table class="wk-table"><thead><tr><th>主题目录</th><th>状态</th><th style="text-align:right">操作</th></tr></thead><tbody>';
    themeListData.forEach((t, i) => {
      const cur = !!(t.current && t.valid);
      h += '<tr><td>' + esc(t.name) + '</td>'
        + '<td>' + (cur ? '<span class="wk-tag ok">当前主题</span>'
          : (t.valid ? '<span class="wk-tag">可用</span>' : '<span class="wk-tag off">非主题目录</span>')) + '</td>'
        + '<td style="text-align:right">' + (cur
          ? '<button class="wk-btn ghost sm" disabled>使用中</button>'
          : (t.valid ? '<button class="wk-btn sm" onclick="switchTheme(' + i + ')">切换</button>' : '')) + '</td></tr>';
    });
    h += '</tbody></table>';
    box.innerHTML = h;
  }catch(e){ if(box) box.innerHTML = '<div class="empty">加载失败</div>'; }
}
async function switchTheme(i){
  const t = themeListData[i];
  if(!t) return;
  if(!await askConfirm('确认切换主题为「' + t.name + '」？将修改 _config.yml 并触发部署重建站点。')) return;
  const msg = $('#themeMsg');
  if(msg){ msg.className='msg'; msg.textContent='切换中...'; }
  const r = await api('/admin/api/themes/switch', { method:'POST', body: JSON.stringify({ name: t.name }) });
  if(r.ok){
    toast((r.data && r.data.message) || '已切换主题');
    if(msg){ msg.className='msg ok'; msg.textContent=(r.data && r.data.message) || '已切换主题，等待部署完成即可生效'; }
    loadThemes();
    initBuildStatus();
  } else {
    const err = (r.data && r.data.error) || '切换失败';
    toast(err, true);
    if(msg){ msg.className='msg err'; msg.textContent=err; }
  }
}
// 解析 GitHub 地址：支持 owner/repo、https://github.com/owner/repo、…/tree/branch、.git 结尾、git@ 形式
function parseGithubUrl(input){
  let s = String(input || '').trim();
  if(!s) return null;
  s = s.replace(/^git@github\\.com:/i, 'https://github.com/');
  const m = /^(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/([^\\/\\s]+)\\/([^\\/\\s#?]+?)(?:\\.git)?(?:\\/tree\\/([^\\/\\s#?]+))?$/i.exec(s);
  if(m) return { owner: m[1], repo: m[2], branch: m[3] || '' };
  const m2 = /^([\\w.-]+)\\/([\\w.-]+?)(?:\\.git)?$/.exec(s);
  if(m2) return { owner: m2[1], repo: m2[2], branch: '' };
  return null;
}
async function addTheme(){
  const url = (($('#themeRepoUrl')||{}).value || '').trim();
  let dir = (($('#themeDirName')||{}).value || '').trim();
  const msg = $('#themeMsg');
  const show = (ok, text) => { if(msg){ msg.className = ok ? 'msg ok' : 'msg err'; msg.textContent = text; } };
  const p = parseGithubUrl(url);
  if(!p){ show(false, '无法识别的 GitHub 地址，请输入如 https://github.com/owner/repo 的链接'); toast('地址无法识别', true); return; }
  if(!dir) dir = p.repo;
  dir = dir.replace(/[^\\w.\\-\\u4e00-\\u9fa5]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if(!dir){ show(false, '目录名无效'); toast('目录名无效', true); return; }
  // 目标目录重名时自动加后缀，避免克隆工作流因目录非空而中止
  const exists = new Set(themeListData.map(t => t.name));
  let target = dir, n = 2;
  while(exists.has(target)) target = dir + '-' + (n++);
  const btn = $('#themeAddBtn');
  if(btn) btn.disabled = true;
  show(true, '正在触发克隆到 themes/' + target + '...');
  try{
    const r = await api('/admin/api/clone-repo', { method:'POST', body: JSON.stringify({
      repo_url: 'https://github.com/' + p.owner + '/' + p.repo + '.git',
      target_dir: 'themes/' + target,
      ref: p.branch || ''
    }) });
    if(!r.ok){
      const err = (r.data && r.data.error) || '触发克隆失败';
      show(false, err);
      toast(err, true);
      return;
    }
    toast('已触发克隆，等待完成...');
    pollThemeClone(target);
  } finally { if(btn) btn.disabled = false; }
}
// 轮询 clone-repo 工作流状态，成功后刷新主题列表
let themeCloneTimer = null;
function pollThemeClone(target){
  const bar = $('#themeCloneStatus');
  if(bar){ bar.classList.remove('hidden'); bar.className = 'build-banner'; bar.textContent = '克隆 themes/' + target + ' 进行中...'; }
  if(themeCloneTimer) clearInterval(themeCloneTimer);
  let times = 0;
  themeCloneTimer = setInterval(async () => {
    times++;
    try{
      const r = await api('/admin/api/workflows/runs?workflow=clone-repo.yml&limit=1');
      const run = r.ok && r.data && r.data.runs && r.data.runs[0];
      if(!run) return;
      if(bar){
        if(run.status === 'completed'){
          bar.className = 'build-banner' + (run.conclusion === 'failure' ? ' err' : '');
          bar.textContent = '克隆 themes/' + target + (run.conclusion === 'success' ? ' 完成' : ' 失败（' + (run.conclusion || '未知原因') + '）');
        } else {
          bar.textContent = '克隆 themes/' + target + ' 进行中（' + run.status + '）...';
        }
      }
      if(run.status === 'completed'){
        clearInterval(themeCloneTimer); themeCloneTimer = null;
        if(run.conclusion === 'success'){
          toast('主题克隆完成');
          loadThemes();
          setTimeout(() => { const b = $('#themeCloneStatus'); if(b) b.classList.add('hidden'); }, 8000);
        } else {
          toast('克隆失败：' + (run.conclusion || '未知原因'), true);
        }
      } else if(times > 60){
        clearInterval(themeCloneTimer); themeCloneTimer = null;
      }
    }catch(e){}
  }, 5000);
}

// ---------- 访问量（仅管理员可见）----------
let visitDays = 30;
// 折线图当前查看的站点（空 = 全部站点）
let visitSite = '';

// 折线图：用内联 SVG 绘制最近 N 天访问量；siteSeries 用于悬停时显示各站点拆分
function renderVisitChart(series, siteSeries){
  const el = $('#visitChart');
  if(!el) return;
  if(!series || !series.length){ el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  // day → [{site,count}]（只保留有访问的站点）
  const byDay = {};
  (siteSeries || []).forEach(function(s){
    (s.series || []).forEach(function(pt){
      const c = Number(pt && pt.count) || 0;
      if(!pt || !c) return;
      (byDay[pt.day] = byDay[pt.day] || []).push({ site: s.site, count: c });
    });
  });
  const W = 800, H = 260, padL = 46, padR = 16, padT = 16, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = series.length;
  const max = Math.max(1, ...series.map(p => Number(p.count) || 0));
  const X = i => padL + (n === 1 ? iw / 2 : iw * i / (n - 1));
  const Y = v => padT + ih - ih * (v / max);
  let grid = '';
  for(let t = 0; t <= 4; t++){
    const v = max * t / 4, yy = Y(v);
    grid += '<line class="cl-grid" x1="'+padL+'" y1="'+yy.toFixed(1)+'" x2="'+(W-padR)+'" y2="'+yy.toFixed(1)+'"/>';
    grid += '<text class="cl-ytxt" x="'+(padL-6)+'" y="'+(yy+3).toFixed(1)+'" text-anchor="end">'+Math.round(v)+'</text>';
  }
  const pts = series.map((p,i) => X(i).toFixed(1)+','+Y(Number(p.count)||0).toFixed(1)).join(' ');
  const area = '<polygon class="cl-area" points="'+padL+','+(padT+ih)+' '+pts+' '+(W-padR)+','+(padT+ih)+'"/>';
  const line = '<polyline class="cl-line" points="'+pts+'"/>';
  let dots = '';
  if(n <= 62){
    dots = series.map((p,i) => '<circle class="cl-dot" cx="'+X(i).toFixed(1)+'" cy="'+Y(Number(p.count)||0).toFixed(1)+'" r="2.5"><title>'+esc(p.day)+'：'+esc(p.count)+'</title></circle>').join('');
  }
  const step = Math.ceil(n / 6);
  let xl = '';
  series.forEach((p,i) => {
    if(i % step === 0 || i === n - 1){
      xl += '<text class="cl-xtxt" x="'+X(i).toFixed(1)+'" y="'+(H-9)+'" text-anchor="middle">'+esc(String(p.day).slice(5))+'</text>';
    }
  });
  const cross = '<line class="cl-cross" y1="'+padT+'" y2="'+(padT+ih)+'" style="opacity:0"/>';
  const mark = '<circle class="cl-mark" r="4" style="opacity:0"/>';
  el.innerHTML = '<div class="chart-tip hidden"></div><svg viewBox="0 0 '+W+' '+H+'" class="chart-svg" style="width:100%;height:auto;display:block">'+grid+area+line+dots+cross+mark+xl+'</svg>';
  const svg = el.querySelector('svg');
  el.__geo = {
    W:W, H:H, padL:padL, padT:padT, iw:iw, ih:ih, n:n, series:series, X:X, Y:Y,
    bySite: byDay,
    cross: svg.querySelector('.cl-cross'),
    mark: svg.querySelector('.cl-mark'),
    tip: el.querySelector('.chart-tip')
  };
  // 鼠标悬停：显示该点对应的日期与访问量（补齐「列」的提示）
  el.onmousemove = function(ev){
    const g = el.__geo;
    if(!g || !g.tip) return;
    const rect = el.getBoundingClientRect();
    if(!rect.width) return;
    const px = (ev.clientX - rect.left) * (g.W / rect.width);
    let i = g.n === 1 ? 0 : Math.round((px - g.padL) / (g.iw / (g.n - 1)));
    i = Math.max(0, Math.min(g.n - 1, i));
    const p = g.series[i] || {};
    const cx = g.X(i), cy = g.Y(Number(p.count) || 0);
    g.cross.setAttribute('x1', cx.toFixed(1));
    g.cross.setAttribute('x2', cx.toFixed(1));
    g.cross.style.opacity = '1';
    g.mark.setAttribute('cx', cx.toFixed(1));
    g.mark.setAttribute('cy', cy.toFixed(1));
    g.mark.style.opacity = '1';
    // 悬停提示：日期 + 全部站点次数；全部站点视图下再列出各站点当天的次数
    let html = '<b>' + esc(String(p.day || '')) + '</b>　' + esc(visitSite || '全部站点') + '：' + (Number(p.count) || 0) + ' 次';
    if(!visitSite && g.bySite){
      const rows = (g.bySite[p.day] || []).slice().sort(function(a, b){ return b.count - a.count; });
      rows.forEach(function(r){ html += '<br>' + esc(r.site) + '：' + r.count + ' 次'; });
    }
    g.tip.innerHTML = html;
    g.tip.classList.remove('hidden');
    const tx = Math.max(34, Math.min(rect.width - 34, (cx / g.W) * rect.width));
    const ty = Math.max(0, (cy / g.H) * rect.height - 36);
    g.tip.style.left = tx + 'px';
    g.tip.style.top = ty + 'px';
  };
  el.onmouseleave = function(){
    const g = el.__geo;
    if(!g) return;
    g.cross.style.opacity = '0';
    g.mark.style.opacity = '0';
    if(g.tip) g.tip.classList.add('hidden');
  };
}

// 读取今日/总访问量 + 最近 N 天趋势
async function loadVisit(){
  const today = $('#statToday'), total = $('#statTotal');
  if(today) today.textContent = '-';
  if(total) total.textContent = '-';
  try{
    const r = await api('/api/visit/stats');
    if(r.ok){
      const d = r.data || {};
      if(today) today.textContent = (d.today == null ? '-' : d.today);
      if(total) total.textContent = (d.total == null ? '-' : d.total);
    }
  }catch(e){}
  const chart = $('#visitChart'), bd = $('#visitBreakdown');
  if(chart) chart.innerHTML = '<div class="empty">加载中...</div>';
  if(bd) bd.innerHTML = '<span class="vb-chip">加载中...</span>';
  const scope = $('#visitChartScope');
  if(scope) scope.textContent = visitSite ? ' · ' + visitSite : ' · 全部站点';
  try{
    const r = await api('/admin/api/visit/daily?days=' + visitDays + (visitSite ? '&site=' + encodeURIComponent(visitSite) : ''));
    if(r.ok && r.data){
      renderVisitChart(r.data.series || [], r.data.siteSeries || []);
    } else {
      if(chart) chart.innerHTML = '<div class="empty">加载失败</div>';
    }
  }catch(e){
    if(chart) chart.innerHTML = '<div class="empty">加载失败</div>';
  }
  const ld = $('#visitDaysLabel');
  if(ld) ld.textContent = visitDays;
  const sld = $('#visitSiteDaysLabel');
  if(sld) sld.textContent = visitDays;
  loadVisitSites();
}

// 图表下方汇总：区间总访问量 + 各站点拆分（选中站点时只显示该站点）
function renderVisitBreakdown(d){
  const box = $('#visitBreakdown');
  if(!box) return;
  const sites = d.sites || [];
  let h = '';
  if(visitSite){
    const s = sites.find(x => x.site === visitSite);
    h += '<span class="vb-total">近 ' + visitDays + ' 天 · ' + esc(visitSite) + '：<b>' + (s ? (Number(s.range)||0) : 0) + '</b> 次</span>';
    if(s) h += '<span class="vb-chip">累计 <b>' + (Number(s.total)||0) + '</b> 次</span>';
  }else{
    h += '<span class="vb-total">近 ' + visitDays + ' 天总访问量：<b>' + (Number(d.rangeTotal)||0) + '</b> 次</span>';
    sites.forEach(s => {
      h += '<span class="vb-chip">' + esc(s.site) + ' <b>' + (Number(s.range)||0) + '</b> 次</span>';
    });
    if(Number(d.legacy) > 0) h += '<span class="vb-chip">未分类 <b>' + (Number(d.legacy)||0) + '</b> 次</span>';
    if(!sites.length) h += '<span class="vb-chip">暂无站点数据</span>';
  }
  box.innerHTML = h;
}

// 来源站点明细：站点 / 今日 / 区间 / 累计 / 占比
async function loadVisitSites(){
  const box = $('#visitSiteList');
  if(!box) return;
  box.innerHTML = '<div class="empty">加载中...</div>';
  try{
    const r = await api('/admin/api/visit/sites?days=' + visitDays);
    if(!r.ok || !r.data){ box.innerHTML = '<div class="empty">加载失败</div>'; return; }
    const d = r.data, sites = d.sites || [];
    renderVisitBreakdown(d);
    if(!sites.length && !d.legacy){
      box.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    const known = sites.reduce((a,b) => a + (Number(b.range)||0), 0);
    const denom = Math.max(1, Number(d.rangeTotal) || known);
    const pct = v => ((Number(v)||0) / denom * 100);
    const sel = visitSite;
    let h = '<div style="overflow-x:auto"><table class="wk-table"><thead><tr>' +
      '<th>来源站点</th><th style="text-align:right">今日</th><th style="text-align:right">近 '+esc(String(visitDays))+' 天</th>' +
      '<th style="text-align:right">累计</th><th style="text-align:right">区间占比</th><th style="min-width:110px">占比</th>' +
      '<th style="text-align:right">操作</th>' +
      '</tr></thead><tbody>';
    // 全部站点：点击可取消单个站点的筛选
    h += '<tr class="visit-site-row' + (sel ? '' : ' active') + '" data-site="" onclick="selectVisitSite(this.dataset.site)">' +
      '<td><b>全部站点</b></td>' +
      '<td style="text-align:right">' + (Number(d.todayAll)||0) + '</td>' +
      '<td style="text-align:right">' + (Number(d.rangeTotal)||0) + '</td>' +
      '<td style="text-align:right">' + (Number(d.totalAll)||0) + '</td>' +
      '<td style="text-align:right">100.0%</td>' +
      '<td><div style="height:6px;border-radius:3px;background:var(--hover)"><div style="height:6px;border-radius:3px;background:var(--accent);width:100%"></div></div></td>' +
      '<td style="text-align:right"><span style="color:var(--muted)">-</span></td>' +
      '</tr>';
    sites.forEach(s => {
      const p = pct(s.range);
      h += '<tr class="visit-site-row' + (sel === s.site ? ' active' : '') + '" data-site="' + esc(s.site) + '" onclick="selectVisitSite(this.dataset.site)" title="点击查看该站点的访问趋势">' +
        '<td><b>' + esc(s.site) + '</b></td>' +
        '<td style="text-align:right">' + (Number(s.today)||0) + '</td>' +
        '<td style="text-align:right">' + (Number(s.range)||0) + '</td>' +
        '<td style="text-align:right">' + (Number(s.total)||0) + '</td>' +
        '<td style="text-align:right">' + p.toFixed(1) + '%</td>' +
        '<td><div style="height:6px;border-radius:3px;background:var(--hover)"><div style="height:6px;border-radius:3px;background:var(--accent);width:' + Math.min(100,p).toFixed(1) + '%"></div></div></td>' +
        '<td style="text-align:right"><button class="wk-btn danger sm" data-site="' + esc(s.site) + '" onclick="event.stopPropagation();deleteVisitSite(this.dataset.site)" title="删除该站点历史访问明细，数量归入未分类">删除</button></td>' +
        '</tr>';
    });
    if(d.legacy > 0){
      h += '<tr><td><span style="color:var(--muted)">未分类</span></td>' +
        '<td style="text-align:right">-</td>' +
        '<td style="text-align:right">' + Number(d.legacy) + '</td>' +
        '<td style="text-align:right">-</td>' +
        '<td style="text-align:right">' + pct(d.legacy).toFixed(1) + '%</td>' +
        '<td><div style="height:6px;border-radius:3px;background:var(--hover)"><div style="height:6px;border-radius:3px;background:var(--muted);width:' + Math.min(100,pct(d.legacy)).toFixed(1) + '%"></div></div></td>' +
        '<td style="text-align:right"><span style="color:var(--muted)">-</span></td>' +
        '</tr>';
    }
    h += '</tbody></table></div>';
    h += '<p class="wk-label" style="margin:8px 0 0">区间总访问：<b>' + (Number(d.rangeTotal)||0) + '</b>　站点合计：<b>' + known + '</b></p>';
    box.innerHTML = h;
  }catch(e){
    box.innerHTML = '<div class="empty">加载失败</div>';
  }
}

// 点击来源站点：折线图切换到该站点（再次点击同一站点或点「全部站点」恢复全部）
function selectVisitSite(site){
  const s = String(site || '');
  visitSite = (s && visitSite === s) ? '' : s;
  loadVisit();
}

// 删除某个站点的历史访问明细：只删站点分类明细，总量仍保留 → 自动归入「未分类」
async function deleteVisitSite(site){
  const s = String(site || '');
  if(!s) return;
  if(!await askConfirm('删除站点「' + s + '」的历史访问明细？\n删除后这部分访问量会归入「未分类」，总访问量保持不变。')) return;
  const r = await api('/admin/api/visit/site?site=' + encodeURIComponent(s), {method:'DELETE'});
  if(r.ok){
    if(visitSite === s) visitSite = '';
    toast('已删除，访问量已归入未分类');
    loadVisit();
  }else{
    toast((r.data && r.data.error) || '删除失败', true);
  }
}

// 快捷按钮：7/30/90/365
function setVisitDays(n){ visitDays = n; const i = $('#visitDays'); if(i) i.value = n; loadVisit(); }
// 自定义天数
function applyVisitDays(){
  const i = $('#visitDays');
  const n = parseInt((i && i.value) || '', 10);
  if(!Number.isFinite(n) || n < 1 || n > 3650){ toast('显示天数需为 1-3650 的整数', true); return; }
  visitDays = n; loadVisit();
}

// ---------- 站点设置（设置标签页：数据保留 + 访客评论开关 + 工作流触发模式）----------
async function loadSiteSettings(){
  try{
    const r = await api('/admin/api/site/settings');
    if(r.ok && r.data){
      const d = r.data;
      const rd = $('#retentionDays'); if(rd) rd.value = d.retention_days;
      const gk = $('#allowGuestComment'); if(gk) gk.checked = !!d.allow_guest_comment;
      const wm = $('#workflowMode'); if(wm) wm.value = d.workflow_mode==='manual' ? 'manual' : 'auto';
    }
  }catch(e){}
}
async function saveSiteSettings(){
  const rd = $('#retentionDays');
  const n = parseInt((rd && rd.value) || '', 10);
  if(!Number.isFinite(n) || n < 1 || n > 3650){ toast('保留天数需为 1-3650 的整数', true); return; }
  const gk = $('#allowGuestComment');
  const payload = { retention_days: n, allow_guest_comment: !!(gk && gk.checked) };
  const r = await api('/admin/api/site/settings', { method:'PUT', body: JSON.stringify(payload) });
  const msg = $('#siteMsg');
  if(r.ok){
    toast('设置已保存');
    if(msg){ msg.className='msg ok'; msg.textContent='设置已保存'; }
  } else {
    const err = (r.data && r.data.error) || '保存失败';
    toast(err, true);
    if(msg){ msg.className='msg err'; msg.textContent=err; }
  }
}
// 后台设置：工作流触发模式（自动=发文/删文后自动构建；手动=提示后由管理员手动运行）
async function saveWorkflowMode(){
  const sel = $('#workflowMode');
  const mode = (sel && sel.value) === 'manual' ? 'manual' : 'auto';
  const r = await api('/admin/api/site/settings', { method:'PUT', body: JSON.stringify({ workflow_mode: mode }) });
  const msg = $('#adminMsg');
  if(r.ok && r.data && r.data.ok){
    toast('工作流触发模式已保存');
    if(msg){
      msg.className='msg ok';
      msg.textContent = mode==='manual'
        ? '已保存：手动模式（发文/删文后需手动运行工作流，会在日志位置提示）'
        : '已保存：自动模式（发文/删文后自动运行工作流更新站点）';
    }
  } else {
    const err = (r.data && r.data.error) || '保存失败';
    toast(err, true);
    if(msg){ msg.className='msg err'; msg.textContent=err; }
  }
}

// 管理员账号：修改用户名 / 密码（独立管理员体系，两者都可独立修改）
async function changeAdminAccount(){
  const m = $('#pwMsg');
  const u = ($('#acUser').value||'').trim();
  const o = $('#pwOld').value, n = $('#pwNew').value, n2 = $('#pwNew2').value;
  const err = t => { if(m){ m.className='msg err'; m.textContent=t; } };
  if(!o){ err('请输入旧密码以验证身份'); return; }
  if(n !== n2){ err('两次输入的新密码不一致'); return; }
  if(!u && !n){ err('没有需要修改的内容'); return; }
  const payload = { old_password:o };
  if(u) payload.new_username = u;
  if(n) payload.new_password = n;
  const r = await api('/api/admin/account', { method:'POST', body: JSON.stringify(payload) });
  if(r.status === 401){ redirectLogin(); return; }
  if(r.ok && r.data && r.data.ok){
    const nu = r.data.username || u;
    if(m){ m.className='msg ok'; m.textContent='已保存，下次登录使用新用户名 / 密码'; }
    $('#pwOld').value=''; $('#pwNew').value=''; $('#pwNew2').value='';
    const au=$('#acUser'); if(au) au.value=nu;
    const un=$('#userName'); if(un) un.textContent=nu||'管理员';
    toast('管理员账号已保存');
  } else {
    err((r.data && r.data.error) || '修改失败');
  }
}

// ---------- AI 设置（OpenAI 兼容接口：配置 / 测试 / 模型列表 / 前端代理）----------
let aiModels = [];   // 拉取到的全部模型
let aiPicked = [];   // 已选入的模型（保存后可被 AI 助手切换）
let aiCfModels = [];     // Cloudflare 可用模型（获取到或已保存的）
let aiCfPicked = [];     // 勾选启用的 Cloudflare 模型
let aiCfEnabledCfg = false; // 是否启用 Cloudflare Workers AI（聊天页用于显示额度）
const aiVal = id => { const el=$('#'+id); return el ? el.value : ''; };
// 拼接 OpenAI 兼容地址：结尾无 /vN 时自动补 /v1（与后端 aiEndpoint 逻辑一致）
function aiJoin(base, path){
  let b = String(base || '').trim();
  while(b.slice(-1) === '/') b = b.slice(0, -1);
  if(!b) return '';
  const seg = b.split('/').pop() || '';
  const c0 = seg.charAt(0), c1 = seg.charAt(1);
  const isVer = c0 === 'v' && c1 >= '0' && c1 <= '9';
  if(!isVer) b += '/v1';
  return b + path;
}
// 前端直连所需的密钥：优先输入框，其次取已保存的
async function resolveAiKey(formKey){
  if(formKey) return formKey;
  try{ const r = await api('/admin/api/ai/key'); if(r.ok && r.data && r.data.apiKey) return r.data.apiKey; }catch(e){}
  return '';
}
function aiProxyOn(){ const el = $('#aiClientProxy'); return !!(el && el.checked); }
// 聊天页是否启用前端代理（跟随设置中已保存的配置）
function aiChatProxyOn(){ return !!aiChatProxy; }
// 前端直连所需的 API 地址：优先设置页输入框（支持未保存），其次后端已保存配置
async function resolveAiBase(){
  const v = aiVal('aiBaseUrl').trim();
  if(v) return v;
  try{ const r = await api('/admin/api/ai/settings'); if(r.ok && r.data && r.data.baseUrl) return r.data.baseUrl; }catch(e){}
  return '';
}
async function loadAiSettings(){
  try{
    const r = await api('/admin/api/ai/settings');
    if(r.ok && r.data){
      const d = r.data;
      const bu = $('#aiBaseUrl'); if(bu) bu.value = d.baseUrl || '';
      const cp = $('#aiClientProxy'); if(cp) cp.checked = !!d.clientProxy;
      const pm = $('#aiPermission'); if(pm) pm.value = d.permission || 'safe';
      aiPicked = Array.isArray(d.models) && d.models.length ? d.models.slice() : (d.model ? [String(d.model)] : []);
      aiSyncModelsToText();
      renderAiModels();
      const pr = $('#aiPrompt'); if(pr) pr.value = d.prompt || d.defaultPrompt || '';
      const k = $('#aiApiKey');
      if(k){ k.value = ''; k.placeholder = d.hasKey ? '已保存（留空表示不修改）' : '未设置'; }
      // Cloudflare Workers AI（部署工作流已注入账户/令牌时无需手动填写）
      aiCfEnabledCfg = !!d.cfEnabled;
      const ce = $('#aiCfEnabled'); if(ce) ce.checked = aiCfEnabledCfg || (!!d.cfFromEnv && !(d.cfModels||[]).length);
      const ca = $('#aiCfAccountId');
      if(ca){
        ca.value = d.cfAccountId || '';
        ca.placeholder = d.cfFromEnv ? ('已使用部署账户：' + String(d.cfEnvAccountId || '').slice(0, 8) + '…（留空即可）') : '账户 ID（32 位十六进制）';
      }
      const ck = $('#aiCfApiKey');
      if(ck){
        ck.value = '';
        ck.placeholder = d.cfFromEnv ? '已使用部署令牌（留空即可）' : (d.hasCfKey ? '已保存（留空表示不修改）' : '未设置');
      }
      aiCfPicked = Array.isArray(d.cfModels) ? d.cfModels.slice() : [];
      if(!aiCfModels.length) aiCfModels = aiCfPicked.slice();
      const cfOn = ce ? ce.checked : aiCfEnabledCfg;
      aiCfToggle(cfOn);
      // 未启用但已有部署凭据时也预先查一次额度，方便直接看到剩余用量
      if(!cfOn && d.cfFromEnv) aiCfQuota(false);
    }
  }catch(e){}
}
async function saveAiSettings(){
  aiSyncModelsFromText(); // 以文本框为准（可能刚编辑过还没失焦）
  const picked = aiPicked.slice();
  // 没有独立的「默认模型」：以第一个已选模型作为助手默认，其余可在助手里切换
  const payload = {
    baseUrl: aiVal('aiBaseUrl').trim(),
    apiKey: aiVal('aiApiKey'),
    model: picked[0] || '',
    models: picked,
    prompt: aiVal('aiPrompt'),
    clientProxy: aiProxyOn(),
    permission: aiVal('aiPermission') || 'safe'
  };
  const r = await api('/admin/api/ai/settings', { method:'PUT', body: JSON.stringify(payload) });
  const msg = $('#aiMsg');
  if(r.ok){
    toast('AI 配置已保存');
    if(msg){ msg.className='msg ok'; msg.textContent='AI 配置已保存'; }
    const k = $('#aiApiKey'); if(k) k.value='';
    loadAiSettings();
  } else {
    const err = (r.data && r.data.error) || '保存失败';
    toast(err, true);
    if(msg){ msg.className='msg err'; msg.textContent=err; }
  }
}
// ---------- Cloudflare Workers AI（模型勾选 / 额度）----------
function aiCfToggle(on){
  const box = $('#aiCfBox'); if(box) box.style.display = on ? '' : 'none';
  if(on){ aiCfRenderModels(); aiCfQuota(false); }
}
// 最近一次查到的今日额度（Neurons）：AI 设置与 AI 助手共用
let aiCfQuotaState = null;
function aiCfFmt(n){
  return String(Number(n) || 0).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
}
// AI 助手模型下拉里「Cloudflare Workers AI」分组标题（带剩余额度）
function aiCfGroupLabel(){
  const s = aiCfQuotaState;
  return s ? ('Cloudflare Workers AI（剩余 ' + aiCfFmt(s.left) + ' / ' + aiCfFmt(s.limit) + '）') : 'Cloudflare Workers AI';
}
// 把额度同时同步到：设置页额度框 / 设置页顶部 / 助手底部提示 / 助手模型分组标题
function aiCfApplyQuota(used, limit, left){
  aiCfQuotaState = { used: Number(used) || 0, limit: Number(limit) || 10000, left: Number(left) || 0 };
  const s = aiCfQuotaState;
  const box = $('#aiCfQuotaBox');
  if(box) box.textContent = '今日已用 ' + aiCfFmt(s.used) + ' / ' + aiCfFmt(s.limit) + ' Neurons，剩余 ' + aiCfFmt(s.left) + '（UTC 00:00 重置）';
  const hint = $('#aiCfQuotaHint');
  if(hint){
    hint.style.display = '';
    hint.textContent = 'CF 额度 剩余 ' + aiCfFmt(s.left) + ' / ' + aiCfFmt(s.limit);
    hint.title = '今日已用 ' + aiCfFmt(s.used) + ' Neurons，UTC 00:00 重置；点击刷新';
  }
  const top = $('#aiCfQuotaTop');
  if(top){
    top.style.display = '';
    top.textContent = '『Cloudflare Workers AI』今日剩余 ' + aiCfFmt(s.left) + ' / ' + aiCfFmt(s.limit) + ' Neurons（UTC 00:00 重置，点击刷新）';
    top.title = '今日已用 ' + aiCfFmt(s.used) + ' Neurons；点击刷新';
  }
  const g = document.querySelector('#aiChatModel optgroup[data-cfgroup]');
  if(g) g.label = aiCfGroupLabel();
}
// 额度查询失败时，把错误提示到各处（不改动已拿到的剩余额度）
function aiCfQuotaError(err){
  const box = $('#aiCfQuotaBox'); if(box) box.textContent = err;
  const hint = $('#aiCfQuotaHint');
  if(hint){ hint.style.display = ''; hint.textContent = 'CF 额度：' + err; hint.title = err; }
  const top = $('#aiCfQuotaTop');
  if(top){ top.style.display = ''; top.textContent = '『Cloudflare Workers AI』额度：' + err; top.title = err; }
}
// 勾选 / 取消勾选某个 Cloudflare 模型
function aiCfToggleModel(name, on){
  const i = aiCfPicked.indexOf(name);
  if(on && i < 0) aiCfPicked.push(name);
  if(!on && i >= 0) aiCfPicked.splice(i, 1);
  aiCfRenderModels();
}
function aiCfPickAll(){
  const q = String(aiVal('aiCfModelSearch') || '').trim().toLowerCase();
  const list = q ? aiCfModels.filter(m => m.toLowerCase().indexOf(q) >= 0) : aiCfModels;
  list.forEach(m => { if(aiCfPicked.indexOf(m) < 0) aiCfPicked.push(m); });
  aiCfRenderModels();
}
function aiCfPickNone(){ aiCfPicked = []; aiCfRenderModels(); }
function aiCfRenderModels(){
  const box = $('#aiCfModelList'); if(!box) return;
  const q = String(aiVal('aiCfModelSearch') || '').trim().toLowerCase();
  const list = q ? aiCfModels.filter(m => String(m).toLowerCase().indexOf(q) >= 0) : aiCfModels;
  if(!list.length){
    box.innerHTML = '<span class="wk-label" style="margin:0">' +
      (aiCfModels.length ? '没有匹配「' + esc(q) + '」的模型' : '尚未获取模型：保存配置后点「获取模型列表」') + '</span>';
    return;
  }
  box.innerHTML = list.map(function(m){
    const on = aiCfPicked.indexOf(m) >= 0;
    return '<label class="wk-label" style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer;font-size:12px;padding:3px 8px;border:1px solid ' +
      (on ? 'var(--accent)' : 'var(--border)') + ';border-radius:3px;white-space:nowrap">' +
      '<input type="checkbox" style="width:auto" ' + (on ? 'checked' : '') +
      ' onchange="aiCfToggleModel(this.dataset.m,this.checked)" data-m="' + esc(m) + '">' +
      '<span>' + esc(m) + '</span></label>';
  }).join('');
}
// 保存 Cloudflare 配置（勾选的模型一并保存）
async function aiCfSave(){
  const msg = $('#aiCfMsg');
  const payload = {
    cfEnabled: !!($('#aiCfEnabled') || {}).checked,
    cfAccountId: aiVal('aiCfAccountId').trim(),
    cfApiKey: aiVal('aiCfApiKey'),
    cfModels: aiCfPicked.slice(),
  };
  if(msg){ msg.className = 'msg'; msg.textContent = '保存中...'; }
  const r = await api('/admin/api/ai/settings', { method:'PUT', body: JSON.stringify(payload) });
  if(r.ok){
    toast('Cloudflare AI 配置已保存');
    if(msg){ msg.className='msg ok'; msg.textContent='Cloudflare AI 配置已保存'; }
    const k = $('#aiCfApiKey'); if(k) k.value = '';
    await loadAiSettings();
  } else {
    const err = (r.data && r.data.error) || '保存失败';
    if(msg){ msg.className='msg err'; msg.textContent = err; }
    toast(err, true);
  }
}
// 拉取 Cloudflare 模型列表（先用已保存的 Account ID / 令牌）
async function aiCfLoadModels(){
  const msg = $('#aiCfMsg');
  if(msg){ msg.className='msg'; msg.textContent='获取中...'; }
  try{
    const r = await api('/admin/api/ai/cf/models');
    if(r.ok && r.data && r.data.ok){
      aiCfModels = Array.isArray(r.data.models) ? r.data.models : [];
      // 已保存但本次未返回的模型保留在勾选里，避免被静默丢弃
      aiCfRenderModels();
      if(msg){ msg.className='msg ok'; msg.textContent='共获取到 ' + aiCfModels.length + ' 个模型，勾选后点「保存 Cloudflare 配置」'; }
    } else {
      const err = (r.data && r.data.error) || '获取失败';
      if(msg){ msg.className='msg err'; msg.textContent = err; }
      toast(err, true);
    }
  }catch(e){
    if(msg){ msg.className='msg err'; msg.textContent='获取失败'; }
    toast('获取失败', true);
  }
}
// 查询今日 Neurons 额度（免费 10000/天，UTC 00:00 重置）
async function aiCfQuota(notify){
  try{
    const r = await api('/admin/api/ai/cf/quota');
    if(r.ok && r.data && r.data.ok){
      const d = r.data;
      const used = Number(d.used) || 0, limit = Number(d.limit) || 10000, left = Number(d.remaining) || 0;
      aiCfApplyQuota(used, limit, left);
      if(notify) toast('今日已用 ' + aiCfFmt(used) + ' Neurons，剩余 ' + aiCfFmt(left));
    } else {
      const err = (r.data && r.data.error) || '获取额度失败';
      aiCfQuotaError(err);
      if(notify) toast(err, true);
    }
  }catch(e){}
}
// 测试连通性：只用第一个已选模型发一个最小请求
async function testAiSettings(){
  const msg = $('#aiMsg');
  aiSyncModelsFromText();
  const model = aiPicked[0] || '';
  if(!model){
    if(msg){ msg.className='msg err'; msg.textContent='请先填写或勾选一个模型'; }
    toast('请先填写或勾选一个模型', true);
    return;
  }
  if(msg){ msg.className='msg'; msg.textContent='测试中...'; }
  toast('测试中...');
  const base = aiVal('aiBaseUrl').trim();
  const key = aiVal('aiApiKey');
  try{
    let elapsed = null, reply = '', err = '';
    if(aiProxyOn()){
      // 前端代理：浏览器直连服务商（绕过 Cloudflare 出网限制）
      const k = await resolveAiKey(key);
      const t0 = Date.now();
      const resp = await fetch(aiJoin(base, '/chat/completions'), {
        method:'POST',
        headers: Object.assign({'Content-Type':'application/json'}, k ? {Authorization:'Bearer ' + k} : {}),
        body: JSON.stringify({ model: model, messages:[{role:'user', content:'你好，这是一条连通性测试消息，请回复一句话确认。'}], max_tokens:32 })
      });
      elapsed = Date.now() - t0;
      const d = await resp.json().catch(()=>({}));
      if(resp.ok){
        reply = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
      } else {
        err = (d.error && (d.error.message || d.error)) || ('HTTP ' + resp.status);
      }
    } else {
      const r = await api('/admin/api/ai/test', { method:'POST', body: JSON.stringify({ baseUrl: base, apiKey: key, model: model }) });
      const d = (r.data || {});
      if(r.ok && d.ok){ elapsed = d.elapsed; reply = d.reply || ''; }
      else err = d.error || '测试失败';
    }
    if(err){
      toast('测试失败：' + err, true);
      if(msg){ msg.className='msg err'; msg.textContent='测试失败（' + model + '）：' + err; }
    } else {
      toast('连接成功（' + (elapsed == null ? '-' : elapsed) + 'ms）');
      if(msg){ msg.className='msg ok'; msg.textContent='连接成功（' + model + '），耗时 ' + (elapsed == null ? '-' : elapsed) + 'ms；回复：' + (reply || '（空）'); }
    }
  }catch(e){
    const hint = aiProxyOn() ? '（前端代理直连失败，可能是服务商未开放跨域/CORS）' : '';
    toast('测试失败', true);
    if(msg){ msg.className='msg err'; msg.textContent='测试失败（' + model + '）：' + ((e && e.message) ? e.message : e) + hint; }
  }
}
async function loadAiModels(){
  const box = $('#aiModelList');
  const msg = $('#aiMsg');
  if(box) box.innerHTML = '<span class="wk-label" style="margin:0">加载中...</span>';
  const base = aiVal('aiBaseUrl').trim();
  const key = aiVal('aiApiKey');
  try{
    let models = null, err = '';
    if(aiProxyOn()){
      const k = await resolveAiKey(key);
      const resp = await fetch(aiJoin(base, '/models'), { headers: Object.assign({Accept:'application/json'}, k ? {Authorization:'Bearer ' + k} : {}) });
      const d = await resp.json().catch(()=>({}));
      if(resp.ok){
        const list = Array.isArray(d.data) ? d.data : (Array.isArray(d) ? d : []);
        models = list.map(x => (typeof x === 'string' ? x : (x && x.id))).filter(Boolean);
      } else {
        err = (d.error && (d.error.message || d.error)) || ('HTTP ' + resp.status);
      }
    } else {
      const r = await api('/admin/api/ai/models', { method:'POST', body: JSON.stringify({ baseUrl: base, apiKey: key }) });
      const d = (r.data || {});
      if(r.ok && d.ok) models = Array.isArray(d.models) ? d.models : [];
      else err = d.error || '获取失败';
    }
    if(models){
      // 去重
      const seen = Object.create(null), uniq = [];
      models.forEach(function(m){ if(m && !seen[m]){ seen[m] = 1; uniq.push(m); } });
      aiModels = uniq;
      // 重新拉取后清掉已不在列表里的旧选择，避免「已选 N 个」凭空多出来
      const set = Object.create(null);
      uniq.forEach(function(m){ set[m] = 1; });
      const kept = aiPicked.filter(function(m){ return set[m]; });
      const dropped = aiPicked.length - kept.length;
      aiPicked = kept;
      aiSyncModelsToText();
      renderAiModels();
      let tip = '共获取到 ' + aiModels.length + ' 个模型';
      if(dropped > 0) tip += '，已移除 ' + dropped + ' 个列表中不存在的旧模型';
      if(msg){ msg.className='msg ok'; msg.textContent = tip + '，可勾选后保存为可选模型'; }
    } else {
      aiModels = [];
      renderAiModels();
      if(msg){ msg.className='msg err'; msg.textContent='获取失败：' + err; }
      toast('获取模型失败：' + err, true);
    }
  }catch(e){
    aiModels = [];
    renderAiModels();
    const hint = aiProxyOn() ? '（前端代理直连失败，可能是服务商未开放跨域/CORS）' : '';
    if(msg){ msg.className='msg err'; msg.textContent='获取失败：' + ((e && e.message) ? e.message : e) + hint; }
    toast('获取模型失败', true);
  }
}
function renderAiModels(){
  const box = $('#aiModelList');
  const cnt = $('#aiPickedCount');
  if(cnt) cnt.textContent = aiPicked.length ? ('已选 ' + aiPicked.length + ' 个模型') : '尚未选择模型';
  if(!box) return;
  // 未重新拉取列表时，已保存的可选模型也要显示出来（避免看起来像没保存）
  if(!aiModels.length){
    if(!aiPicked.length){ box.innerHTML = '<span class="wk-label" style="margin:0">未获取到模型，请先点「获取模型列表」</span>'; return; }
    aiModels = aiPicked.slice();
  }
  const qEl = $('#aiModelSearch');
  const q = (qEl && qEl.value ? qEl.value : '').trim().toLowerCase();
  const list = q ? aiModels.filter(m => String(m).toLowerCase().indexOf(q) >= 0) : aiModels;
  if(!list.length){ box.innerHTML = '<span class="wk-label" style="margin:0">没有匹配「' + esc(q) + '」的模型</span>'; return; }
  box.innerHTML = list.map(m => {
    const on = aiPicked.indexOf(m) >= 0;
    return '<label class="ai-pick' + (on ? ' on' : '') + '">' +
      '<input type="checkbox"' + (on ? ' checked' : '') + ' onchange="toggleAiModel(&#39;' + esc(m) + '&#39;)">' +
      '<span class="ai-pick-n">' + esc(m) + '</span></label>';
  }).join('');
}
// 「已选的模型」文本框 → 勾选列表。用户正在输入，不回写文本框以免打断光标
function aiSyncModelsFromText(){
  const el = $('#aiModelsText'); if(!el) return;
  const seen = {}, arr = [];
  String(el.value || '').split(/[,，]/).forEach(function(s){
    const v = s.trim();
    if(!v || seen[v]) return;
    seen[v] = 1; arr.push(v);
  });
  aiPicked = arr;
  renderAiModels();
}
// 勾选列表 → 「已选的模型」文本框（点勾选框 / 全选 / 清空时调用）
function aiSyncModelsToText(){
  const el = $('#aiModelsText'); if(el) el.value = aiPicked.join(', ');
}
function toggleAiModel(m){
  const i = aiPicked.indexOf(m);
  if(i >= 0) aiPicked.splice(i, 1); else aiPicked.push(m);
  aiSyncModelsToText();
  renderAiModels();
}
function aiPickVisible(){
  const qEl = $('#aiModelSearch');
  const q = (qEl && qEl.value ? qEl.value : '').trim().toLowerCase();
  return q ? aiModels.filter(m => String(m).toLowerCase().indexOf(q) >= 0) : aiModels.slice();
}
function aiPickAll(){
  aiPickVisible().forEach(m => { if(aiPicked.indexOf(m) < 0) aiPicked.push(m); });
  aiSyncModelsToText();
  renderAiModels();
}
function aiPickNone(){
  aiPicked = [];
  aiSyncModelsToText();
  renderAiModels();
}

// ---------- AI 助手（聊天：流式输出 + 历史记录）----------
let aiConvId = null;          // 当前会话 id（null 表示新对话，首次保存后回填）
let aiPendingConv = null;     // 从 URL（/admin/ai/<id>）解析出的待打开会话 id
let aiConvMessages = [];      // [{role, content}]
let aiStreaming = false;      // 是否正在流式接收
let aiAbort = null;           // 中止控制器
let aiUsagePending = null;    // 进行中一轮的 usage（尚未写入消息，供「i」面板实时展示）
let aiPerfPending = null;     // 进行中一轮的耗时（首字延迟等，供「i」面板实时展示）
let aiChatProxy = false;      // 前端代理（取自设置中已保存的配置）
let aiPrompt = '';            // AI 提示词（系统提示）
let aiPromptDefault = '';     // 内置默认系统提示词（「还原默认」用）
let aiThinkLevel = 'off';     // 思考强度：off / low / medium / high（非 off 时作为 reasoning_effort 下发）
let aiThink = false;          // 是否开启思考（由 aiThinkLevel 派生）
let aiConvTitle = '';         // 当前会话标题（重命名后使用；为空时按首条用户消息生成）
let aiPermission = 'safe';    // 权限级别：safe 安全访问 / important 重要确认 / all 全部确认 / full 完全访问
let aiTools = null;           // 工具定义（权限非安全时加载）
let aiToolsHint = '';         // 工具使用说明（含密钥占位符名称）
let aiToolDanger = [];        // 危险工具名单
const AI_MAX_ROUNDS = 50;     // 单轮AI回复允许的最大工具调用轮数（最后一轮不再给工具，强制收尾）

async function loadAiChat(){
  // 进入页面：加载历史会话列表 + 模型下拉（可选模型）
  // 若 URL 带会话 id，先立刻显示「加载中」，避免打开期间标题/内容空白
  if(aiPendingConv) aiShowLoading('加载中…');
  loadAiConversations();
  aiInitSide();
  aiLoadPrefs();
  try{
    const r = await api('/admin/api/ai/settings');
    const d = (r.ok && r.data) ? r.data : {};
    aiChatProxy = !!d.clientProxy;
    aiPromptDefault = String(d.defaultPrompt || '').trim();
    aiPrompt = String(d.prompt || '').trim() || aiPromptDefault;
    aiPermission = d.permission || 'safe';
    const pm = $('#aiChatPermission'); if(pm) pm.value = aiPermission;
    const sel = $('#aiChatModel');
    if(sel){
      const list = (Array.isArray(d.models) && d.models.length) ? d.models : (d.model ? [d.model] : []);
      const cfList = (d.cfEnabled && Array.isArray(d.cfModels)) ? d.cfModels : [];
      aiCfEnabledCfg = !!d.cfEnabled;
      const sig = JSON.stringify([list, cfList]);
      // 仅在可选模型发生变化时重建下拉（分成 Cloudflare / 自定义两栏）
      if(sel.dataset.sig !== sig){
        sel.dataset.sig = sig;
        let h = '';
        if(cfList.length) h += '<optgroup label="' + esc(aiCfGroupLabel()) + '" data-cfgroup="1">' + cfList.map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('') + '</optgroup>';
        if(list.length) h += '<optgroup label="自定义配置">' + list.map(m => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('') + '</optgroup>';
        sel.innerHTML = h || '<option value="">（未配置模型）</option>';
      }
      const allList = cfList.concat(list);
      // 记住用户在该聊天页选择的模型：优先恢复上次选择，否则用默认（第一个已选模型）
      let saved = '';
      try{ saved = localStorage.getItem('aiChatModel') || ''; }catch(e){}
      const want = (saved && allList.indexOf(saved) >= 0)
        ? saved
        : (d.model && allList.indexOf(d.model) >= 0 ? d.model : (allList[0] || ''));
      sel.value = want;
      if(d.cfEnabled || d.cfFromEnv) aiCfQuota(false);
    }
    aiUpdateHint();
  }catch(e){}
  aiLoadTools();
  // URL 带会话 id（/admin/ai/<id>）时，进入页面即打开该对话
  if(aiPendingConv){ const id = aiPendingConv; aiPendingConv = null; aiOpenConv(id); }
}
// 按权限加载工具定义与使用说明（安全访问不加载工具，AI 只能对话）
async function aiLoadTools(){
  aiTools = null; aiToolsHint = ''; aiToolDanger = [];
  if(aiPermission === 'safe'){ aiUpdateHint(); return; }
  try{
    const r = await api('/admin/api/ai/tools');
    if(r.ok && r.data){
      aiTools = Array.isArray(r.data.tools) ? r.data.tools : [];
      aiToolsHint = String(r.data.hint || '');
      aiToolDanger = Array.isArray(r.data.danger) ? r.data.danger : [];
    }
  }catch(e){}
  aiUpdateHint();
}
// 收起 / 展开会话侧边栏（手机端默认收起，从侧面滑出；选择会被记住）
function aiSetSide(off){
  const el = document.querySelector('.ai-chat'); if(!el) return;
  el.classList.toggle('side-off', off);
  const btn = $('#aiSideToggle'); if(btn) btn.style.display = off ? '' : 'none';
}
function aiToggleSide(){
  const el = document.querySelector('.ai-chat'); if(!el) return;
  const off = !el.classList.contains('side-off');
  aiSetSide(off);
  try{ localStorage.setItem('aiSideOff', off ? '1' : '0'); }catch(e){}
}
function aiInitSide(){
  let pref = null;
  try{ pref = localStorage.getItem('aiSideOff'); }catch(e){}
  aiSetSide(pref === null ? window.innerWidth <= 640 : pref === '1');
}
// 顶栏提示：仅在未配置 AI 时给出引导（权限在输入框下方选择）
async function aiUpdateHint(){
  const hint = $('#aiChatHint'); if(!hint) return;
  // 已启用 Cloudflare Workers AI 时，即使没有自定义接口地址也不算未配置
  if(aiCfEnabledCfg){ hint.textContent = ''; return; }
  const base = await resolveAiBase();
  hint.textContent = base ? '' : '尚未配置 AI，请到「设置 → AI 设置」填写';
}
// 切换权限级别：生效并同步保存到设置
async function aiSetPermission(v){
  aiPermission = v || 'safe';
  const sel = $('#aiChatPermission'); if(sel && sel.value !== aiPermission) sel.value = aiPermission;
  aiLoadTools();
  try{ await api('/admin/api/ai/settings', { method:'PUT', body: JSON.stringify({ permission: aiPermission }) }); }catch(e){}
}
// 记录用户在聊天页选择的模型（localStorage），刷新后仍生效
function aiSetChatModel(v){
  try{ localStorage.setItem('aiChatModel', String(v || '')); }catch(e){}
}
// 读取本地偏好：思考强度、全屏
function aiLoadPrefs(){
  let lv = 'off';
  try{ lv = localStorage.getItem('aiThinkLevel') || 'off'; }catch(e){}
  aiSetThink(lv);
  try{ if(localStorage.getItem('aiFull') === '1') aiSetFull(true); }catch(e){}
}
// 思考强度：off 关闭；low/medium/high 作为 reasoning_effort 发给服务商
function aiSetThink(lv){
  lv = ['off','low','medium','high'].indexOf(lv) >= 0 ? lv : 'off';
  aiThinkLevel = lv;
  aiThink = lv !== 'off';
  const sel = $('#aiChatThink'); if(sel && sel.value !== lv) sel.value = lv;
  try{ localStorage.setItem('aiThinkLevel', lv); }catch(e){}
}
function aiSetFull(on){
  const el = document.querySelector('.ai-chat'); if(!el) return;
  el.classList.toggle('ai-full', !!on);
  const b = $('#aiFullBtn'); if(b) b.textContent = on ? '退出全屏' : '全屏';
  aiFitHeight();
}
function aiToggleFull(){
  const el = document.querySelector('.ai-chat'); if(!el) return;
  const box = $('#aiMessages');
  const wasStick = aiStick;             // 切换前是否停在底部
  const keepTop = box ? box.scrollTop : 0;
  const on = !el.classList.contains('ai-full');
  aiSetFull(on);
  try{ localStorage.setItem('aiFull', on ? '1' : '0'); }catch(e){}
  // 全屏切换只改变容器大小，不应改变用户正在看的位置：之前在底部就继续贴底，否则保持原滚动位置
  if(wasStick){ aiStick = true; scrollAiBottom(); }
  else if(box){ aiStick = false; try{ box.scrollTop = keepTop; }catch(e){} }
}
// 手机端：把聊天卡片高度精确设为「卡片顶部到屏幕底部」，确保输入框紧贴屏幕底边
function aiFitHeight(){
  const el = document.querySelector('.ai-chat'); if(!el) return;
  if(window.innerWidth > 640 || el.classList.contains('ai-full')){ el.style.height = ''; return; }
  const page = $('#page-ai');
  if(page && page.classList.contains('hidden')) return;
  const rect = el.getBoundingClientRect();
  const absTop = rect.top + (window.scrollY || window.pageYOffset || 0);
  const vh = document.documentElement.clientHeight || window.innerHeight;
  el.style.height = Math.max(220, Math.round(vh - absTop)) + 'px';
  scrollAiBottom();
}
// 保存系统提示词（立即生效，改动过大可能导致 AI 不好用）
async function aiSavePrompt(){
  const ta = $('#aiPrompt'); if(!ta) return;
  if(!await askConfirm('保存后立即生效。\\n\\n系统提示词会直接影响 AI 的工具调用与回答方式，改动不当可能导致 AI 无法正常使用，请确认保存。')) return;
  const r = await api('/admin/api/ai/settings', { method:'PUT', body: JSON.stringify({ prompt: ta.value }) });
  if(r.ok && r.data){
    aiPrompt = String(r.data.prompt || '').trim() || aiPromptDefault;
    toast('系统提示词已保存');
  } else toast('保存失败', true);
}
// 还原为内置默认提示词（需再点「保存」才生效）
async function aiResetPrompt(){
  const ta = $('#aiPrompt'); if(!ta) return;
  if(!await askConfirm('还原为内置默认系统提示词？还原后需点「保存」才会生效。')) return;
  ta.value = aiPromptDefault || '';
}
async function loadAiConversations(){
  const box = $('#aiConvList'); if(!box) return;
  // 列表为空（首次加载/尚无数据）时显示加载中，已有内容则不闪烁
  if(!box.querySelector('.ai-conv')) box.innerHTML = '<div class="empty">加载中…</div>';
  try{
    const r = await api('/admin/api/ai/conversations');
    if(!r.ok || !r.data){ box.innerHTML = '<div class="empty">加载失败</div>'; return; }
    const list = (r.data.list || []);
    if(!list.length){ box.innerHTML = '<div class="empty">暂无历史会话</div>'; return; }
    box.innerHTML = list.map(c=>{
      const active = (c.id === aiConvId) ? ' active' : '';
      return '<div class="ai-conv'+active+'" data-id="'+c.id+'" onclick="aiOpenConv('+c.id+')">'+
        '<span class="ai-conv-t">'+esc(c.title || '未命名对话')+'</span>'+
        '<button class="wk-btn ghost sm" onclick="event.stopPropagation();aiDelConv('+c.id+')">删</button>'+
      '</div>';
    }).join('');
  }catch(e){ box.innerHTML = '<div class="empty">加载失败</div>'; }
}
// 加载中/加载失败：顶部标题与消息区同时提示（用户能一眼看到正在加载）
function aiShowLoading(tip){
  const t = $('#aiChatTitle'); if(t) t.textContent = tip || '加载中…';
  const col = $('#aiCol'); if(col) col.innerHTML = '<div class="empty">' + (tip || '加载中…') + '</div>';
}
// 同步地址栏：/admin/ai/<id>（新对话则回到 /admin/ai），刷新后仍停留在当前对话
function aiSyncUrl(){
  try{ history.replaceState(null, '', aiConvId ? ('/admin/ai/' + aiConvId) : '/admin/ai'); }catch(e){}
}
function aiNewChat(){
  if(aiStreaming){ toast('正在回复中，请稍候', true); return; }
  aiConvId = null; aiConvMessages = []; aiConvTitle = ''; aiUsagePending = null; aiPerfPending = null;
  aiStick = true; aiUserHold = false; // 新对话：从底部开始
  aiSetTitle('');
  aiUpdateUsagePop();
  renderAiMessages();
  loadAiConversations();
  aiSyncUrl();
  const i = $('#aiInput'); if(i) i.focus();
}
async function aiOpenConv(id){
  if(aiStreaming){ toast('正在回复中，请稍候', true); return; }
  // 打开会话期间：顶部名字与消息区都显示「加载中」
  aiShowLoading('加载中…');
  const oldId = aiConvId;
  aiConvId = id; // 先高亮，避免列表点击无反馈
  loadAiConversations();
  let r;
  try{
    r = await api('/admin/api/ai/conversation?id=' + id);
  }catch(e){
    aiConvId = oldId;
    aiShowLoading('加载失败');
    toast('加载会话失败：网络错误', true);
    return;
  }
  if(!r.ok || !r.data || !r.data.conversation){
    aiConvId = oldId;
    aiShowLoading('加载失败');
    toast('加载会话失败' + (r.data && r.data.error ? '：' + r.data.error : ''), true);
    loadAiConversations();
    return;
  }
  const c = r.data.conversation;
  aiConvId = c.id;
  aiConvMessages = Array.isArray(c.messages) ? c.messages : [];
  aiConvTitle = c.title || ''; aiUsagePending = null; aiPerfPending = null;
  aiStick = true; aiUserHold = false; // 打开会话：默认从底部看
  aiSetTitle(aiConvTitle);
  aiUpdateUsagePop();
  renderAiMessages();
  aiSyncUrl();
  loadAiConversations();
}
// 顶部标题：空标题时回退到首条用户消息前 30 字
function aiSetTitle(t){
  const firstUser = aiConvMessages.find(m => m.role === 'user');
  const show = (t || (firstUser ? firstUser.content.slice(0, 30) : '') || '新对话');
  const el = $('#aiChatTitle');
  if(el) el.textContent = show;
}
// 重命名当前对话（取首次用户消息作为默认名）
function aiRenameConv(){
  if(aiStreaming){ toast('正在回复中，请稍候', true); return; }
  const firstUser = aiConvMessages.find(m => m.role === 'user');
  const cur = aiConvTitle || (firstUser ? firstUser.content.slice(0, 30) : '新对话');
  const t = prompt('重命名对话', cur);
  if(t === null) return;
  const nt = t.trim().slice(0, 100);
  if(!nt) return;
  aiConvTitle = nt;
  aiSetTitle(nt);
  aiSaveConversation();
}
async function aiDelConv(id){
  if(!await askConfirm('确认删除该会话？')) return;
  const r = await api('/admin/api/ai/conversation?id=' + id, { method:'DELETE' });
  if(r.ok){ if(aiConvId === id) aiNewChat(); else loadAiConversations(); }
  else toast('删除失败', true);
}
// ===== 轻量 Markdown 渲染（先转义再转换，防 XSS）=====
function mdInline(s){
  s = s.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function mdToHtml(src){
  const lines = String(src == null ? '' : src).replace(/\\r\\n?/g, '\\n').split('\\n');
  let out = '', list = null, i = 0;
  function closeList(){ if(list){ out += (list === 'ul' ? '</ul>' : '</ol>'); list = null; } }
  while(i < lines.length){
    const line = lines[i];
    // 代码块
    if(/^\\s*\`\`\`/.test(line)){
      closeList();
      const buf = []; i++;
      while(i < lines.length && !/^\\s*\`\`\`/.test(lines[i])){ buf.push(lines[i]); i++; }
      i++;
      out += '<pre class="md-pre"><code>' + esc(buf.join('\\n')) + '</code></pre>';
      continue;
    }
    if(!line.trim()){ closeList(); i++; continue; }
    // 标题
    let m = line.match(/^(#{1,6})\\s+(.*)$/);
    if(m){ closeList(); const lv = m[1].length; out += '<h' + lv + '>' + mdInline(esc(m[2])) + '</h' + lv + '>'; i++; continue; }
    // 分割线
    if(/^\\s*([-*_])\\1{2,}\\s*$/.test(line)){ closeList(); out += '<hr>'; i++; continue; }
    // 引用
    if(/^\\s*>\\s?/.test(line)){
      closeList();
      const buf = [];
      while(i < lines.length && /^\\s*>\\s?/.test(lines[i])){ buf.push(lines[i].replace(/^\\s*>\\s?/, '')); i++; }
      out += '<blockquote>' + mdInline(esc(buf.join('\\n'))).replace(/\\n/g, '<br>') + '</blockquote>';
      continue;
    }
    // 列表
    const ul = line.match(/^\\s*[-*+]\\s+(.*)$/);
    const ol = line.match(/^\\s*\\d+[.)]\\s+(.*)$/);
    if(ul || ol){
      const want = ul ? 'ul' : 'ol';
      if(list !== want){ closeList(); out += want === 'ul' ? '<ul>' : '<ol>'; list = want; }
      out += '<li>' + mdInline(esc((ul || ol)[1])) + '</li>';
      i++; continue;
    }
    // 段落
    closeList();
    const buf = [line]; i++;
    while(i < lines.length && lines[i].trim() && !/^\\s*(#{1,6}\\s|>|[-*+]\\s|\\d+[.)]\\s|\`\`\`)/.test(lines[i])){ buf.push(lines[i]); i++; }
    out += '<p>' + mdInline(esc(buf.join('\\n'))).replace(/\\n/g, '<br>') + '</p>';
  }
  closeList();
  return out;
}
// 优先使用完整的 GFM 解析器（marked）渲染，缺失时回退到内置轻量渲染；输出均经 DOMPurify 清洗
function renderMd(src){
  const s = String(src == null ? '' : src);
  const M = (typeof window !== 'undefined') ? window.marked : null;
  if(M && typeof M.parse === 'function'){
    try{
      // 兼容不同版本的配置入口（marked.parse 在 v5+ 可直接调用）
      const opts = { gfm:true, breaks:true };
      let html = (typeof M.use === 'function') ? M.parse(s, opts) : M(s, opts);
      // 链接在新标签打开
      html = html.replace(/<a href=/g, '<a target="_blank" rel="noopener noreferrer" href=');
      const D = (typeof window !== 'undefined') ? window.DOMPurify : null;
      if(D && typeof D.sanitize === 'function'){
        html = D.sanitize(html, { ADD_ATTR:['target', 'rel'] });
      }
      return html;
    }catch(e){}
  }
  return mdToHtml(s);
}
// 工具结果：紧凑展示
function aiToolNoteHtml(m){
  const denied = !!(m && m.denied);
  const short = String((m && m.content) == null ? '' : m.content).replace(/\\s+/g, ' ').slice(0, 200);
  return '<div class="ai-tool-note'+(denied?' err':'')+'"><span class="ai-tool-tag">'+
    (denied?'已拒绝':'工具结果')+'</span>'+esc((m && m.name) || '')+(short ? '：' + esc(short) : '')+'</div>';
}
// 折叠块的展开状态（data-k -> 是否展开）。只记录用户手动操作过的块，
// 其余按默认状态：过程块在生成中默认展开、生成结束后默认收起
const aiFoldOpen = {};
// 生成后立即绑定：只记录用户的「点击」操作（程序化 d.open= 不写记忆，
// 否则流式中的自动收起/展开会在生成结束后把过程块永久顶成展开状态）
function aiBindFolds(box){
  box.querySelectorAll('details[data-k]').forEach(function(d){
    const sm = d.querySelector('summary');
    if(sm) sm.addEventListener('click', function(){
      setTimeout(function(){ aiFoldOpen[d.getAttribute('data-k')] = d.open; }, 0);
    });
  });
}
// 折叠块的 open 属性：用户操作过就听用户的，否则用默认值
function aiFoldAttr(key, defOpen){
  const v = aiFoldOpen[key];
  return (v === undefined ? !!defOpen : v) ? ' open' : '';
}
// 程序化设置过程块的展开状态（只改 DOM，不写 aiFoldOpen——那是用户手动操作的记忆）
function aiSetProcOpen(key, open){
  if(!key) return;
  const d = document.querySelector('.ai-proc[data-k="' + key + '"]');
  if(d && d.open !== !!open){ d.open = !!open; scrollAiBottom(); } // 展开/收起过程块会改变高度，跟随状态下立即贴回底部
}
// 注意：流式轮的 proc key 必须与渲染器给「本回合」过程块的 data-k 一致，
// 即回合起点（最后一条用户消息的下标+1）。之前用 aiConvMessages.length，
// 第 2 轮工具调用起两者对不上，导致「开始输出回答自动收起过程块」失效。
function renderAiMessages(){
  const box = $('#aiCol'); if(!box) return;
  // 记录当前滚动位置：用户上滑阅读时，重渲染后要保持在原处（工具调用/流式渲染时尤其容易跳）
  const scroller = $('#aiMessages');
  const keepTop = scroller ? scroller.scrollTop : 0;
  if(!aiConvMessages.length){ box.innerHTML = '<div class="empty">开始和 AI 对话吧</div>'; aiUpdateContinueBar(); return; }
  let html = '';
  let i = 0;
  while(i < aiConvMessages.length){
    const m = aiConvMessages[i] || {};
    if(m.role === 'user'){ html += aiBubbleHtml('user', m.content, i, m); i++; continue; }
    // 一轮 AI 回复：assistant 及其后的 tool 结果合并成一个气泡
    const start = i, turn = [];
    while(i < aiConvMessages.length && (aiConvMessages[i] || {}).role !== 'user'){ turn.push(aiConvMessages[i]); i++; }
    // 正在生成中的最后一轮：过程收起成一行并显示实时状态
    const live = aiStreaming && i >= aiConvMessages.length;
    html += aiTurnHtml(turn, start, live);
  }
  box.innerHTML = html;
  aiBindFolds(box);
  // 生成中：把本回合过程块的内部滚动钉到自身底部——步骤超过 420px 上限后新步骤
  // 落在内部滚动区外，且每次重渲染都会把内部滚动位置归零，多工具时永远看不到最新步骤
  if(aiStreaming){
    const pb = box.querySelector('.ai-msg:last-child .ai-proc-body');
    if(pb){ try{ pb.scrollTop = pb.scrollHeight; }catch(e){} }
  }
  aiUpdateContinueBar();
  // 用户上滑阅读时：重渲染后恢复原滚动位置，避免被拉回底部或顶部
  if(!aiStick && scroller){ try{ scroller.scrollTop = keepTop; }catch(e){} }
  scrollAiBottom();
}
// 撤回：删除该条及其之后的消息，并把该条内容放回输入框
async function aiRecall(i){
  if(aiStreaming){ toast('正在回复中，请稍候', true); return; }
  if(i < 0 || i >= aiConvMessages.length) return;
  const m = aiConvMessages[i] || {};
  if(!await askConfirm('撤回这条及之后的消息？内容会回到输入框。')) return;
  const text = (typeof m.content === 'string') ? m.content : '';
  aiConvMessages = aiConvMessages.slice(0, i);
  renderAiMessages();
  aiSetTitle(aiConvTitle);
  const inp = $('#aiInput'); if(inp){ inp.value = text; inp.focus(); }
  aiSaveConversation();
}
// 复制文本到剪贴板（供 aiCopy / aiCopyTurn 复用）
function aiCopyText(text){
  if(!text){ toast('没有可复制的内容', true); return; }
  const done = function(){ toast('已复制'); };
  const fallback = function(){
    try{
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); toast('已复制');
    }catch(e){ toast('复制失败', true); }
  };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else fallback();
}
// 复制单条消息原始内容（Markdown 源码 / 纯文本）
function aiCopy(i){
  if(i < 0 || i >= aiConvMessages.length) return;
  const m = aiConvMessages[i] || {};
  aiCopyText((typeof m.content === 'string') ? m.content : '');
}
// 复制本轮最终回答（与界面上单独显示的那一段一致，不含过程）
function aiCopyTurn(startIdx){
  let text = '';
  for(let k = startIdx; k < aiConvMessages.length; k++){
    const m = aiConvMessages[k] || {};
    if(m.role === 'user') break;
    if(m.role === 'tool') continue;
    if(m.tool_calls && m.tool_calls.length) continue;
    if(typeof m.content === 'string' && m.content.trim()) text = m.content;
  }
  aiCopyText(text);
}
// 单个工具：一次调用 + 它的结果，默认收起，展开后可见完整参数与返回内容
function aiToolFoldHtml(name, args, r, key){
  const denied = !!(r && r.denied);
  const argsFull = String(args == null ? '' : args).trim();
  const argsBrief = argsFull.replace(/\\s+/g, ' ').slice(0, 120);
  const resFull = r ? String(r.content == null ? '' : r.content).trim() : '';
  let head = '<span class="ai-tool-tag">调用</span>' + esc(name || '');
  if(argsBrief) head += ' <span class="ai-tool-inline">' + esc(argsBrief) + '</span>';
  if(denied) head += ' <span class="ai-tool-tag err">已拒绝</span>';
  let body = '<div class="ai-tool-fold-sec"><div class="ai-proc-tag">参数</div>' +
    '<div class="ai-tool-fold-pre">' + esc(argsFull || '{}') + '</div></div>';
  if(r){
    body += '<div class="ai-tool-fold-sec"><div class="ai-proc-tag">' + (denied ? '已拒绝' : '返回结果') + '</div>' +
      '<div class="ai-tool-fold-pre' + (denied ? ' err' : '') + '">' + esc(resFull || '（空）') + '</div></div>';
  }
  return '<details class="ai-tool-fold" data-k="' + key + '"' + aiFoldAttr(key, false) + '><summary>' +
    head + '</summary><div class="ai-tool-fold-body">' + body + '</div></details>';
}
// 汇总用量：兼容 OpenAI（prompt_tokens_details.cached_tokens）与 DeepSeek（prompt_cache_hit_tokens）
function aiAccUsage(acc, u){
  if(!u || typeof u !== 'object') return;
  acc.has = true;
  acc.prompt += (+u.prompt_tokens || 0);
  acc.completion += (+u.completion_tokens || 0);
  acc.total += (+u.total_tokens || ((+u.prompt_tokens || 0) + (+u.completion_tokens || 0)));
  acc.cached += ((u.prompt_tokens_details && +u.prompt_tokens_details.cached_tokens) || (+u.prompt_cache_hit_tokens) || 0);
}
function aiFmtNum(n){ n = +n || 0; return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }
// 累计一段耗时数据：首字延迟取各轮平均；token 速率按「首字之后到结束」的生成时长平均
function aiAccPerf(u, p){
  if(!p || typeof p !== 'object') return;
  if(+p.ttft > 0){ u.ttftSum += +p.ttft; u.ttftN++; }
  const gen = (+p.ms || 0) - (+p.ttft || 0);
  if(+p.out > 0 && gen > 0){ u.genMs += gen; u.outTok += +p.out; }
}
// 整段对话累计用量（用于「i」按钮弹层）：已落库消息 + 进行中一轮的实时用量与耗时
function aiConvUsage(){
  const u = { has:false, total:0, cached:0, prompt:0, completion:0,
              ttftSum:0, ttftN:0, genMs:0, outTok:0 };
  aiConvMessages.forEach(function(m){ if(m && m.usage) aiAccUsage(u, m.usage); });
  if(aiUsagePending) aiAccUsage(u, aiUsagePending);
  aiConvMessages.forEach(function(m){ if(m && m.perf) aiAccPerf(u, m.perf); });
  if(aiPerfPending) aiAccPerf(u, aiPerfPending);
  return u;
}
// 速度行：首字速度（取整段平均）+ 平均 Token 速度
function aiSpeedRows(u){
  let s = '';
  if(u.ttftN > 0){
    s += '<div class="ai-usage-row"><span>首字速度</span><b>' + (u.ttftSum / u.ttftN / 1000).toFixed(2) + ' s</b></div>';
  }
  if(u.genMs > 0 && u.outTok > 0){
    s += '<div class="ai-usage-row"><span>平均Token速度</span><b>' + (u.outTok / (u.genMs / 1000)).toFixed(1) + ' tok/s</b></div>';
  }
  return s;
}
function aiUsagePopHtml(u){
  const speed = aiSpeedRows(u);
  if(!u.has && !speed){
    return '<div class="ai-usage-pop-h">Token 用量</div><div class="ai-usage-empty">当前对话暂无用量的数据（服务商未返回 usage）</div>';
  }
  let body = '';
  if(u.has){
    body = '<div class="ai-usage-row"><span>已使用</span><b>' + aiFmtNum(u.total) + ' tokens</b></div>'+
      '<div class="ai-usage-row"><span>输入</span><span>' + aiFmtNum(u.prompt) + '</span></div>'+
      '<div class="ai-usage-row"><span>输出</span><span>' + aiFmtNum(u.completion) + '</span></div>'+
      '<div class="ai-usage-row"><span>缓存命中</span><b>' + aiFmtNum(u.cached) + ' tokens</b></div>';
  }
  return '<div class="ai-usage-pop-h">Token 用量</div>' + body + speed;
}
// 弹层常开时，实时刷新其中的用量数字
function aiUpdateUsagePop(){
  const pop = document.getElementById('aiUsagePop');
  if(!pop) return;
  pop.innerHTML = aiUsagePopHtml(aiConvUsage());
  aiPositionUsagePop();
}
function aiPositionUsagePop(){
  const pop = document.getElementById('aiUsagePop');
  const btn = document.getElementById('aiUsageBtn');
  if(!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + 'px';
}
function aiCloseUsage(){
  const p = document.getElementById('aiUsagePop');
  if(p) p.remove();
  document.removeEventListener('click', aiCloseUsage);
}
// 「i」按钮：点击在按钮上方弹出用量详情
function aiToggleUsage(ev){
  if(ev) ev.stopPropagation();
  const existed = !!document.getElementById('aiUsagePop');
  aiCloseUsage();
  if(existed) return;
  const pop = document.createElement('div');
  pop.id = 'aiUsagePop';
  pop.className = 'ai-usage-pop';
  pop.innerHTML = aiUsagePopHtml(aiConvUsage());
  pop.addEventListener('click', function(e){ e.stopPropagation(); });
  document.body.appendChild(pop);
  aiPositionUsagePop();
  setTimeout(function(){ document.addEventListener('click', aiCloseUsage); }, 0);
}
// 一整轮 AI 回复（assistant + 其后的工具结果）渲染成一个气泡，分成两块：
//   ① 思考与工具调用过程：思考 / 中间输出 / 工具调用与结果，严格按 AI 实际发生的先后顺序，
//      默认收起成一行：生成中该行显示实时状态（正在调用 xxx… / 思考中…），
//      生成结束显示摘要「已深度思考 · N 次工具调用 · 用时 Xs」；点开可查看完整步骤
//   ② 最终回答：本轮最后一个 assistant 消息的正文，始终显示
// 生成过程中不显示「AI」标签与「复制」按钮，避免运行时的重复标记。
function aiTurnHtml(turn, startIdx, live){
  const resById = {};
  turn.forEach(function(m){ if(m && m.role === 'tool' && m.tool_call_id) resById[m.tool_call_id] = m; });
  // 最终回答 = 本轮最后一个「不带工具调用」的 assistant 消息的正文；其余正文都算过程
  let ansIdx = -1;
  for(let k = turn.length - 1; k >= 0; k--){
    const m = turn[k] || {};
    if(m.role === 'tool') continue;
    if(m.tool_calls && m.tool_calls.length) continue;
    if(typeof m.content === 'string' && m.content.trim()){ ansIdx = k; break; }
  }
  let proc = '', toolCount = 0, anyDenied = false, lastTool = '';
  for(let k = 0; k < turn.length; k++){
    const m = turn[k] || {};
    if(m.role === 'tool') continue; // 结果已合并到对应「调用」处展示
    // 1) 思考
    if(m.reasoning){
      proc += '<div class="ai-proc-seg"><div class="ai-proc-tag">思考</div>' +
        '<div class="ai-proc-text">' + esc(m.reasoning) + '</div></div>';
    }
    // 2) 中间输出（不是最终回答的正文）
    if(m.content && k !== ansIdx){
      proc += '<div class="ai-proc-seg"><div class="ai-proc-tag">输出</div>' +
        '<div class="ai-body md">' + renderMd(m.content) + '</div></div>';
    }
    // 3) 工具调用与结果（保持紧跟在它发生的位置）
    if(m.tool_calls && m.tool_calls.length){
      m.tool_calls.forEach(function(t){
        const f = t.function || {};
        const r = resById[t.id];
        if(r && r.denied) anyDenied = true;
        toolCount++;
        lastTool = f.name || lastTool;
        proc += aiToolFoldHtml(f.name, f.arguments, r, 'tool-' + startIdx + '-' + k + '-' + toolCount);
      });
    }
  }
  const procKey = 'proc-' + startIdx;
  // 方案1：过程块默认收起成一行，点开看完整步骤。
  //   生成中：默认展开，能看到思考/工具调用实时「说到哪」；AI 一旦开始输出回答就自动收起（见 aiStreamRound）；
  //   生成结束：收起成一行摘要「已深度思考 · N 次工具调用 · 用时 Xs」。
  let procHtml = '';
  if(proc){
    const body = '<div class="ai-proc-body">' + proc + '</div>';
    if(live){
      // 生成中默认展开：能实时看到「说到哪」；等 AI 开始输出回答时自动收起（见 aiStreamRound）
      const fold = aiFoldAttr(procKey, true);
      const last = turn[turn.length - 1] || {};
      let liveText = aiLivePhase;
      if(!liveText){
        liveText = '思考中…';
        if(last.role === 'tool') liveText = '正在处理结果…';
        else if(last.role === 'assistant' && last.tool_calls && last.tool_calls.length){
          const pend = last.tool_calls.filter(function(tc){ return !resById[tc.id]; });
          liveText = pend.length ? ('正在调用 ' + ((pend[0].function && pend[0].function.name) || '工具') + '…') : '正在处理结果…';
        } else if(last.content) liveText = '正在生成回答…';
      }
      procHtml = '<details class="ai-proc" data-k="' + procKey + '"' + fold + '>' +
        '<summary>' + esc(liveText) + '</summary>' + body + '</details>';
    } else {
      // 生成结束默认收起成一行摘要（用户点开过则保持其选择）
      const fold = aiFoldAttr(procKey, false);
      // 本轮总耗时 = 各轮 streaming 耗时之和
      let ms = 0;
      turn.forEach(function(m){ if(m && m.perf && +m.perf.ms > 0) ms += +m.perf.ms; });
      const hasReasoning = turn.some(function(m){ return !!(m && m.reasoning); });
      const interrupted = turn.some(function(m){ return !!(m && m.interrupted); });
      procHtml = '<details class="ai-proc" data-k="' + procKey + '"' + fold + '>' +
        '<summary>' + (interrupted ? '<span class="ai-int">已中断</span>' : (hasReasoning ? '已深度思考' : '已完成')) +
        (lastTool ? ' · 最后调用 ' + esc(lastTool) : '') +
        (toolCount ? ' · 共 ' + toolCount + ' 次工具调用' : '') +
        (ms > 0 ? ' · 用时 ' + (ms / 1000).toFixed(1) + 's' : '') +
        (anyDenied ? '（含被拒绝）' : '') + '</summary>' + body + '</details>';
    }
  }
  const answerHtml = (ansIdx >= 0)
    ? '<div class="ai-body md ai-answer">' + renderMd(turn[ansIdx].content) + '</div>'
    : '';
  const acts = (!aiStreaming && ansIdx >= 0)
    ? '<div class="ai-acts"><button title="复制本段回复内容" onclick="aiCopyTurn(' + startIdx + ')">复制</button></div>'
    : '';
  const whoHtml = aiStreaming ? '' : '<div class="ai-who">AI</div>';
  return '<div class="ai-msg assistant">' + whoHtml + procHtml + answerHtml + acts + '</div>';
}
function aiBubbleHtml(role, content, idx, m){
  m = m || {};
  if(role === 'tool') return aiToolNoteHtml(m);
  const isUser = role === 'user';
  const hasText = content !== undefined && content !== null && String(content) !== '';
  const hasIdx = !(idx === undefined || idx === null);
  // 消息操作统一放到气泡底部：复制（复制原始 Markdown/文本）+ 撤回（仅用户消息）
  let acts = '';
  if(hasText || (hasIdx && isUser)){
    const copy = hasText ? '<button title="复制消息内容" onclick="aiCopy('+idx+')">复制</button>' : '';
    // 只有用户消息可撤回；AI 消息不显示撤回
    const recall = (hasIdx && isUser) ? '<button title="撤回这条及之后的消息" onclick="aiRecall('+idx+')">撤回</button>' : '';
    if(copy || recall) acts = '<div class="ai-acts">'+copy+recall+'</div>';
  }
  return '<div class="ai-msg '+(isUser?'user':'assistant')+'">'+
    '<div class="ai-who">'+(isUser?'我':'AI')+'</div>'+
    (hasText ? '<div class="ai-body'+(isUser?'':' md')+'">'+(isUser?esc(content):renderMd(content))+'</div>' : '')+
    acts +
  '</div>';
}
// ===== AI 聊天自动滚动 =====
// 规则：
// 1) 只要用户停在底部附近（≤AI_NEAR px），任何内容变化都直接贴到底——「在底部 = 跟随」永远自愈；
// 2) 只有用户明确的「向上操作」（滚轮上滑/手指上划/键盘上键/拖滚动条远离底部）才停止跟随；
// 3) 普通 scroll 事件（含程序化贴底、innerHTML 重建、内容增减导致的浏览器回弹）只允许
//    「恢复跟随」，绝不允许停止跟随——避免一次误判就永久卡死。
const AI_NEAR = 24;                 // 距底部多少 px 内算「在底部」（太大会在用户小幅上滑时把人拽回去，看起来在抽动）
let aiStick = true;                 // 是否跟随最新内容
let aiUserHold = false;             // 用户主动上滑看历史：回到底部之前，新输出一律不把他拽回去
let aiPinning = false;              // 本次 scroll 事件是否由程序化贴底产生（要忽略，防止误判用户上滑）
let aiUserScrollT = 0;              // 最近一次用户主动滚动的时刻：刚滚动完的 350ms 内不自动恢复跟随，避免边滑边被拽回
let aiPointerDown = false;          // 指针/手指是否仍按住（拖滚动条时拖离底部才停跟随；松开后的惯性滚动不算）
let aiTouchY = null;                // 触摸起点 Y
let aiBeat = null;                  // 流式期间的心跳，保证任何情况下都在跟随
// 生成中过程行的实时状态文字（流式阶段用；工具执行阶段为空，回退到按消息推断）
let aiLivePhase = '';
function aiScroller(){ return $('#aiMessages'); }
// 距底部的剩余距离
function aiBottomGap(box){ const b = box || aiScroller(); if(!b) return 0; return b.scrollHeight - b.scrollTop - b.clientHeight; }
function aiNearBottom(box){ return aiBottomGap(box) <= AI_NEAR; }
// 直接贴到底部；位置确实变化时标记 aiPinning（由随后的 scroll 事件消费并忽略）。
// 距底 ≤2px 视为已贴住：scrollTop 与 scrollHeight 存在小数像素差，若不设阈值会每次
// 都重新赋值 → 反复触发 scroll → 表现为底部一抽一抽
function aiPinBottom(box){
  const b = box || aiScroller(); if(!b) return;
  const max = b.scrollHeight - b.clientHeight;
  if(max - b.scrollTop > 2){
    aiPinning = true;
    clearTimeout(aiPinBottom._r);
    aiPinBottom._r = setTimeout(function(){ aiPinning = false; }, 150); // 防止标记悬挂
    try{ b.scrollTop = b.scrollHeight; }catch(e){}
  }
}
// 核心：在底部附近 → 恢复跟随并贴底；跟随中 → 贴底。任何内容变化后调用。
// 恢复跟随需距用户上次主动滚动 ≥350ms：刚滑完就恢复会把人拽回去（小幅上滑时表现为抽动）
function aiFollowOrPin(){
  const box = aiScroller(); if(!box) return;
  // 用户上滑后处于「看历史」状态：只有他自己滚回真正的底部才恢复跟随。
  // 中间无论新输出多少内容都不动滚动位置（这正是「刚翻上去又被拽回底部」的原因）。
  if(aiUserHold){
    if(aiBottomGap(box) <= 2) aiUserHold = false;
    else return;
  }
  if(aiNearBottom(box) && Date.now() - aiUserScrollT > 350) aiStick = true;
  if(aiStick) aiPinBottom(box);
}
// 内容/渲染变化后调用：贴底并做几次延迟兜底（图片、代码块、字体异步撑高）
function scrollAiBottom(){
  aiEnsureColObserver();
  aiFollowOrPin();
  if(scrollAiBottom._raf) cancelAnimationFrame(scrollAiBottom._raf);
  scrollAiBottom._raf = requestAnimationFrame(aiFollowOrPin);
  clearTimeout(scrollAiBottom._t);
  scrollAiBottom._t = setTimeout(aiFollowOrPin, 150);
}
// 绑定滚动/尺寸/DOM 监听
let aiColObserver = null, aiDomObserver = null, aiScrollRO = null, aiBoundBox = null, aiObservedCol = null;
function aiEnsureColObserver(){
  const col = $('#aiCol'), box = aiScroller();
  if(!col || !box) return;
  // 容器可能被重建（切页/全屏），元素变了就重新绑定
  if(box !== aiBoundBox){
    aiBoundBox = box;
    try{
      if(aiScrollRO) aiScrollRO.disconnect();
      // 滚动区自身尺寸变化（下方「继续」条/状态行出现把滚动区压矮、面板布局变化等）
      // 也必须重新贴底——之前只监听内容区，这种压缩没人管，导致「明明贴了底却被顶上去」
      aiScrollRO = new ResizeObserver(function(){ aiFollowOrPin(); });
      aiScrollRO.observe(box);
    }catch(e){}
    // scroll：先忽略自己贴底产生的滚动，再判断——
    // 回到底部附近 → 恢复跟随；用户拖滚动条远离底部 → 停止跟随；其余不改变状态
    box.addEventListener('scroll', function(){
      if(aiPinning){ aiPinning = false; return; }
      // 只有用户自己滚到真正的底部才结束「看历史」；近底部阈值（24px）在这里不算，
      // 否则小幅上滑后一有 scroll 事件就恢复跟随，又会被拽回底部
      if(aiBottomGap(box) <= 2){
        aiUserHold = false;
        if(Date.now() - aiUserScrollT > 350) aiStick = true;
      } else if(aiPointerDown){
        aiStick = false; aiUserHold = true; aiUserScrollT = Date.now();
      }
    }, { passive:true });
    // 滚轮上滑 = 想看历史：仅当真的处于已下滚状态（上方还有内容可看）才停止跟随，
    // 防止内容不足一屏或已在顶部时的空滚误关跟随。
    // 过程块/代码块等内部滚动区自己吃掉的滚动不算：多工具时用户在过程块里翻步骤，
    // 不能因此把主视图的跟随关掉（内部区已到顶、滚动将连带主视图时才停）
    box.addEventListener('wheel', function(e){
      if(e.deltaY >= 0 || box.scrollTop <= 4) return;
      const t = e.target;
      const inner = (t && t.closest) ? t.closest('.ai-proc-body, .ai-tool-fold-pre, .ai-body pre, .ai-body table') : null;
      if(inner && inner.scrollTop > 0) return;
      aiStick = false; aiUserHold = true; aiUserScrollT = Date.now();
    }, { passive:true });
    // 手指向下划（浏览更早内容）：停止跟随。
    // 必须是「明确的上滑手势」：位移超过 6px 且当前确实已下滚过，否则点按/收键盘的轻微
    // 触碰就会被误判成往回看，导致后面再也不跟随（手机上高发）
    box.addEventListener('touchstart', function(e){
      aiTouchY = (e.touches && e.touches[0]) ? e.touches[0].clientY : null;
    }, { passive:true });
    box.addEventListener('touchmove', function(e){
      const y = (e.touches && e.touches[0]) ? e.touches[0].clientY : null;
      if(y != null && aiTouchY != null && y - aiTouchY > 6 && box.scrollTop > 4){ aiStick = false; aiUserHold = true; aiUserScrollT = Date.now(); }
      aiTouchY = y;
    }, { passive:true });
    // 触屏惯性滚动期间也要记录「用户在滚动」，防止恢复跟随把惯性中的手指拽回去
    box.addEventListener('touchend', function(){ aiUserScrollT = Date.now(); }, { passive:true });
    // 键盘上翻：停止跟随
    box.addEventListener('keydown', function(e){
      if(e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home'){ aiStick = false; aiUserHold = true; aiUserScrollT = Date.now(); }
    });
    // 按住 = 拖动滚动条中；松开立即结束（惯性滚动期间不再当作拖动）
    box.addEventListener('pointerdown', function(){ aiPointerDown = true; }, { passive:true });
    ['pointerup','pointercancel'].forEach(function(ev){
      box.addEventListener(ev, function(){ aiPointerDown = false; }, { passive:true });
    });
  }
  if(col !== aiObservedCol){
    aiObservedCol = col;
    try{
      if(aiColObserver) aiColObserver.disconnect();
      aiColObserver = new ResizeObserver(aiFollowOrPin);
      aiColObserver.observe(col);
    }catch(e){}
    try{
      if(aiDomObserver) aiDomObserver.disconnect();
      aiDomObserver = new MutationObserver(aiFollowOrPin);
      aiDomObserver.observe(col, { childList:true, subtree:true, characterData:true, attributes:true });
    }catch(e){}
  }
}
function aiStop(){ if(aiAbort){ try{ aiAbort.abort(); }catch(e){} } }
// 发送键状态：生成中原地变成灰色「停止」按钮（同一个按钮，不额外加按钮）
function aiSetSendState(busy){
  const b = $('#aiSendBtn'); if(!b) return;
  b.textContent = busy ? '停止' : '发送';
  b.title = busy ? '停止生成' : '发送';
  if(busy) b.classList.add('stop'); else b.classList.remove('stop');
}

// 输入框自动增高（底部对齐，视觉上向上拉升）；用户手动拖拽过则尊重拖拽高度（上限 600）
let aiInputH = 0; // 手动拖拽设定的高度；0 = 未拖过，自动增高（上限 220）
function aiAutoGrow(){
  const el = $('#aiInput'); if(!el) return;
  el.style.height = 'auto';
  const max = aiInputH > 0 ? 600 : 220;
  const h = aiInputH > 0 ? Math.max(el.scrollHeight, aiInputH) : el.scrollHeight;
  el.style.height = Math.min(h, max) + 'px';
  el.style.overflowY = el.scrollHeight > Math.min(h, max) + 2 ? 'auto' : 'hidden';
}
async function aiSend(){
  if(aiStreaming){ aiStop(); return; } // 生成中：该按钮就是「停止」
  const input = $('#aiInput');
  const text = ((input && input.value) || '').trim();
  if(!text){ toast('请输入内容', true); return; }
  aiConvMessages.push({ role:'user', content:text });
  if(input){ input.value = ''; aiAutoGrow(); }
  aiStick = true; aiUserHold = false; // 刚发送：回到「跟随最新回复」状态
  aiSetTitle(aiConvTitle);
  renderAiMessages();
  aiSaveProgress();   // 先落盘用户提问，刷新后不会整轮消失
  await aiAgentLoop();
}
// 是否需要用户确认：full 不确认；important 仅危险操作确认；all/其他 全部确认
function aiNeedConfirm(name){
  if(aiPermission === 'full') return false;
  if(aiPermission === 'important') return aiToolDanger.indexOf(name) >= 0;
  return true;
}
async function aiAgentLoop(){
  const modelEl = $('#aiChatModel');
  const modelName = modelEl ? modelEl.value.trim() : '';
  aiStreaming = true;
  aiSetSendState(true);
  // 流式期间心跳兜底：无论哪个环节漏了触发贴底（工具执行、思考间隙、事件竞态），只要用户
  // 没有主动上滑看历史，都保证持续跟随到最新输出
  clearInterval(aiBeat);
  aiBeat = setInterval(function(){ if(aiStreaming) aiFollowOrPin(); else clearInterval(aiBeat); }, 700);
  const msg = $('#aiChatMsg'); if(msg){ msg.className = 'msg'; msg.textContent = ''; }
  aiAbort = new AbortController();
  let rounds = 0, finished = false;
  try{
    while(rounds < AI_MAX_ROUNDS){
      rounds++;
      // 最后一轮不再提供工具，强制模型用文字给出收尾答复，避免「执行到一半被截断」
      const lastRound = rounds >= AI_MAX_ROUNDS;
      renderAiMessages();
      const box = $('#aiCol');
      // 等待提示放在输入框上方的底部状态行（#aiChatMsg），不再占用消息区；
      // 临时气泡先隐藏，首个输出片段到达时才显示，避免出现空白大块
      if(msg){ msg.className = 'msg'; msg.textContent = '等待模型响应…'; }
      let msgEl = null;
      if(box){
        box.insertAdjacentHTML('beforeend', '<div class="ai-msg assistant" style="display:none">'+
          '<div class="ai-body md" id="aiCurBody"></div></div>');
        msgEl = box.lastElementChild;
      }
      scrollAiBottom();
      const bodyEl = box ? box.querySelector('#aiCurBody') : null;
      // 本轮草稿将落在 aiConvMessages 的末尾，proc key 必须与渲染器的回合 key 一致
      // （回合起点 = 最后一条用户消息的下标+1），否则自动收起/展开过程块会落空
      let turnStart = aiConvMessages.length;
      for(let k = aiConvMessages.length - 1; k >= 0; k--){
        if((aiConvMessages[k] || {}).role === 'user'){ turnStart = k + 1; break; }
      }
      const ui = { bodyEl: bodyEl, msgEl: msgEl, acc: '', procKey: 'proc-' + turnStart };
      let res;
      try{
        res = await aiStreamRound(modelName, ui, lastRound);
      }catch(e){
        if(e && e.name === 'AbortError'){
          if(msg){ msg.className = 'msg'; msg.textContent = '已停止生成'; }
          // 停止时保留已生成的部分内容（草稿已落盘，这里转正），重渲染后仍可见
          if(ui.acc){ if(!aiFinalizeDraft(ui.acc)) aiConvMessages.push({ role:'assistant', content: ui.acc }); }
          aiMarkInterrupted(turnStart); // 过程块摘要显示「已中断」而非「已完成」
          finished = true;
          break;
        }
        const err = (e && e.message) ? e.message : String(e);
        const hint = aiChatProxyOn() ? '（前端代理请求失败：服务商可能不允许跨域）' : '';
        if(msg){ msg.className = 'msg err'; msg.textContent = '请求失败：' + err + hint; }
        toast('请求失败：' + err, true);
        // 保留已收到的部分内容（草稿转正），并清掉临时气泡
        if(ui.acc){ if(!aiFinalizeDraft(ui.acc)) aiConvMessages.push({ role:'assistant', content: ui.acc }); }
        aiMarkInterrupted(turnStart);
        finished = true;
        break;
      }
      if(res.toolCalls && res.toolCalls.length && !lastRound){
        const am = {
          role:'assistant',
          content: res.content || '',
          tool_calls: res.toolCalls.map(function(t){ return { id:t.id, type:'function', function:{ name:t.name, arguments:t.arguments } }; })
        };
        if(aiThink && res.reasoning) am.reasoning = res.reasoning;
        if(res.usage) am.usage = res.usage;
        if(res.perf) am.perf = res.perf;
        aiDropDraft(); // 本轮流式草稿并入下面的正式消息，避免重复
        aiConvMessages.push(am);
        aiUsagePending = null; aiPerfPending = null; // 已并入消息，避免重复累计
        renderAiMessages();
        aiUpdateUsagePop();
        aiSaveProgress(); // 工具调用这一步先落盘，刷新后不丢进度
        for(let k=0; k<res.toolCalls.length; k++){
          const t = res.toolCalls[k];
          let args = {};
          try{ args = JSON.parse(t.arguments || '{}'); }catch(e){ args = {}; }
          let resultStr, denied = false;
          if(t.name === 'request_secret'){
            // 凭据只能由用户在前端本地输入，绝不经过 AI：弹窗收集后直接写入服务端
            const out = await aiAskSecret(args);
            if(!out.ok) denied = true;
            resultStr = JSON.stringify(out);
          } else if(t.name === 'wait_workflow'){
            // 等待工具由前端轮询执行（不受 Worker 子请求/时长限制）：阻塞等当前工作流跑完再继续，
            // 成功/失败都返回；等待期间把进度实时写进工具消息，用户能看到已等多久
            const tm = { role:'tool', tool_call_id:t.id, name:t.name, content:'（等待工作流运行结束…）', denied:false };
            aiConvMessages.push(tm);
            resultStr = await aiWaitWorkflow(args, tm);
            tm.content = resultStr;
            aiSaveProgress();
            renderAiMessages();
            try{ initBuildStatus(); }catch(e){}
          } else {
            let allow = true;
            if(aiNeedConfirm(t.name)) allow = await aiAskConfirm(t.name, args);
            if(allow){
              const rr = await api('/admin/api/ai/tool', { method:'POST', body: JSON.stringify({ name:t.name, args:args }) });
              if(rr.ok && rr.data && rr.data.ok) resultStr = String(rr.data.result || '');
              else resultStr = JSON.stringify({ ok:false, error:(rr.data && rr.data.error) || '执行失败' });
            } else {
              denied = true;
              resultStr = JSON.stringify({ ok:false, error:'用户已拒绝执行该操作' });
            }
          }
          if(t.name !== 'wait_workflow') // wait_workflow 的工具消息已在等待前占位并实时更新，不重复入列
            aiConvMessages.push({ role:'tool', tool_call_id:t.id, name:t.name, content: resultStr, denied: denied });
          aiSaveProgress(); // 每个工具结果落盘，刷新后能看到已执行到哪一步
          // AI 触发/取消工作流后，同步顶部运行横幅（会聚合展示所有正在运行的工作流）
          try{ aiSyncBuildBanner(t.name, args, resultStr); }catch(e){}
        }
        renderAiMessages();
        continue;
      }
      const fm = { role:'assistant', content: res.content || (lastRound ? '（工具调用次数已达本轮上限，请回复「继续」以接着处理）' : '') };
      if(aiThink && res.reasoning) fm.reasoning = res.reasoning;
      if(res.usage) fm.usage = res.usage;
      if(res.perf) fm.perf = res.perf;
      aiDropDraft(); // 草稿内容已包含在最终回答里
      aiConvMessages.push(fm);
      aiUsagePending = null; aiPerfPending = null;
      finished = true;
      break;
    }
  }finally{
    aiStreaming = false; aiAbort = null; aiUsagePending = null; aiPerfPending = null; aiLivePhase = '';
    clearInterval(aiBeat);
    aiSetSendState(false);
    aiUpdateUsagePop();
    // 生成结束（非中断/异常）后重渲染一次：恢复「AI」标签与「复制」按钮
    if(finished) renderAiMessages();
    else aiUpdateContinueBar(); // 中断/异常：如仍有未完成步骤，提示可「继续」
  }
  await aiSaveConversation();
  scrollAiBottom();
  // 用 Cloudflare 模型时刷新一次剩余额度（Neurons 每日 10000）
  if(aiCfEnabledCfg){ try{ aiCfQuota(false); }catch(e){} }
}
// 标记本回合被中断（手动停止/请求失败）：给回合内最后一条 assistant 消息打标，渲染成「已中断」
function aiMarkInterrupted(turnStart){
  for(let k = aiConvMessages.length - 1; k >= turnStart; k--){
    const m = aiConvMessages[k];
    if(m && m.role === 'assistant'){ m.interrupted = true; return; }
  }
}
// 清理历史消息：去掉仅供前端展示的字段（思考/拒绝/用量/草稿标记），避免上游接口报错
function aiCleanMsg(m){
  if(!m || (m.reasoning === undefined && m.denied === undefined && m.usage === undefined && m.perf === undefined && m.draft === undefined && m.interrupted === undefined)) return m;
  const c = {};
  for(const k in m){ if(k !== 'reasoning' && k !== 'denied' && k !== 'usage' && k !== 'perf' && k !== 'draft' && k !== 'interrupted') c[k] = m[k]; }
  return c;
}
// 流式过程中的渲染：已完成段落走 Markdown，末尾未完成的段落用纯文本显示。
// 全量重渲染半截 Markdown 时高度会来回变（表格/列表/代码块解析中途改变形状），
// 贴底视图就会跟着上下抖；本方式让高度只增不减。
// 同时用 min-height 记录流式期间达到过的最大高度，杜绝任何方向的收缩。
function aiStreamHtml(acc){
  const cut = acc.lastIndexOf('\\n\\n');
  const stable = cut >= 0 ? acc.slice(0, cut + 2) : '';
  const tail = cut >= 0 ? acc.slice(cut + 2) : acc;
  return (stable ? renderMd(stable) : '') + (tail ? '<p class="ai-tail">' + esc(tail).replace(/\\n/g, '<br>') + '</p>' : '');
}
function aiStreamPaint(ui, acc){
  if(!ui || !ui.bodyEl) return;
  // 第一个片段到达：把预留的临时气泡显示出来（等待期间它是不占位的）
  if(ui.msgEl && ui.msgEl.style.display === 'none') ui.msgEl.style.display = '';
  ui.bodyEl.innerHTML = aiStreamHtml(acc);
  try{
    const h = ui.bodyEl.offsetHeight;
    if(h > (ui.maxH || 0)) ui.maxH = h;
    if(ui.maxH) ui.bodyEl.style.minHeight = ui.maxH + 'px';
  }catch(e){}
}
// 流式请求一轮，返回 {content, toolCalls, reasoning, usage}
async function aiStreamRound(modelName, ui, noTools){
  // 系统提示词（AI 提示词）+ 工具使用说明：仅在请求时附加，不写入历史
  const sysParts = [];
  if(aiPrompt) sysParts.push(aiPrompt);
  if(aiToolsHint && !noTools) sysParts.push(aiToolsHint);
  const hist = aiConvMessages.map(aiCleanMsg);
  const reqMessages = sysParts.length ? [{ role:'system', content: sysParts.join('\\n\\n') }].concat(hist) : hist;
  // stream_options.include_usage：让上游在流末尾附带 usage（token 用量/缓存命中）
  const payload = { messages: reqMessages, model: modelName, stream_options: { include_usage: true } };
  // Cloudflare Workers AI：模型以 @cf/ 开头，交给后端走 Cloudflare 的兼容接口
  const isCfModel = String(modelName || '').indexOf('@cf/') === 0;
  if(isCfModel){ payload.provider = 'cf'; delete payload.stream_options; }
  // 思考强度：作为 reasoning_effort 一并发给服务商（关闭时不发送）
  if(aiThink) payload.reasoning_effort = aiThinkLevel;
  // 收尾轮不带工具，让模型直接输出文字总结
  if(aiTools && aiTools.length && !noTools){ payload.tools = aiTools; payload.tool_choice = 'auto'; }
  const t0 = Date.now();   // 本轮发起点：用于首字速度与平均 token 速度
  let ttft = null;         // 首个输出片段耗时（ms）
  let resp;
  if(aiChatProxyOn() && !isCfModel){
    // 前端代理：浏览器直连服务商（仅当服务商允许跨域 CORS 时可用）
    const base = await resolveAiBase();
    if(!base) throw new Error('前端代理需要 API 地址，请先在「设置 → AI 设置」填写 API 地址');
    const k = await resolveAiKey(aiVal('aiApiKey'));
    payload.stream = true;
    resp = await fetch(aiJoin(base, '/chat/completions'), {
      method:'POST',
      headers: Object.assign({'Content-Type':'application/json'}, k ? {Authorization:'Bearer ' + k} : {}),
      signal: aiAbort.signal,
      body: JSON.stringify(payload)
    });
  } else {
    const headers = { 'Content-Type':'application/json' };
    if(token) headers['Authorization'] = 'Bearer ' + token;
    resp = await fetch('/admin/api/ai/chat', {
      method:'POST',
      headers: headers,
      signal: aiAbort.signal,
      body: JSON.stringify(payload)
    });
  }
  const ct = resp.headers.get('content-type') || '';
  if(!resp.ok || ct.indexOf('application/json') >= 0){
    const d = await resp.json().catch(()=>({}));
    const em = d && d.error && (d.error.message || d.error);
    throw new Error((typeof em === 'string' && em) || ('HTTP ' + resp.status));
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '', acc = '', reasonAcc = '', lastPaint = 0, usageAcc = null;
  const toolAcc = {};
  // 首个输出片段到达：记录首字延迟并实时反映到「i」面板
  const markFirst = function(){
    if(ttft !== null) return;
    ttft = Date.now() - t0;
    aiPerfPending = { ttft: ttft };
    aiUpdateUsagePop();
    // 模型已经开始响应：清掉底部状态行的「等待模型响应…」
    const m = $('#aiChatMsg');
    if(m && m.textContent === '等待模型响应…') m.textContent = '';
  };
  while(true){
    const chunk = await reader.read();
    if(chunk.done) break;
    buf += dec.decode(chunk.value, { stream:true });
    let idx;
    while((idx = buf.indexOf('\\n')) >= 0){
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if(!line || line.indexOf('data:') !== 0) continue;
      const pl = line.slice(5).trim();
      if(pl === '[DONE]'){ buf = ''; break; }
      let j;
      try{ j = JSON.parse(pl); }catch(e){ continue; }
      // usage 可能在末尾单独一帧（choices 为空）返回，需在取 delta 之前解析；
      // 同步给全局并刷新「i」面板，做到实时更新
      if(j.usage){ usageAcc = j.usage; aiUsagePending = j.usage; aiUpdateUsagePop(); }
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if(!delta) continue;
      // 思考模式：保留模型返回的推理内容（reasoning_content / reasoning），
      // 过程中只在状态行显示「思考中…」，完整思考可展开过程查看
      if(aiThink){
        const rc = delta.reasoning_content || delta.reasoning;
        if(rc){
          reasonAcc += rc;
          markFirst();
          aiLivePhase = '思考中…';
        }
      }
      if(delta.content){
        acc += delta.content;
        markFirst();
        aiLivePhase = '正在生成回答…';
        // AI 开始输出回答：把本轮的过程块自动收起一次（本轮还没调用工具，说明这就是最终回答）；
        // 只收一次，避免用户之后手动展开时又被收回去
        if(!Object.keys(toolAcc).length && ui && !ui.procCollapsed){ ui.procCollapsed = true; aiSetProcOpen(ui.procKey, false); }
        if(ui) ui.acc = acc; // 暴露给调用方，停止时可保留部分内容
        // 把已生成的部分作为草稿写入会话并节流落盘：刷新后仍能看到「进行到哪一步」
        aiSetDraft(acc);
        aiSaveProgress();
        const now = Date.now();
        if(ui && ui.bodyEl && (now - lastPaint > 80)){ lastPaint = now; aiStreamPaint(ui, acc); scrollAiBottom(); }
      }
      if(delta.tool_calls && delta.tool_calls.length){
        markFirst();
        aiLivePhase = '准备调用工具…';
        // 有工具调用：重新展开过程块实时查看；但用户手动收起过就不再强行展开（避免「展开又收回」的跳动）
        if(aiFoldOpen[ui && ui.procKey] !== false) aiSetProcOpen(ui && ui.procKey, true);
        for(let ti=0; ti<delta.tool_calls.length; ti++){
          const tc = delta.tool_calls[ti];
          const key = (tc.index === undefined || tc.index === null) ? 0 : tc.index;
          if(!toolAcc[key]) toolAcc[key] = { id:'', name:'', args:'' };
          if(tc.id) toolAcc[key].id = tc.id;
          if(tc.function){
            if(tc.function.name) toolAcc[key].name = tc.function.name;
            if(tc.function.arguments) toolAcc[key].args += tc.function.arguments;
          }
        }
      }
    }
  }
  const keys = Object.keys(toolAcc).sort(function(a,b){ return (+a) - (+b); });
  const toolCalls = keys.map(function(k){
    const t = toolAcc[k];
    return { id: t.id || ('call_' + k), name: t.name, arguments: t.args || '{}' };
  }).filter(function(t){ return !!t.name; });
  // 收尾：把流式内容按 Markdown 完整渲染一次（解除流式期间的最小高度锁定）
  if(ui && ui.bodyEl){ ui.bodyEl.style.minHeight = ''; ui.bodyEl.innerHTML = renderMd(acc); }
  aiLivePhase = ''; // 流式阶段结束，过程行状态改由消息推断（如「正在调用 xxx…」）
  scrollAiBottom();
  // out：本轮的输出 token 数（取上游 usage），用于折算平均 token 速度
  const outTok = usageAcc ? (+usageAcc.completion_tokens || 0) : 0;
  const perf = (ttft === null) ? null : { ttft: ttft, ms: Date.now() - t0, out: outTok };
  return { content: acc, toolCalls: toolCalls, reasoning: reasonAcc, usage: usageAcc, perf: perf };
}
// 危险操作确认卡片（返回 Promise：允许=true / 拒绝=false）
function aiAskConfirm(name, args){
  return new Promise(function(resolve){
    const box = $('#aiCol');
    if(!box){ resolve(false); return; }
    let argTxt = '';
    // save_secret 的确认卡片里不展示真实凭据值
    if(name === 'save_secret' && args && args.value){
      args = Object.assign({}, args, { value: '（已隐藏）' });
    }
    try{ argTxt = JSON.stringify(args, null, 2); }catch(e){ argTxt = String(args); }
    const div = document.createElement('div');
    div.className = 'ai-tool-confirm';
    div.innerHTML = '<div class="ai-tool-head">需要确认：' + esc(name) + '</div>'+
      '<pre class="ai-tool-pre">' + esc(argTxt) + '</pre>'+
      '<div class="filters" style="margin:8px 0 0">'+
        '<button class="wk-btn sm" data-yes>允许执行</button>'+
        '<button class="wk-btn ghost sm" data-no>拒绝</button>'+
      '</div>';
    box.appendChild(div);
    scrollAiBottom();
    div.querySelector('[data-yes]').onclick = function(){ div.remove(); resolve(true); };
    div.querySelector('[data-no]').onclick = function(){ div.remove(); resolve(false); };
  });
}
// ---------- AI 工具：等待工作流运行结束（前端轮询，成功/失败都返回）----------
// args: { workflow?: 'update-gh.yml', timeout_minutes?: number }
// msg: 已入列的工具消息，等待期间把「已等多久」写进去（约每 30 秒刷新一次，避免频繁重渲染）
async function aiWaitWorkflow(args, msg){
  const wf = String((args && (args.workflow || args.workflow_id)) || '').trim();
  const maxMin = Math.min(Math.max(Number(args && args.timeout_minutes) || 10, 1), 30);
  const t0 = Date.now();
  const deadline = t0 + maxMin * 60000;
  let grace = 0, lastNote = 0;
  const query = API_BASE + '/workflows/runs?limit=5' + (wf ? ('&workflow=' + encodeURIComponent(wf)) : '');
  while (true) {
    const r = await api(query);
    const d = (r.ok && r.data && r.data.ok) ? r.data : null;
    if (!d) return JSON.stringify({ ok:false, error:'查询工作流状态失败：' + ((r.data && r.data.error) || r.status) });
    if (!d.running) {
      // 刚触发的工作流要过一两秒才会登记成 run：给 8 秒缓冲确认，避免误报「没有在跑」
      if (grace < 2 && Date.now() - t0 < 15000) {
        grace++;
        if (msg && Date.now() - lastNote > 3000) {
          lastNote = Date.now();
          msg.content = '暂未检测到正在运行的工作流，' + (grace * 4) + ' 秒后再次确认…';
          renderAiMessages();
        }
        await new Promise(res => setTimeout(res, 4000));
        continue;
      }
      const runs = (d.runs || []).slice(0, 3).map(function(x){
        return { name:x.name, workflow:x.workflow, status:x.status, conclusion:x.conclusion, created_at:x.created_at };
      });
      const latest = d.latest || runs[0] || null;
      return JSON.stringify({
        ok: true, all_done: true, waited_seconds: Math.round((Date.now() - t0) / 1000), running: false,
        latest: latest, runs: runs,
        message: latest
          ? ('当前没有在运行的工作流。最近一次' + (wf ? ('「' + wf + '」') : '') + '：' + (latest.name || latest.workflow || '') + ' → ' + latest.status + (latest.conclusion ? ('/' + latest.conclusion) : ''))
          : ('当前没有' + (wf ? ('「' + wf + '」') : '') + '的任何运行记录'),
      });
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    if (msg && Date.now() - lastNote > 30000) {
      lastNote = Date.now();
      const live = d.latest ? ('「' + (d.latest.name || d.latest.workflow || wf) + '」' + d.latest.status) : '工作流';
      msg.content = '已等待 ' + Math.floor(secs / 60) + ' 分 ' + (secs % 60) + ' 秒，' + live + '仍在运行…';
      renderAiMessages();
    }
    if (Date.now() >= deadline) {
      return JSON.stringify({
        ok: false, timeout: true, waited_seconds: secs, running: true, latest: d.latest || null,
        message: '等待超时（' + maxMin + ' 分钟），工作流仍在运行；可用 workflow_runs 查看进度，或再次调用 wait_workflow 继续等。',
      });
    }
    await new Promise(res => setTimeout(res, 5000));
  }
}
// AI 需要凭据但用户尚未提供：前端弹窗本地输入，值直接写入服务端密钥库，绝不发送给 AI
function aiAskSecret(args){
  args = args || {};
  return new Promise(function(resolve){
    const preName = String(args.name || '').trim();
    const purpose = String(args.purpose || preName || '凭据');
    const mask = document.createElement('div');
    mask.className = 'ai-secret-mask';
    mask.innerHTML = '<div class="ai-secret-box">'+
      '<div class="ai-secret-title">AI 请求你提供凭据</div>'+
      '<p class="ai-secret-desc">用途：'+esc(purpose)+'<br>该内容<b>不会发送给 AI</b>，将直接安全写入服务端，之后 AI 只能用占位符引用。</p>'+
      '<label class="wk-label">占位符名称</label>'+
      '<input class="wk-input" data-name value="'+esc(preName)+'" placeholder="如 SMTP_PASS">'+
      '<label class="wk-label">凭据值</label>'+
      '<input class="wk-input" type="password" data-value placeholder="在此输入，不会发给 AI">'+
      '<div class="filters" style="margin:14px 0 0">'+
        '<button class="wk-btn sm" data-ok>保存</button>'+
        '<button class="wk-btn ghost sm" data-cancel>取消</button>'+
      '</div>'+
      '<div class="msg" data-msg></div>'+
    '</div>';
    document.body.appendChild(mask);
    const nameEl = mask.querySelector('[data-name]');
    const valEl = mask.querySelector('[data-value]');
    const msgEl = mask.querySelector('[data-msg]');
    if(preName) valEl.focus(); else nameEl.focus();
    const close = function(v){ mask.remove(); resolve(v); };
    mask.querySelector('[data-cancel]').onclick = function(){ close({ ok:false, error:'用户取消输入' }); };
    mask.querySelector('[data-ok]').onclick = async function(){
      const nm = (nameEl.value || '').trim();
      const v = valEl.value || '';
      if(!nm){ msgEl.className = 'msg err'; msgEl.textContent = '请填写占位符名称'; return; }
      if(!v){ msgEl.className = 'msg err'; msgEl.textContent = '请填写凭据值'; return; }
      const r = await api('/admin/api/secrets', { method:'PUT', body: JSON.stringify({ name:nm, value:v }) });
      if(r.ok){
        toast('凭据已安全保存');
        try{ loadSecrets(); }catch(e){}
        close({ ok:true, name:nm, saved:true, message:'凭据已安全保存，可用占位符 {'+nm+'} 引用' });
      } else {
        msgEl.className = 'msg err'; msgEl.textContent = (r.data && r.data.error) || '保存失败';
      }
    };
  });
}

async function aiSaveConversation(){
  if(!aiConvMessages.length && !aiConvId) return;
  const firstUser = aiConvMessages.find(m => m.role === 'user');
  const title = (aiConvTitle || (firstUser ? firstUser.content.slice(0, 30) : '新对话')).slice(0, 100);
  const r = await api('/admin/api/ai/conversation', {
    method:'PUT',
    body: JSON.stringify({ id: aiConvId, title: title, messages: aiConvMessages })
  });
  if(r.ok && r.data && r.data.id){ aiConvId = r.data.id; aiSyncUrl(); loadAiConversations(); }
}

// ---------- 生成过程持久化：刷新/关闭页面后仍能看到「进行到哪一步」并继续 ----------
let aiProgressTimer=null, aiProgressLast=0, aiProgressBusy=false;
// 静默保存（不刷新会话列表，避免生成中频繁重排）；同一时刻只允许一个写请求，避免新建出重复会话
async function aiSaveProgressNow(){
  if(aiProgressBusy) return;
  if(!aiConvMessages.length && !aiConvId) return;
  aiProgressBusy=true;
  try{
    const firstUser = aiConvMessages.find(function(m){ return m.role==='user'; });
    const title = (aiConvTitle || (firstUser ? String(firstUser.content||'').slice(0,30) : '新对话')).slice(0,100);
    const r = await api('/admin/api/ai/conversation', { method:'PUT', body: JSON.stringify({ id: aiConvId, title: title, messages: aiConvMessages }) });
    if(r.ok && r.data && r.data.id){
      if(!aiConvId){ aiConvId=r.data.id; aiSyncUrl(); loadAiConversations(); }
    }
  }catch(e){}finally{ aiProgressBusy=false; }
}
// 节流：最多每 1.2 秒落盘一次，避免流式输出时打爆接口
function aiSaveProgress(){
  const now=Date.now();
  if(now - aiProgressLast >= 1200){ aiProgressLast=now; aiSaveProgressNow(); return; }
  if(!aiProgressTimer){ aiProgressTimer=setTimeout(function(){ aiProgressTimer=null; aiProgressLast=Date.now(); aiSaveProgressNow(); }, 1200); }
}
// 流式输出中的草稿消息：内容随输出增长，随会话一起落盘，页面被刷新后仍能看到已生成的部分
function aiSetDraft(text){
  if(!text) return;
  let d=aiConvMessages[aiConvMessages.length-1];
  if(!d || !d.draft){ d={ role:'assistant', content:'', draft:true }; aiConvMessages.push(d); }
  d.content=text;
}
function aiDropDraft(){ const d=aiConvMessages[aiConvMessages.length-1]; if(d && d.draft) aiConvMessages.pop(); }
function aiFinalizeDraft(content){
  const d=aiConvMessages[aiConvMessages.length-1];
  if(d && d.draft){ if(content!==undefined) d.content=content; delete d.draft; return true; }
  return false;
}
// 上一轮是否「没跑完」：只问了没答 / 有工具调用但缺结果 / 收尾却在工具结果处 / 留下流式草稿
function aiTurnIncomplete(){
  if(!aiConvMessages.length) return false;
  const last=aiConvMessages[aiConvMessages.length-1]||{};
  if(last.role==='user') return true;
  if(last.draft) return true;
  if(last.role==='tool') return true;
  if(last.role==='assistant' && last.tool_calls && last.tool_calls.length) return true;
  return false;
}
function aiContinue(){
  if(aiStreaming) return;
  const i=$('#aiInput');
  if(i){ i.value='继续'; aiAutoGrow(); i.focus(); }
  aiSend();
}
// 「继续未完成回复」提示条：打开历史会话时若上一轮没跑完（被刷新/中断），提示可一键继续
function aiUpdateContinueBar(){
  const bar=$('#aiContinueBar'); if(!bar) return;
  bar.classList.toggle('hidden', aiStreaming || !aiTurnIncomplete());
}
function aiDismissContinue(){ const bar=$('#aiContinueBar'); if(bar) bar.classList.add('hidden'); }

// ---------- AI 密钥（占位符 {name}，仅存名称，值不下发）----------
async function loadSecrets(){
  const box = $('#secList'); if(!box) return;
  try{
    const r = await api('/admin/api/secrets');
    const names = (r.ok && r.data && Array.isArray(r.data.names)) ? r.data.names : [];
    if(!names.length){ box.innerHTML = '<div class="empty">暂无密钥</div>'; return; }
    box.innerHTML = names.map(function(n){
      return '<div class="ai-conv" style="cursor:default"><span class="ai-conv-t">{'+esc(n)+'}</span>'+
        '<button class="wk-btn ghost sm" onclick="delSecret(\\''+esc(n)+'\\')">删</button></div>';
    }).join('');
  }catch(e){ box.innerHTML = '<div class="empty">加载失败</div>'; }
}
async function saveSecret(){
  const msg = $('#secMsg');
  const name = aiVal('secName').trim();
  const value = aiVal('secValue');
  if(!name){ toast('请填写名称', true); return; }
  if(!value){ toast('请填写密钥值', true); return; }
  const r = await api('/admin/api/secrets', { method:'PUT', body: JSON.stringify({ name:name, value:value }) });
  const err = (r.data && r.data.error) || '保存失败';
  if(r.ok){
    toast('密钥已保存');
    if(msg){ msg.className='msg ok'; msg.textContent='密钥已保存（AI 只能看到占位符 {' + name + '}）'; }
    const v = $('#secValue'); if(v) v.value='';
    loadSecrets();
  } else {
    toast(err, true);
    if(msg){ msg.className='msg err'; msg.textContent=err; }
  }
}
async function delSecret(name){
  if(!await askConfirm('确认删除密钥 {' + name + '} ？')) return;
  const r = await api('/admin/api/secrets?name=' + encodeURIComponent(name), { method:'DELETE' });
  if(r.ok){ toast('已删除'); loadSecrets(); } else toast('删除失败', true);
}

// ---------- 订阅管理（SMTP 配置 + 订阅者 + 群发）----------
function subSet(id, v){ const el=$('#'+id); if(el) el.value = (v==null?'':v); }
// 仅加载 SMTP/订阅邮件模板（SMTP 字段在「订阅管理」页，模板在「设置」页）
async function loadSubscribeSettings(){
  try{
    const r = await api('/admin/api/subscribe/settings');
    if(r.ok && r.data){
      const d = r.data;
      subSet('smHost', d.host); subSet('smPort', d.port); subSet('smUser', d.user);
      subSet('smFromName', d.fromName); subSet('smFromEmail', d.fromEmail);
      subSet('smSiteName', d.siteName); subSet('smSiteUrl', d.siteUrl);
      subSet('smSubject', d.subject); subSet('smBody', d.body);
      subSet('smNotifySubject', d.notifySubject); subSet('smNotifyBody', d.notifyBody);
      subSet('smUnsubSubject', d.unsubSubject); subSet('smUnsubBody', d.unsubBody);
      const p = $('#smPass');
      if(p){ p.value=''; p.placeholder = d.hasPass ? '已保存（留空表示不修改）' : '未设置'; }
      const ck = $('#smNeedConfirm'); if(ck) ck.checked = !!d.needConfirm;
      subSet('smDailyLimit', d.dailyLimit);
      subSet('subDailyLimit', d.dailyLimit);
      subSet('smVerify', d.verify || 'none');
      subSet('smCfSiteKey', d.cfSiteKey);
      const sk = $('#smCfSecretKey');
      if(sk){ sk.value=''; sk.placeholder = d.hasCfSecret ? '已保存（留空表示不修改）' : '未设置'; }
      toggleCfFields();
      const pu = $('#subPageUrl'); if(pu) pu.value = location.origin + '/subscribe';
    }
  }catch(e){}
}
function toggleCfFields(){
  const sel = $('#smVerify'), box = $('#smCfBox');
  if(sel && box) box.style.display = sel.value === 'cf' ? '' : 'none';
}
async function copySubPageUrl(){
  const el = $('#subPageUrl'); if(!el || !el.value) return;
  try{ await navigator.clipboard.writeText(el.value); toast('订阅页面链接已复制'); }
  catch(e){ el.select(); toast('请手动复制', true); }
}
async function loadSubscribe(){
  await loadSubscribeSettings();
  loadSubscribers();
}
async function saveSubscribeSettings(){
  const v = id => { const el=$('#'+id); return el ? el.value : ''; };
  const ck = $('#smNeedConfirm');
  const payload = {
    host: v('smHost').trim(), port: v('smPort'), user: v('smUser').trim(),
    pass: v('smPass'), fromName: v('smFromName'), fromEmail: v('smFromEmail').trim(),
    siteName: v('smSiteName'), siteUrl: v('smSiteUrl').trim(),
    subject: v('smSubject'), body: v('smBody'), needConfirm: !!(ck && ck.checked),
    notifySubject: v('smNotifySubject'), notifyBody: v('smNotifyBody'),
    unsubSubject: v('smUnsubSubject'), unsubBody: v('smUnsubBody'),
    dailyLimit: v('smDailyLimit'),
    verify: v('smVerify') || 'none',
    cfSiteKey: v('smCfSiteKey').trim(), cfSecretKey: v('smCfSecretKey')
  };
  const r = await api('/admin/api/subscribe/settings', { method:'PUT', body: JSON.stringify(payload) });
  const msg = $('#smtpMsg') || $('#subMsg');
  if(r.ok){
    toast('配置已保存');
    if(msg){ msg.className='msg ok'; msg.textContent='配置已保存'; }
    const p = $('#smPass'); if(p) p.value='';
    const sk = $('#smCfSecretKey'); if(sk) sk.value='';
    loadSubscribe();
  } else {
    const err = (r.data && r.data.error) || '保存失败';
    toast(err, true);
    if(msg){ msg.className='msg err'; msg.textContent=err; }
  }
}
async function sendSubscribeTest(){
  const to = ((($('#smTestTo')||{}).value) || '').trim();
  if(!to){ toast('请输入测试收件邮箱', true); return; }
  toast('发送中...');
  const r = await api('/admin/api/subscribe/test', { method:'POST', body: JSON.stringify({ to: to }) });
  if(r.ok) toast((r.data && r.data.message) || '测试邮件已发送');
  else toast('发送失败：' + ((r.data && r.data.error) || '未知错误'), true);
}
async function loadSubscribers(){
  const box = $('#subList');
  const st = $('#subStatus'), q = $('#subQ');
  const ps = [];
  if(st && st.value) ps.push('status=' + encodeURIComponent(st.value));
  if(q && q.value.trim()) ps.push('q=' + encodeURIComponent(q.value.trim()));
  try{
    const r = await api('/admin/api/subscribe/list' + (ps.length ? '?' + ps.join('&') : ''));
    if(!r.ok || !r.data){ if(box) box.innerHTML = '<div class="empty">加载失败</div>'; return; }
    const d = r.data, s = d.stats || {};
    const set = (id, n) => { const el=$('#'+id); if(el) el.textContent = (n==null?'-':n); };
    set('subTotal', s.total); set('subConfirmed', s.confirmed);
    set('subPending', s.pending); set('subUnsub', s.unsubscribed);
    set('subToday', s.today);
    const list = d.list || [];
    if(!box) return;
    if(!list.length){ box.innerHTML = '<div class="empty">暂无订阅者</div>'; return; }
    const cls = { confirmed:'ok', pending:'wait', unsubscribed:'off' };
    const label = { confirmed:'已确认', pending:'待确认', unsubscribed:'已退订' };
    let h = '<table class="wk-table"><thead><tr><th>邮箱</th><th>状态</th><th>订阅时间</th><th></th></tr></thead><tbody>';
    list.forEach(x => {
      const passBtn = x.status === 'pending'
        ? '<button class="wk-btn sm" onclick="approveSubscriber(' + x.id + ')">通过</button> '
        : '';
      h += '<tr><td>' + esc(x.email) + '</td>'
        + '<td><span class="wk-tag ' + (cls[x.status]||'') + '">' + esc(label[x.status]||x.status) + '</span></td>'
        + '<td>' + esc((x.createdAt||'').slice(0,10)) + '</td>'
        + '<td style="text-align:right">' + passBtn + '<button class="wk-btn ghost sm" onclick="delSubscriber(' + x.id + ')">删除</button></td></tr>';
    });
    h += '</tbody></table>';
    box.innerHTML = h;
  }catch(e){ if(box) box.innerHTML = '<div class="empty">加载失败</div>'; }
}
async function delSubscriber(id){
  if(!await askConfirm('确认删除该订阅者？')) return;
  const r = await api('/admin/api/subscribe/subscriber?id=' + id, { method:'DELETE' });
  if(r.ok){ toast('已删除'); loadSubscribers(); } else toast('删除失败', true);
}
async function approveSubscriber(id){
  if(!await askConfirm('确认通过该订阅者？通过后立即变为「已确认」，无需对方点邮件确认。')) return;
  const r = await api('/admin/api/subscribe/approve', { method:'POST', body: JSON.stringify({ id: id }) });
  if(r.ok){ toast('已通过'); loadSubscribers(); } else toast('操作失败：' + ((r.data && r.data.error) || '未知错误'), true);
}
async function saveSubLimit(){
  const el = $('#subDailyLimit');
  const v = el ? el.value : '';
  const r = await api('/admin/api/subscribe/settings', { method:'PUT', body: JSON.stringify({ dailyLimit: v }) });
  const msg = $('#subLimitMsg');
  if(r.ok){
    toast('已保存当日订阅上限');
    if(msg){ msg.className='msg ok'; msg.textContent='已保存'; }
    loadSubscribeSettings();
  } else {
    const err = (r.data && r.data.error) || '保存失败';
    toast(err, true);
    if(msg){ msg.className='msg err'; msg.textContent=err; }
  }
}
async function broadcastSubscribe(){
  const v = id => { const el=$('#'+id); return el ? el.value : ''; };
  const subject = v('bcSubject').trim(), body = v('bcBody').trim();
  if(!subject || !body){ toast('请填写主题和正文', true); return; }
  if(!await askConfirm('确认发送给全部已确认订阅者？')) return;
  toast('发送中，请稍候...');
  const r = await api('/admin/api/subscribe/send', { method:'POST', body: JSON.stringify({ subject: subject, body: body }) });
  if(r.ok){
    const d = r.data || {};
    let tip = '发送完成：成功 ' + (d.sent||0) + '，失败 ' + (d.failed||0);
    if(d.limited) tip += '（单次上限 100 封，可再次点击继续）';
    toast(tip);
  } else toast('发送失败：' + ((r.data && r.data.error) || '未知错误'), true);
}

// ---------- 管理文章 ----------
// 用历史分类/标签填充输入框浏览器原生 datalist（可输入或从历史下拉选择）
let allTagOptions=[];
function wireTaxonomySuggest(d){
  const ac=d&&d.allCategories||[], at=d&&d.allTags||[];
  allTagOptions=(at||[]).slice();
  const cl=$('#catList'), tl=$('#tagList');
  if(cl){ cl.innerHTML=''; ac.forEach(x=>{ const o=document.createElement('option'); o.value=x; cl.appendChild(o); }); }
  if(tl){ tl.innerHTML=''; at.forEach(x=>{ const o=document.createElement('option'); o.value=x; tl.appendChild(o); }); }
}
// ---------- 标签联想（多标签：英文逗号分隔，逗号后继续联想）----------
// 原生 datalist 在输入框含逗号后就不再弹建议，这里改为自定义下拉：
// 只对「最后一个逗号之后」的片段联想，并自动排除已输入过的标签
let tagSugItems=[], tagSugIdx=-1;
function tagSugParts(v){ return String(v==null?'':v).split(/[,，]/); }
function updateTagSug(){
  const box=$('#tagSug'), inp=$('#tags');
  if(!box||!inp) return;
  const parts=tagSugParts(inp.value);
  const q=(parts[parts.length-1]||'').trim().toLowerCase();
  if(!q){ hideTagSug(); return; }
  const entered=parts.map(s=>s.trim().toLowerCase()).filter(Boolean);
  entered.pop();
  tagSugItems=allTagOptions.filter(t=>t&&String(t).toLowerCase().indexOf(q)>=0&&!entered.includes(String(t).toLowerCase())).slice(0,8);
  if(!tagSugItems.length){ hideTagSug(); return; }
  tagSugIdx=-1;
  box.innerHTML=tagSugItems.map((t,i)=>'<div class="tag-sug-item" data-i="'+i+'" onmousedown="pickTagSug(event,'+i+')">'+esc(t)+'</div>').join('');
  box.style.display='block';
}
function pickTagSug(e,i){
  if(e) e.preventDefault();
  const t=tagSugItems[i], inp=$('#tags');
  if(t==null||!inp) return;
  const parts=tagSugParts(inp.value);
  parts[parts.length-1]=t;
  inp.value=parts.join(', ').replace(/\\s+$/,'')+', ';
  hideTagSug();
  inp.focus();
}
function tagSugKey(e){
  const box=$('#tagSug');
  const open=!!box&&box.style.display==='block';
  if(!open){ if(e.key==='ArrowDown'||e.key==='ArrowUp') updateTagSug(); return; }
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    tagSugIdx=(tagSugIdx+(e.key==='ArrowDown'?1:tagSugItems.length-1))%tagSugItems.length;
    box.querySelectorAll('.tag-sug-item').forEach((el,i)=>el.classList.toggle('active',i===tagSugIdx));
  } else if(e.key==='Enter'){
    if(tagSugIdx>=0){ e.preventDefault(); pickTagSug(null,tagSugIdx); } else hideTagSug();
  } else if(e.key==='Escape'){ hideTagSug(); }
}
function hideTagSug(){ const box=$('#tagSug'); if(box) box.style.display='none'; }
// 独立拉取历史分类/标签，填充写作页下拉建议（管理页由 loadPosts 调用；写作页单独调用）
async function loadTaxonomySuggest(){
  const r=await api(API_BASE+'/posts');
  if(r.ok&&r.data) wireTaxonomySuggest(r.data);
}
let rawPosts=[];
function fillPostFilterOptions(){
  const cats=[...new Set(rawPosts.flatMap(p=>p.categories||[]))].sort();
  const tags=[...new Set(rawPosts.flatMap(p=>p.tags||[]))].sort();
  const exts=[...new Set(rawPosts.map(p=>((String(p.name||'').split('.').pop()||'').toLowerCase()))).values()].filter(Boolean).sort();
  const extLabel=e=>({md:'MD',markdown:'MARKDOWN',txt:'TXT'}[e]||e.toUpperCase());
  const fc=$('#postFCat'), ft=$('#postFTag'), ff=$('#postFFmt');
  if(fc){
    const keep=fc.value;
    fc.innerHTML='<option value="">全部</option>'+cats.map(c=>'<option>'+esc(c)+'</option>').join('');
    if([...fc.options].some(o=>o.value===keep)) fc.value=keep;
  }
  if(ft){
    const keep=ft.value;
    ft.innerHTML='<option value="">全部</option>'+tags.map(t=>'<option>'+esc(t)+'</option>').join('');
    if([...ft.options].some(o=>o.value===keep)) ft.value=keep;
  }
  if(ff){
    const keep=ff.value;
    ff.innerHTML='<option value="">全部格式</option>'+exts.map(e=>'<option value="'+esc(e)+'">'+extLabel(e)+'</option>').join('');
    if([...ff.options].some(o=>o.value===keep)) ff.value=keep;
  }
}
function applyPostView(){
  const list=$('#postList'); if(!list) return;
  const sortV=($('#postSort')||{}).value||'date-desc';
  const cat=($('#postFCat')||{}).value||'';
  const tag=($('#postFTag')||{}).value||'';
  const fmt=($('#postFFmt')||{}).value||'';
  const q=(($('#postFQ')||{}).value||'').trim().toLowerCase();
  let ps=rawPosts.slice();
  if(cat) ps=ps.filter(p=>(p.categories||[]).some(c=>c===cat));
  if(tag) ps=ps.filter(p=>(p.tags||[]).some(t=>t===tag));
  if(fmt) ps=ps.filter(p=>String(p.name||'').toLowerCase().endsWith('.'+fmt));
  if(q) ps=ps.filter(p=>(String(p.name||'').toLowerCase().includes(q)));
  // 升序/降序比较器（无日期都排最后），同序时按文件名稳定排序
  const dateAsc=(a,b)=>((a.date||'')==='')-((b.date||'')==='')||String(a.date||'').localeCompare(String(b.date||''));
  const dateDesc=(a,b)=>((a.date||'')==='')-((b.date||'')==='')||String(b.date||'').localeCompare(String(a.date||''));
  const nameCmp=(a,b)=>String(a.name||'').localeCompare(String(b.name||''));
  ps.sort((a,b)=>{
    if(sortV==='date-asc') return dateAsc(a,b)||nameCmp(a,b);
    if(sortV==='date-desc') return dateDesc(a,b)||nameCmp(a,b);
    if(sortV==='size-asc') return (a.size||0)-(b.size||0)||nameCmp(a,b);
    return (b.size||0)-(a.size||0)||nameCmp(a,b); // size-desc
  });
  const total=$('#postTotal'); if(total) total.textContent = ps.length===rawPosts.length ? ('共 '+rawPosts.length+' 篇') : ('显示 '+ps.length+' / '+rawPosts.length+' 篇');
  selectedPosts.clear();
  if(!rawPosts.length){ list.innerHTML='<li class="empty">还没有文章，点右上角「＋ 添加新文章」开始写作</li>'; hideBatchBar(); return; }
  if(!ps.length){ list.innerHTML='<li class="empty">没有符合条件的文章，调整上方过滤条件</li>'; hideBatchBar(); return; }
  list.innerHTML='';
  ps.forEach(p=>{
    const li=document.createElement('li');
    const name=(p.name||'').replace(/\\.md$/,'');
    const cat=(p.categories||[]).map(esc).join(' / ');
    const tag=(p.tags||[]).map(esc).join(' · ');
    const dt=p.date?'<span class="chip">'+esc(p.date)+'</span>':'';
    const sz=p.size?'<span class="chip">'+(p.size/1024).toFixed(1)+' KB</span>':'';
    const taxo='<div class="meta">'+esc(p.path)+'</div>'+dt+sz+(cat?'<span class="chip">'+cat+'</span>':'')+(tag?'<span class="chip chipTag">'+tag+'</span>':'');
    li.innerHTML = '<div style="display:flex;align-items:center;gap:10px;min-width:0">'+
        '<input type="checkbox" class="postCheck" data-path="'+esc(p.path)+'" style="width:auto;flex-shrink:0">'+
        '<div><div class="name">'+esc(name)+'</div>'+taxo+'</div>'+
      '</div>'+
      '<div class="ops">'+
      '<button class="wk-btn ghost sm" data-a="edit" data-path="'+esc(p.path)+'">编辑</button>'+
      '<button class="wk-btn danger sm" data-a="del" data-path="'+esc(p.path)+'" data-name="'+esc(name)+'">删除</button>'+
      '</div>';
    list.appendChild(li);
  });
  showBatchBar();
}
async function loadPosts(){
  const list = $('#postList'); if(!list) return;
  list.innerHTML = '<li class="empty">加载中...</li>';
  const r = await api(API_BASE+'/posts');
  if(r.status===401){ redirectLogin(); return; }
  if(!r.ok){ list.innerHTML = '<li class="empty">加载失败：'+(r.data&&r.data.error||r.status)+'</li>'; hideBatchBar(); return; }
  rawPosts = r.data.posts||[];
  wireTaxonomySuggest(r.data);
  fillPostFilterOptions();
  applyPostView();
}
// ---------- 管理文章：多选 / 批量操作 ----------
let selectedPosts = new Set();
function showBatchBar(){ const b=$('#batchBar'); if(b) b.classList.remove('hidden'); updateBatchBar(); }
function hideBatchBar(){ const b=$('#batchBar'); if(b) b.classList.add('hidden'); }
function updateBatchBar(){
  const n=selectedPosts.size;
  const cnt=$('#pickCount'); if(cnt) cnt.textContent=n;
  const del=$('#batchDelBtn'); if(del) del.disabled = n===0;
  const all=$('#pickAll');
  if(all){ const boxes=$$('#postList .postCheck'); all.checked = boxes.length>0 && n===boxes.length; }
}
async function deleteSelectedPosts(){
  const paths=Array.from(selectedPosts);
  if(!paths.length){ toast('请先勾选要删除的文章'); return; }
  if(!await askConfirm('确认删除所选 '+paths.length+' 篇文章？\\n将移入回收站（可恢复），对应评论也会一并删除。')) return;
  const delBtn=$('#batchDelBtn');
  if(delBtn){ delBtn.disabled=true; delBtn.textContent='删除中…'; }
  opBanner('正在删除所选 '+paths.length+' 篇文章…（文章越多耗时越长，请勿关闭页面）','busy');
  const r=await api(API_BASE+'/posts/delete',{method:'POST',body:JSON.stringify({paths:paths})});
  if(delBtn){ delBtn.disabled=false; delBtn.textContent='删除所选'; }
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    const fails=(r.data.results||[]).filter(x=>!x.ok);
    let msg='已删除 '+(r.data.moved||0)+'/'+(r.data.total||paths.length)+' 篇（已移入回收站）';
    if(fails.length) msg+='，失败 '+(fails.length)+' 篇：'+fails.slice(0,3).map(x=>(x.path||'').split('/').pop()).join('、')+(fails.length>3?' 等':'')+'（可重试）';
    postOpDone(msg, r.data, 'neutral');
    await loadPosts();
  } else opBannerEnd('批量删除失败：'+(r.data&&r.data.error||r.status),false);
}
// ---------- 批量上传（独立页面：多次选文件累加到列表，一键发布）----------
let uploadQueue=[];
async function addUploadFiles(files){
  if(!files||!files.length) return;
  let added=0, skipped=0;
  for(let i=0;i<files.length;i++){
    const f=files[i];
    if(uploadQueue.some(function(x){ return x.name===f.name; })){ skipped++; continue; }
    try{ uploadQueue.push({name:f.name, size:f.size||0, content:await f.text()}); added++; }
    catch(e){ toast('读取「'+f.name+'」失败',true); }
  }
  renderUploadList();
  if(added) toast('已加入 '+added+' 个文件'+(skipped?('，跳过 '+skipped+' 个同名文件'):''));
}
function fmtSize(n){
  n=Number(n)||0;
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/1024/1024).toFixed(1)+' MB';
}
function renderUploadList(){
  const box=$('#uploadList'); if(!box) return;
  if(!uploadQueue.length){
    box.innerHTML='<li class="empty">还没有选择文件；点「＋ 选择文件」把文章加入列表，可分多次选</li>';
    updateUploadBar();
    return;
  }
  box.innerHTML=uploadQueue.map(function(f){
    return '<li><div style="display:flex;align-items:center;gap:10px;min-width:0">'+
      '<div><div class="name">'+esc(f.name)+'</div><div class="meta">'+fmtSize(f.size)+'</div></div>'+
      '</div>'+
      '<div class="ops"><button class="wk-btn ghost sm" data-a="rm" data-name="'+esc(f.name)+'">移除</button></div></li>';
  }).join('');
  updateUploadBar();
}
function updateUploadBar(){
  const c=$('#uploadCount'); if(c) c.textContent=uploadQueue.length;
  const p=$('#upPublishBtn'); if(p) p.disabled=!uploadQueue.length;
}
function onUploadListClick(e){
  const btn=e.target.closest('button'); if(!btn) return;
  if(btn.dataset.a!=='rm') return;
  uploadQueue=uploadQueue.filter(function(x){ return x.name!==btn.dataset.name; });
  renderUploadList();
}
async function clearUploadQueue(){
  if(!uploadQueue.length) return;
  if(!await askConfirm('清空已选的 '+uploadQueue.length+' 个文件？')) return;
  uploadQueue=[];
  renderUploadList();
}
async function publishUploadQueue(){
  if(!uploadQueue.length){ toast('请先选择文件',true); return; }
  const n=uploadQueue.length;
  if(!await askConfirm('确定一键发布 '+n+' 篇文章到 GitHub 吗？')) return;
  opBanner('正在上传 '+n+' 篇文章…','busy');
  const out=uploadQueue.map(function(f){ return {name:f.name, content:f.content}; });
  const r=await api(API_BASE+'/posts/upload',{method:'POST',body:JSON.stringify({files:out})});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.created>0){
    uploadQueue=[];
    renderUploadList();
    postOpDone('已发布 '+(r.data.created||0)+'/'+(r.data.total||n)+' 篇文章（已推送到 GitHub）', r.data);
    loadPosts();
  } else {
    const firstErr=(r.data&&r.data.results&&r.data.results[0]&&r.data.results[0].error)||(r.data&&r.data.error)||r.status;
    opBannerEnd('发布失败：'+firstErr,false);
  }
}
function onListClick(e){
  const btn=e.target.closest('button'); if(!btn) return;
  const path=btn.dataset.path, name=btn.dataset.name;
  if(btn.dataset.a==='edit') openEdit(path);
  if(btn.dataset.a==='del') delPost(path,name);
}
async function openEdit(path){
  editingPath=path;
  opBanner('正在加载文章内容…','busy');
  const r=await api(API_BASE+'/post?path='+encodeURIComponent(path));
  if(r.status===401){ redirectLogin(); return; }
  if(!r.ok){
    editingPath='';
    opBannerEnd('加载文章失败：'+((r.data&&r.data.error)||r.status||'网络异常'),false);
    toast('加载文章失败：'+((r.data&&r.data.error)||r.status||'网络异常'),true);
    return;
  }
  opBannerHide();
  const p=r.data.post||{};
  $('#title').value=p.title||'';
  $('#date').value=(p.date||localToday()).slice(0,10);
  $('#tags').value=(p.tags||[]).join(', ');
  $('#categories').value=(p.categories||[]).join('，');
  $('#editorTitle').textContent='编辑：'+(p.title||nameOf(p.path));
  $('#saveBtn').textContent='保存修改';
  hideBuildBanner();
  pendingEditorValue=p.body||'';
  go('write');
  initEditorOnce();
  loadTaxonomySuggest(); // 编辑页也需要分类/标签历史建议（SPA 切换不会重新加载页面）
}
function nameOf(path){ return String(path||'').split('/').pop().replace(/\\.md$/,'')||'未命名'; }
function backToManage(){ go('manage'); }

async function savePost(){
  const title=$('#title').value.trim();
  const content=editor?editor.getValue():'';
  if(!title){ toast('请填写标题',true); return; }
  if(!content.trim()){ toast('请填写正文',true); return; }
  const body={ title, content,
    date:$('#date').value||localToday(),
    tags:$('#tags').value.split(/[,，\\s]+/).map(s=>s.trim()).filter(Boolean),
    categories:$('#categories').value.split(/[,，\\s]+/).map(s=>s.trim()).filter(Boolean) };
  if(editingPath) body.path=editingPath;
  const isUpd=!!editingPath;
  $('#saveBtn').disabled=true; $('#saveBtn').textContent='提交中...';
  opBanner(isUpd?'正在保存修改…':'正在发布文章…','busy');
  const r=await api(API_BASE+'/post',{method:isUpd?'PUT':'POST',body:JSON.stringify(body)});
  $('#saveBtn').disabled=false; $('#saveBtn').textContent=isUpd?'保存修改':'发布文章';
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    clearDraft();
    go('manage');
    postOpDone(isUpd?'已保存并推送到 GitHub':'已发布并推送到 GitHub', r.data);
  } else opBannerEnd('保存失败：'+(r.data&&r.data.error||r.status),false);
}
async function delPost(path,name){
  if(!await askConfirm('确认删除文章「'+name+'」？将移入回收站，可恢复。')) return;
  opBanner('正在删除文章「'+name+'」…','busy');
  const r=await api(API_BASE+'/post?path='+encodeURIComponent(path),{method:'DELETE'});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    postOpDone('已删除文章「'+name+'」（已移入回收站）', r.data, 'neutral');
    loadPosts();
  }
  else opBannerEnd('删除失败：'+(r.data&&r.data.error||r.status),false);
}

// ---------- Vditor「分屏复杂模式」----------
function initEditorOnce(){
  // 等待 Vditor 脚本就绪
  if(!window.Vditor){ if(++editorReadyWait<200) setTimeout(initEditorOnce,250); return; }
  if(!editorInited){ initEditor(); }
  else if(editor){
    if(pendingEditorValue!=='' && editor.getValue()!==pendingEditorValue){
      editor.setValue(pendingEditorValue);
    }
    pendingEditorValue='';
    try{ editor.focus(); }catch(e){}
  }
}
function initEditor(){
  const opts={
    height: 540,
    lang: 'zh_CN',
    mode: 'sv',                       // 分屏预览「复杂模式」（cp.802213.xyz）
    theme: isDarkMode()?'dark':'classic',
    icon: 'ant',
    outline: true,
    counter: { enable: true, type: 'text' },
    cache: { enable: false },
    preview: {
      delay: 300,
      hljs: { enable:true, lineNumber:false, style: isDarkMode()?'atom-one-dark':'github' },
      markdown: { toc:true, mark:true, math:true, codeBlockPreview:true, at:true, gfmAutoLink:true, footnotes:true },
      tex: { inline:true, display:true },
      theme: { current: isDarkMode()?'dark':'light' }
    },
    previewTheme: isDarkMode()?'dark':'light',
    codeTheme: 'github',
    toolbarConfig: { pin: true, hide: false },
    toolbar: [
      'emoji','headings','bold','italic','strike','link','|',
      'list','ordered-list','check','outdent','indent','|',
      'quote','line','code','inline-code','table','|',
      'undo','redo','|','upload','record','|',
      'edit-mode','both','preview','fullscreen','outline','export','br'
    ],
    upload: { fieldName:'file', encoding:'base64', insertTo:2, linkToImgUrl:true },
    input: (v)=>{ saveDraft(); },
    after: ()=>{ editorInited=true; if(editor&&pendingEditorValue!==''){ editor.setValue(pendingEditorValue); pendingEditorValue=''; } }
  };
  try {
    editor = new Vditor('edt', opts);
    // 若 after 未触发，兜底延迟注入正文
    setTimeout(()=>{ if(editor&&pendingEditorValue!==''){ editor.setValue(pendingEditorValue); pendingEditorValue=''; } }, 800);
  } catch(e){
    console.error('Vditor init error:', e);
    $('#edt').innerHTML='<textarea id="edtFallback" style="width:100%;min-height:480px;"></textarea>';
    if(pendingEditorValue!==''){ const ta=document.querySelector('#edtFallback'); if(ta) ta.value=pendingEditorValue; pendingEditorValue=''; }
  }
}

// ---------- 评论管理 ----------
let commentFilter='all';
function setCommentFilter(f){
  commentFilter=f;
  $$('#commentFilter .wk-btn').forEach(b=>b.classList.toggle('act', b.dataset.f===f));
  loadComments();
}
async function loadComments(){
  const box=$('#commentList'); if(!box) return;
  box.innerHTML='<div class="empty">加载中...</div>';
  selectedComments.clear();
  updateCommentBatch();
  const statusParam=commentFilter==='all'?'':('&status='+commentFilter);
  const r=await api('/waline/api/comment?type=list&page=1&pageSize=100'+statusParam);
  if(r.status===401||r.status===403){ redirectLogin(); return; }
  const data=(r.data&&r.data.data)||{};
  const items=data.data||[];
  if(!items.length){ box.innerHTML='<div class="empty">暂无评论</div>'; return; }
  const nickById=new Map(items.map(it=>[it.objectId,it.nick]));
  box.innerHTML='';
  items.forEach(it=>{
    const el=document.createElement('div');
    el.className='wk-comment';
    const st=it.status==='approved'?'<span class="status approved">已通过</span>':(it.status==='spam'?'<span class="status spam">垃圾</span>':'<span class="status waiting">待审批</span>');
    const adminBadge=(it.is_admin||it.type==='administrator')?'<span class="status admin">站长</span>':'';
    const replyTo=(it.pid&&nickById.get(it.pid))?'<span class="path">回复 @'+esc(nickById.get(it.pid))+'</span>':'';
    const time=it.insertedAt?new Date(it.insertedAt).toLocaleString('zh-CN',{hour12:false}):'';
    let ops='<button class="wk-btn sm" data-a="reply">回复</button>';
    if(it.status!=='approved') ops+='<button class="wk-btn sm" data-a="approve">通过</button>';
    if(it.status!=='spam') ops+='<button class="wk-btn act sm" data-a="spam">垃圾</button>';
    ops+='<button class="wk-btn danger sm" data-a="del">删除</button>';
    el.innerHTML='<input type="checkbox" class="cmtCheck" style="width:auto;flex-shrink:0;align-self:flex-start;margin-top:3px">'+
      '<div class="avatar">'+(it.avatar?'<img src="'+esc(it.avatar)+'">':'')+'</div>'+
      '<div style="flex:1;min-width:0">'+
        '<div><span class="nick">'+esc(it.nick)+'</span>'+adminBadge+replyTo+'<span class="mail">'+esc(it.mail||'')+'</span><span class="ip">'+esc(it.ip||'')+'</span><span class="path">'+esc(it.url||'')+'</span><span class="time">'+esc(time)+'</span>'+st+'</div>'+
        '<div class="body">'+(it.comment||'')+'</div>'+
        '<div class="ops">'+ops+'</div>'+
        '<div class="reply-box hidden"><textarea placeholder="以站长身份回复该评论（发布后直接显示在评论区，并标注站长回复）"></textarea><div class="reply-ops"><button class="wk-btn act sm" data-a="sendReply">发送回复</button><button class="wk-btn sm" data-a="cancelReply">取消</button></div></div>'+
      '</div>';
    el.dataset.id=it.objectId;
    box.appendChild(el);
  });
}
// ---------- 评论多选批量删除 ----------
let selectedComments=new Set();
function updateCommentBatch(){
  const n=selectedComments.size;
  const cnt=$('#cmtCount'); if(cnt) cnt.textContent=n;
  const btn=$('#cmtBatchDel'); if(btn) btn.disabled=n===0;
  const all=$('#cmtPickAll');
  if(all){ const boxes=$$('#commentList .cmtCheck'); all.checked=boxes.length>0&&n===boxes.length; }
}
async function deleteSelectedComments(){
  const ids=Array.from(selectedComments);
  if(!ids.length){ toast('请先勾选要删除的评论'); return; }
  if(!await askConfirm('确认删除所选 '+ids.length+' 条评论？\\n此操作不可恢复。')) return;
  const btn=$('#cmtBatchDel');
  const btnHtml=btn?btn.innerHTML:'';
  if(btn){ btn.disabled=true; btn.textContent='删除中…'; }
  opBanner('正在删除所选 '+ids.length+' 条评论…','busy');
  let okN=0;
  for(const id of ids){
    try{ const r=await api('/waline/api/comment/'+id,{method:'DELETE'}); if(r.ok) okN++; }catch(e){}
  }
  if(btn){ btn.disabled=false; btn.innerHTML=btnHtml; }
  opBannerHide();
  toast('已删除 '+okN+'/'+ids.length+' 条评论', okN<ids.length);
  selectedComments.clear();
  loadComments();
}
async function onCommentAction(e){
  const btn=e.target.closest('button'); if(!btn) return;
  const card=btn.closest('.wk-comment'); if(!card) return;
  const id=card.dataset.id, a=btn.dataset.a; if(!id) return;
  if(a==='reply'){
    const box=card.querySelector('.reply-box'); if(!box) return;
    box.classList.toggle('hidden');
    if(!box.classList.contains('hidden')){ const ta=box.querySelector('textarea'); if(ta) ta.focus(); }
    return;
  }
  if(a==='cancelReply'){
    const box=card.querySelector('.reply-box'); if(box) box.classList.add('hidden');
    return;
  }
  if(a==='sendReply'){
    const box=card.querySelector('.reply-box');
    const ta=box&&box.querySelector('textarea');
    const text=((ta&&ta.value)||'').trim();
    if(!text){ toast('请输入回复内容'); if(ta) ta.focus(); return; }
    const old=btn.textContent;
    btn.disabled=true; btn.textContent='发送中…';
    const r=await api('/admin/api/comment/reply',{method:'POST',body:JSON.stringify({parentId:Number(id),comment:text})});
    btn.disabled=false; btn.textContent=old;
    if(r.ok){ toast('回复已发布'); loadComments(); }
    else toast((r.data&&r.data.error)||'回复失败',true);
    return;
  }
  if(a==='del'&&!await askConfirm('确认删除该评论？')) return;
  if(a==='approve'||a==='spam'){
    const r=await api('/waline/api/comment/'+id,{method:'PUT',body:JSON.stringify({status:a==='approve'?'approved':'spam'})});
    if(r.ok) loadComments(); else toast('操作失败',true);
  } else if(a==='del'){
    const r=await api('/waline/api/comment/'+id,{method:'DELETE'});
    if(r.ok) loadComments(); else toast('操作失败',true);
  }
}

// ---------- 构建状态横幅 ----------
let buildTimer=null;
// 工作流文件名 -> 友好名称（顶部横幅用）
function wfLabel(run){
  const f=String(run&&(run.workflow||'')).toLowerCase();
  const map={'deploy.yml':'完整部署','update-gh.yml':'更新 GitHub Pages','update-cf.yml':'更新 Cloudflare Worker','clone-repo.yml':'克隆仓库','unzip.yml':'解压文件'};
  return map[f]||(run&&(run.name||run.workflow))||'工作流';
}
function isBuildActive(s){ return s==='in_progress'||s==='queued'||s==='pending'||s==='waiting'; }
// 「关闭」只针对某一次运行：更早运行的关闭记录不会影响新的运行；运行中不提供关闭按钮
function buildDismissKey(id){ return 'bn_dismissed_'+String(id||''); }
function isBuildDismissed(id){ try{ return !!(id&&localStorage.getItem(buildDismissKey(id))==='1'); }catch(e){ return false; } }
function dismissBuildBanner(id){
  try{ if(id) localStorage.setItem(buildDismissKey(id),'1'); }catch(e){}
  hideBuildBanner();
}
// 进入管理页 / AI 操作工作流后：按「所有正在运行的工作流」刷新横幅；无运行中则显示最近一次结果
async function initBuildStatus(){
  if(opBannerBusy) return; // 有本地操作正在进行：不要用工作流状态覆盖操作日志
  const r=await api(API_BASE+'/workflows/runs?limit=30');
  const d=r.data||{};
  if(!r.ok||!d||!d.ok) return;
  const runs=relevantRuns(d.runs||[]);
  if(activeRuns(runs).length){ showRunningBanner(runs); startBuildPoll(); return; }
  stopBuildPoll();
  const latest=runs[0]||null;
  if(!latest){ hideBuildBanner(); return; }
  showBuildResult(latest.conclusion, latest.id, wfLabel(latest));
}
// 只显示最近一小时内的运行：更早的成功/失败结果不再常驻顶部；叉掉后需有新运行才会再出现
function recentRuns(runs){
  const cut=Date.now()-3600*1000;
  return (runs||[]).filter(function(r){
    const t=Date.parse((r&&r.created_at)||'');
    return isNaN(t)?true:t>=cut;
  });
}
// 横幅只关心仓库里自己的工作流；GitHub Pages 在产物分支更新后自动跑的
// 「pages build and deployment」（无 workflow 文件，name 固定）不单列显示，避免出现两条运行中
function relevantRuns(runs){
  return recentRuns(runs).filter(function(r){
    if(r&&r.workflow) return true;
    return !/pages build/i.test(String((r&&r.name)||''));
  });
}
// 当前所有处于运行/排队状态的工作流（可能同时跑多个，如克隆 + 更新 GitHub）
function activeRuns(runs){
  return (runs||[]).filter(function(r){ return isBuildActive(r.status); });
}
// 在横幅里列出「所有正在运行的工作流」；同名工作流合并计数；运行中不给关闭按钮
function showRunningBanner(runs, extra){
  const act=activeRuns(runs);
  if(!act.length) return false;
  const counts={}, order=[];
  act.forEach(function(r){
    const lb=wfLabel(r);
    if(!counts[lb]){ counts[lb]=0; order.push(lb); }
    counts[lb]++;
  });
  const html=order.map(function(lb){
    return '<span class="build-run-item"><span class="build-dot"></span>正在运行「'+esc(lb)+'」工作流'+(counts[lb]>1?(' ×'+counts[lb]):'')+'…</span>';
  }).join('');
  showBuildBannerHtml(html+(extra?('<span style="color:var(--muted)">'+esc(extra)+'</span>'):''), '');
  return true;
}
// 只渲染顶部那一处横幅：此前同时写入页内横幅，导致同一状态被显示两遍（运行中会出现两条/四条）
function buildBannerTargets(){ return [$('#globalBuildBanner')]; }
// 允许横幅里放按钮/多个条目（运行中列出所有工作流；失败时提供「查看日志 / 发给 AI」）
function showBuildBannerHtml(html, cls){
  buildBannerTargets().forEach((b)=>{
    if(!b) return;
    b.className='build-banner '+(cls||'');
    b.innerHTML=html;
    b.classList.remove('hidden');
  });
}
function hideBuildBanner(){
  if(needWorkflowReminder){ showNeedWorkflowReminder(); return; }
  buildBannerTargets().forEach((b)=>{ if(b) b.classList.add('hidden'); });
}
// ---------- 手动模式提示（日志位置常驻，直到运行工作流或手动关闭）----------
let needWorkflowReminder=false, needWorkflowMsg='';
function showNeedWorkflowReminder(msg){
  needWorkflowReminder=true;
  needWorkflowMsg=msg||needWorkflowMsg||'内容已提交，需要运行工作流才会更新站点';
  showBuildBannerHtml('<span>'+esc(needWorkflowMsg)+'</span>'+
    '<button class="wk-btn sm" onclick="runUpdateWorkflow()">▶ 运行工作流</button>'+
    '<button class="build-x" title="关闭" onclick="dismissNeedWorkflowReminder()">×</button>','');
}
function dismissNeedWorkflowReminder(){ needWorkflowReminder=false; needWorkflowMsg=''; hideBuildBanner(); }
// 提示里的「运行工作流」：跑「更新 GitHub Pages」（与自动模式同一工作流），跑完即更新站点
async function runUpdateWorkflow(){
  const r=await api(API_BASE+'/workflows/trigger',{method:'POST',body:JSON.stringify({workflow_id:'update-gh.yml'})});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    needWorkflowReminder=false; needWorkflowMsg='';
    toast('已触发「更新 GitHub Pages」工作流');
    showBuildBannerHtml('<span class="build-run-item"><span class="build-dot"></span>正在运行「更新 GitHub Pages」工作流…</span>');
    setTimeout(function(){ initBuildStatus(); }, 3000);
  } else toast('触发失败：'+(r.data&&r.data.error||r.status),true);
}
// 发文/删文/批量上传完成后的统一提示：手动模式常驻提示「需运行工作流」，自动模式跟进构建进度
// ok：true=绿色成功、false=红色失败、'neutral'=中性（删除类操作不用绿色）
function postOpDone(msg, data, ok){
  if(ok===undefined) ok=true;
  if(data && data.workflow_mode==='manual' && data.need_workflow){
    showNeedWorkflowReminder(msg+'（手动模式：需运行工作流才会更新站点）');
    return;
  }
  needWorkflowReminder=false; needWorkflowMsg='';
  if(data && data.build_triggered){
    opBannerEnd(msg+'，正在自动构建站点…', ok);
    setTimeout(function(){ initBuildStatus(); }, 8000);
    return;
  }
  opBannerEnd(msg, ok);
}
// ---------- 通用操作日志横幅 ----------
// 与工作流横幅同一位置：文件删除/上传/克隆等耗时操作显示「正在…」与结果
let opBannerBusy=false, opBannerTimer=null, opBannerWatchdog=null;
function opBanner(msg, kind){
  const b=$('#globalBuildBanner'); if(!b) return;
  if(opBannerTimer){ clearTimeout(opBannerTimer); opBannerTimer=null; }
  if(opBannerWatchdog){ clearTimeout(opBannerWatchdog); opBannerWatchdog=null; }
  opBannerBusy = (kind==='busy');
  // 兜底：请求异常中止时避免「正在…」一直挂着
  if(opBannerBusy) opBannerWatchdog=setTimeout(function(){ opBannerBusy=false; const e=$('#globalBuildBanner'); if(e) e.classList.add('hidden'); }, 120000);
  b.className='build-banner'+(kind==='ok'?' ok':(kind==='err'?' err':''));
  b.innerHTML=(kind==='busy'?'<span class="build-run-item"><span class="build-dot"></span>':'')+'<span>'+esc(msg)+'</span>';
  b.classList.remove('hidden');
}
// 结束一条操作日志：ok 决定颜色（true=绿 / false=红 / 'neutral'=中性）；4 秒后自动隐藏并恢复工作流横幅
function opBannerEnd(msg, ok){
  if(opBannerWatchdog){ clearTimeout(opBannerWatchdog); opBannerWatchdog=null; }
  opBanner(msg, ok==='neutral'?'':(ok?'ok':'err'));
  opBannerBusy=false;
  if(opBannerTimer) clearTimeout(opBannerTimer);
  opBannerTimer=setTimeout(function(){
    const b=$('#globalBuildBanner'); if(b) b.classList.add('hidden');
    initBuildStatus();
  }, 4000);
}
// 当前是否有可展示的构建结果 + AI 是否已配置（决定是否显示「发给 AI」）
let aiConfigured=false;
async function checkAiConfigured(){
  try{
    const r=await api(API_BASE+'/ai/settings');
    const d=r.data||{};
    aiConfigured = !!(d.baseUrl && d.hasKey && ((d.models&&d.models.length) || d.model));
  }catch(e){ aiConfigured=false; }
}
// 终态（成功/失败）：都提供「关闭」按钮；失败另给「查看日志 / 发给 AI」。运行中不走这里（不给关闭）
function showBuildResult(conclusion, runId, label){
  const id = runId ? String(runId) : '';
  const name = label || '工作流';
  if(!conclusion){ hideBuildBanner(); return; }
  if(isBuildDismissed(id)){ hideBuildBanner(); return; }
  const ok = conclusion==='success' || conclusion==='completed';
  let html = ok
    ? '<span>「'+esc(name)+'」已完成</span>'
    : '<span>「'+esc(name)+'」运行失败（'+esc(conclusion)+'）</span>';
  if(!ok){
    html += '<button class="wk-btn ghost sm" onclick="showBuildLog(\\''+esc(id)+'\\')">查看日志(CF代理)</button>';
    if(aiConfigured) html += '<button class="wk-btn ghost sm" onclick="sendBuildLogsToAi(\\''+esc(id)+'\\')">发给 AI</button>';
  }
  html += '<button class="build-x" title="关闭" onclick="dismissBuildBanner(\\''+esc(id)+'\\')">×</button>';
  showBuildBannerHtml(html, ok?'ok':'err');
}
function stopBuildPoll(){ if(buildTimer){ clearInterval(buildTimer); buildTimer=null; } }
// 运行中：每 5 秒查一次「所有正在运行的工作流」，直到全部结束
function startBuildPoll(){
  stopBuildPoll();
  let tries=0;
  buildTimer=setInterval(async ()=>{
    tries++;
    if(opBannerBusy) return; // 本地操作进行中：暂停用工作流状态覆盖操作日志
    const r=await api(API_BASE+'/workflows/runs?limit=30');
    const d=r.data||{};
    if(!r.ok||!d.ok){ if(tries>=12) stopBuildPoll(); return; }
    const runs=relevantRuns(d.runs||[]);
    if(activeRuns(runs).length){ showRunningBanner(runs, '（已等待约 '+(tries*5)+' 秒）'); return; }
    stopBuildPoll();
    const latest=runs[0]||null;
    if(!latest){ hideBuildBanner(); return; }
    showBuildResult(latest.conclusion, latest.id, wfLabel(latest));
    const box=$('#buildHistory'); if(box) loadBuildHistory();
  }, 5000);
}
// AI 触发/取消工作流后同步顶部横幅：新运行要几秒才出现在接口里，先显示「运行中」再向服务端校正
function aiSyncBuildBanner(toolName, args, resultStr){
  if(toolName!=='trigger_build' && toolName!=='trigger_workflow' && toolName!=='cancel_workflow') return;
  needWorkflowReminder=false; needWorkflowMsg=''; // AI 已在处理工作流，撤下「需运行工作流」提示
  let ok=true;
  try{ ok = JSON.parse(String(resultStr||'{}')).ok !== false; }catch(e){ ok=true; }
  if(!ok){ setTimeout(function(){ initBuildStatus(); }, 1500); return; }
  if(toolName==='cancel_workflow'){ setTimeout(function(){ initBuildStatus(); }, 2500); return; }
  const wid=String((args&&(args.workflow_id||args.workflow))||'').trim();
  const label = toolName==='trigger_build' ? '完整部署' : wfLabel({workflow:wid.toLowerCase().split('/').pop()});
  // 新运行要几秒才出现在接口里：先乐观显示「正在运行该工作流」，再由服务端聚合出所有运行中的工作流
  showBuildBannerHtml('<span class="build-run-item"><span class="build-dot"></span>正在运行「'+esc(label)+'」工作流…</span>');
  stopBuildPoll();
  setTimeout(function(){ initBuildStatus(); }, 4000);
}

// ---------- 手动运行工作流 + 部署记录 ----------
async function triggerBuild(){
  // 先检测是否已有构建在跑/排队，避免手动触发叠加出重复构建
  const st=await api(API_BASE+'/build');
  if(st.ok&&st.data&&st.data.running){
    const n=(st.data.runs||[]).length;
    if(!await askConfirm('已有一个部署正在进行中'+(n>1?'（最近有 '+n+' 次构建）':'')+'，再触发一个会造成重复构建。确定还要运行吗？')) return;
  }
  if(!await askConfirm('确定运行部署工作流吗？将重建整个站点。')) return;
  const r=await api(API_BASE+'/build/trigger',{method:'POST'});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    needWorkflowReminder=false; needWorkflowMsg='';
    toast('已触发部署工作流，稍候开始构建');
    showBuildBannerHtml('<span class="build-run-item"><span class="build-dot"></span>正在运行「完整部署」工作流…</span>');
    // 触发后 run 需几秒才出现，稍作延迟后按「最近一次运行」校正横幅状态与刷新历史
    setTimeout(()=>{ initBuildStatus(); }, 3000);
    setTimeout(()=>{ const box=$('#buildHistory'); if(box) loadBuildHistory(); }, 4000);
  } else {
    toast('触发失败：'+(r.data&&r.data.error||r.status),true);
    if(r.data&&r.data.detail) toast(r.data.detail,true);
  }
}
// 运行「部署记录」页所选的工作流（workflow_dispatch）
async function triggerSelectedWorkflow(){
  const sel=$('#buildRunWf'); if(!sel) return;
  if(sel.options.length<=1) await loadBuildWorkflows();
  const wid=sel.value;
  if(!wid){ toast('请先选择要运行的工作流',true); return; }
  const label=wfLabel({workflow:wid});
  if(!await askConfirm('确定运行「'+label+'」工作流吗？')) return;
  const r=await api(API_BASE+'/workflows/trigger',{method:'POST',body:JSON.stringify({workflow_id:wid})});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    needWorkflowReminder=false; needWorkflowMsg='';
    toast('已触发「'+label+'」工作流');
    showBuildBannerHtml('<span class="build-run-item"><span class="build-dot"></span>正在运行「'+esc(label)+'」工作流…</span>');
    setTimeout(function(){ initBuildStatus(); }, 3000);
    setTimeout(function(){ loadBuildHistory(); }, 4000);
  } else {
    toast('触发失败：'+(r.data&&r.data.error||r.status),true);
    if(r.data&&r.data.detail) toast(r.data.detail,true);
  }
}
function buildBadge(status, conclusion){
  if(conclusion==='success') return '<span class="wk-badge success">成功</span>';
  if(conclusion==='failure') return '<span class="wk-badge fail">失败</span>';
  if(conclusion==='cancelled') return '<span class="wk-badge fail">已取消</span>';
  if(conclusion==='timed_out') return '<span class="wk-badge fail">超时</span>';
  if(status==='completed') return '<span class="wk-badge wait">'+(conclusion||'结束')+'</span>';
  return '<span class="wk-badge running">运行中</span>';
}
// 运行记录：下拉列出仓库里的所有工作流，用于切换查看不同工作流的记录
async function loadBuildWorkflows(){
  const sel=$('#buildHistoryWf'), runSel=$('#buildRunWf');
  if(!sel && !runSel) return;
  const cur=sel?sel.value:'';
  const curRun=runSel?runSel.value:'';
  const r=await api(API_BASE+'/workflows');
  const list=(r.ok&&r.data&&r.data.workflows)||[];
  const opts=list.filter(function(w){ return !!w.file; }).map(function(w){
    return '<option value="'+esc(w.file)+'">'+esc(wfLabel({workflow:w.file,name:w.name}))+'</option>';
  }).join('');
  if(sel){ sel.innerHTML='<option value="">全部工作流</option>'+opts; sel.value=cur; }
  if(runSel){ runSel.innerHTML='<option value="">选择要运行的工作流…</option>'+opts; runSel.value=curRun; }
}
async function loadBuildHistory(){
  const box=$('#buildHistory'); if(!box) return;
  const sel=$('#buildHistoryWf');
  const wf=sel?sel.value:'';
  if(sel && sel.options.length <= 1) await loadBuildWorkflows();
  box.innerHTML='<div class="empty">加载中...</div>';
  const r=await api(API_BASE+'/workflows/runs?limit=20'+(wf?('&workflow='+encodeURIComponent(wf)):''));
  if(r.status===401){ redirectLogin(); return; }
  if(!r.ok||!r.data||!r.data.ok){ box.innerHTML='<div class="empty">加载失败：'+(r.data&&r.data.error||r.status)+'</div>'; return; }
  const runs=r.data.runs||[];
  if(!runs.length){ box.innerHTML='<div class="empty">暂无运行记录</div>'; return; }
  let html='<table class="wk-build-table"><thead><tr><th>#</th><th>工作流</th><th>时间</th><th>提交</th><th>状态</th><th>操作</th></tr></thead><tbody>';
  runs.forEach(rn=>{
    const t=rn.created_at?new Date(rn.created_at).toLocaleString('zh-CN',{hour12:false}):'';
    const id=esc(rn.id);
    html+='<tr><td><a href="'+esc(rn.html_url)+'" target="_blank" rel="noopener">#'+id+'</a></td>'+
      '<td>'+esc(wfLabel(rn))+'</td>'+
      '<td>'+esc(t)+'</td><td><code>'+esc(rn.head_sha||'-')+'</code></td>'+
      '<td>'+buildBadge(rn.status,rn.conclusion)+'</td>'+
      '<td style="white-space:nowrap">'+
        '<a class="wk-btn ghost sm" href="'+esc(rn.html_url)+'" target="_blank" rel="noopener" title="在 GitHub 打开">↗</a> '+
        '<button class="wk-btn ghost sm" onclick="showBuildLog(\\''+id+'\\')">查看日志</button>'+
      '</td></tr>';
  });
  html+='</tbody></table>';
  box.innerHTML=html;
}

// ---------- 工作流日志（Cloudflare 代理获取，不跳转 GitHub）----------
let logModalRunId='';
let logModalTimer=null; // 运行中自动刷新（实时日志）
function closeLogModal(){ stopLogRefresh(); const m=$('#logModal'); if(m) m.classList.add('hidden'); }
function stopLogRefresh(){ if(logModalTimer){ clearInterval(logModalTimer); logModalTimer=null; } }
async function fetchBuildLog(runId){
  const r=await api(API_BASE+'/build/log?id='+encodeURIComponent(runId||''));
  if(r.status===401){ redirectLogin(); return null; }
  if(!r.ok||!r.data) return null;
  return r.data;
}
// 渲染日志正文；运行中在顶部加提示。刷新时若用户正贴着底部就继续贴底，否则保持阅读位置
function renderLogBody(d){
  const body=$('#logModalBody'); if(!body) return;
  const atBottom = body.scrollTop+body.clientHeight >= body.scrollHeight-40;
  const oldLen = body.textContent.length;
  body.textContent=(d.running?'【运行中 · 实时日志，每 5 秒自动刷新】\\n\\n':'')+((d.running?'':'【状态：'+(d.status||'完成')+(d.conclusion?(' · '+(d.conclusion==='success'?'成功':d.conclusion==='failure'?'失败':d.conclusion)):'')+'】\\n\\n'))+(d.text||'（暂无日志输出）');
  if(atBottom || oldLen===0) body.scrollTop=body.scrollHeight;
}
async function refreshLogModal(final){
  const d=await fetchBuildLog(logModalRunId);
  const body=$('#logModalBody');
  if(!d||!d.ok){
    // 运行刚触发还在排队时 GitHub 暂时没有日志：给出原因并继续自动重试
    const err=(d&&d.error)||'获取日志失败';
    if(body && (body.textContent.indexOf('正在从 GitHub')===0 || body.textContent.indexOf('【运行中')===0 || body.textContent.indexOf('（暂无可显示')===0))
      body.textContent='（暂无可显示的日志：'+err+'）\\n\\n将每 5 秒自动重试，运行产出日志后会自动显示…';
    return;
  }
  renderLogBody(d);
  if(!d.running){ stopLogRefresh(); }
}
async function showBuildLog(runId){
  const m=$('#logModal'); if(!m) return;
  logModalRunId=runId||'';
  m.classList.remove('hidden');
  const gh=$('#logModalGh');
  if(gh) gh.href=logModalRunId?('https://github.com/__REPO__/actions/runs/'+logModalRunId):'https://github.com/__REPO__/actions';
  const ttl=$('#logModalTitle'); if(ttl) ttl.textContent=logModalRunId?('#'+logModalRunId):'（最近一次）';
  const body=$('#logModalBody');
  if(body) body.textContent='正在从 GitHub 获取日志（经 Cloudflare 代理）…';
  stopLogRefresh();
  await refreshLogModal(false);
  // 运行中：每 5 秒自动拉一次实时日志，直到运行结束（关弹窗即停）
  logModalTimer=setInterval(function(){ refreshLogModal(false); }, 5000);
}
// 把失败日志发给 AI 助手分析：切到 AI 页，填入日志并自动发送
async function sendBuildLogsToAi(runId){
  closeLogModal();
  go('ai');
  const input=$('#aiInput');
  const head='部署工作流'+(runId?(' #'+runId):'（最近一次）')+'失败了，请分析下面的构建日志，指出失败原因并给出修复建议：\\n\\n';
  if(input){ input.value=head+'（正在获取日志…）'; aiAutoGrow(); }
  const d=await fetchBuildLog(runId);
  let log=(d&&d.text)||'（未能获取到日志）';
  if(log.length>12000) log='...(日志已截断)\\n'+log.slice(-12000);
  if(input){ input.value=head+log; aiAutoGrow(); input.focus(); }
  setTimeout(()=>{ aiSend(); }, 80);
}

// ---------- 文件管理 ----------
let filePath='';
let fileBranch='';
let branchesLoaded=false;
let selectedFiles=new Set();
const RECYCLE_DIR='_recycle';
function curBranch(){ return fileBranch || 'main'; }
function isRecycleView(){ return filePath===RECYCLE_DIR || filePath.indexOf(RECYCLE_DIR+'/')===0; }
function fileApi(url){
  const sep=url.indexOf('?')>=0?'&':'?';
  return url+sep+'branch='+encodeURIComponent(curBranch());
}
// 从 URL 的 ?pwd=<分支>/<路径> 恢复浏览位置（刷新后仍停留在原目录）
function fileParseUrl(){
  try{
    const pwd=new URLSearchParams(location.search).get('pwd')||'';
    if(!pwd) return;
    const i=pwd.indexOf('/');
    if(i<0){ fileBranch=pwd; filePath=''; }
    else { fileBranch=pwd.slice(0,i); filePath=pwd.slice(i+1); }
  }catch(e){}
}
// 把当前「分支/目录」写回地址栏（仅文件管理页），刷新后回到原位置
function fileSyncUrl(){
  if(activePage!=='files') return;
  try{
    const pwd=curBranch()+(filePath?('/'+filePath):'');
    history.replaceState(null,'','/admin/files?pwd='+encodeURIComponent(pwd));
  }catch(e){}
}
function fmtSize(n){
  n=n||0;
  if(n<1024) return n+' B';
  if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
  return (n/1024/1024).toFixed(1)+' MB';
}
function upLevel(){
  const parts=filePath.split('/').filter(Boolean);
  parts.pop();
  filePath=parts.join('/');
  loadFiles();
}
function renderCrumb(){
  const c=$('#fileCrumb'); if(!c) return;
  const parts=filePath.split('/').filter(Boolean);
  let html='<a href="javascript:;" data-dir="">根目录</a>';
  let cur='';
  parts.forEach((p,i)=>{
    cur=cur?cur+'/'+p:p;
    html+=' / <a href="javascript:;" data-dir="'+esc(cur)+'">'+esc(p)+'</a>';
  });
  c.innerHTML=html;
  $$('#fileCrumb a').forEach(a=>a.onclick=()=>{ filePath=a.dataset.dir; loadFiles(); });
}
async function loadBranches(selectCur){
  const sel=$('#branchSel'); if(!sel) return;
  const r=await api(API_BASE+'/branches');
  if(!r.ok||!r.data){ return; }
  const branches=r.data.branches||[];
  // URL 里 ?pwd= 指定的分支优先保留；否则用仓库当前分支
  const wanted=fileBranch;
  const before=wanted||'main';
  if(selectCur && !wanted) fileBranch=r.data.current||'main';
  sel.innerHTML='';
  branches.forEach(b=>{
    const o=document.createElement('option'); o.value=b; o.textContent=b; sel.appendChild(o);
  });
  if(fileBranch && branches.indexOf(fileBranch)<0) fileBranch='';
  if(!fileBranch) fileBranch=(r.data.current&&branches.indexOf(r.data.current)>=0)?r.data.current:(branches[0]||r.data.current||'main');
  sel.value=fileBranch;
  branchesLoaded=true;
  // 分支实际值与此前加载文件时用的不同（如 URL 分支失效或首次判定当前分支）：重载当前目录
  if(activePage==='files' && fileBranch!==before) loadFiles();
}
async function loadFiles(){
  const list=$('#fileList'); if(!list) return;
  list.innerHTML='<li class="empty">加载中...</li>';
  const r=await api(fileApi(API_BASE+'/files?path='+encodeURIComponent(filePath)));
  if(r.status===401){ redirectLogin(); return; }
  selectedFiles.clear();
  renderCrumb();
  fileSyncUrl(); // 目录/分支变化后同步到地址栏 ?pwd=，刷新回到原位置
  updateFileToolbar();
  if(!r.ok){
    if(isRecycleView()){ list.innerHTML='<li class="empty">回收站是空的</li>'; hideFileBatchBar(); return; }
    list.innerHTML='<li class="empty">加载失败：'+(r.data&&r.data.error||r.status)+'</li>'; hideFileBatchBar(); return;
  }
  const items=(r.data&&r.data.items)||[];
  list.innerHTML='';
  if(!items.length){ list.innerHTML='<li class="empty">'+(isRecycleView()?'回收站是空的':'空目录')+'</li>'; hideFileBatchBar(); return; }
  const rc=isRecycleView();
  items.forEach(f=>{
    const li=document.createElement('li');
    const isDir=f.type==='dir';
    const isZip=/\\.zip$/i.test(f.name||'');
    li.style.cursor=isDir?'pointer':'default';
    const pick='<input type="checkbox" class="filePick" data-path="'+esc(f.path)+'" style="width:auto;flex-shrink:0">';
    const label=isDir?('📁 '+esc(f.name)):('📄 '+esc(f.name)+' · '+fmtSize(f.size));
    let ops;
    if(rc){
      // 回收站：可恢复 / 彻底删除
      ops='<button class="wk-btn sm" data-a="restore">恢复</button>'+
          '<button class="wk-btn danger sm" data-a="purge">彻底删除</button>';
      if(!isDir) ops='<button class="wk-btn ghost sm" data-a="dl">下载</button>'+ops;
    } else if(isDir){
      ops='<button class="wk-btn ghost sm" data-a="rename">重命名</button>'+
          '<button class="wk-btn danger sm" data-a="del">删除</button>';
    } else {
      ops='<button class="wk-btn ghost sm" data-a="edit">编辑</button>'+
          '<button class="wk-btn ghost sm" data-a="rename">重命名</button>'+
          '<button class="wk-btn ghost sm" data-a="dl">下载</button>'+
          '<button class="wk-btn danger sm" data-a="del">删除</button>';
      if(isZip) ops='<button class="wk-btn act sm" data-a="zip">解压</button>'+ops;
    }
    li.innerHTML='<div style="display:flex;align-items:center;gap:10px;min-width:0">'+pick+'<div class="name">'+label+'</div></div>'+
      '<div class="ops">'+ops+'</div>';
    li.dataset.type=f.type; li.dataset.path=f.path; li.dataset.name=f.name;
    list.appendChild(li);
  });
  showFileBatchBar();
}
// ---------- 文件管理：多选 / 回收站 ----------
function updateFileToolbar(){
  const b=$('#recycleBtn'); if(b) b.textContent=isRecycleView()?'退出回收站':'回收站';
  const rc=isRecycleView();
  const toggle=(id,v)=>{ const el=$(id); if(el) el.classList.toggle('hidden',!v); };
  toggle('#fileBatchRecycle',!rc);
  toggle('#fileBatchRestore',rc);
  toggle('#fileBatchPurge',rc);
}
function showFileBatchBar(){ const b=$('#fileBatchBar'); if(b) b.classList.remove('hidden'); updateFileBatchBar(); }
function hideFileBatchBar(){ const b=$('#fileBatchBar'); if(b) b.classList.add('hidden'); }
function updateFileBatchBar(){
  const n=selectedFiles.size;
  const c=$('#filePickCount'); if(c) c.textContent=n;
  const all=$('#filePickAll');
  if(all){ const boxes=$$('#fileList .filePick'); all.checked=boxes.length>0&&n===boxes.length; }
  ['#fileBatchRecycle','#fileBatchRestore','#fileBatchPurge'].forEach(id=>{ const b=$(id); if(b) b.disabled=n===0; });
}
async function fileBatchOp(kind){
  const paths=Array.from(selectedFiles);
  if(!paths.length){ toast('请先勾选要操作的文件'); return; }
  const conf={
    recycle:'确认将所选 '+paths.length+' 项移入回收站？',
    restore:'确认恢复所选 '+paths.length+' 项？',
    purge:'确认彻底删除所选 '+paths.length+' 项？此操作不可恢复！'
  }[kind];
  if(!await askConfirm(conf)) return;
  const key={recycle:'moved',restore:'restored',purge:'purged'}[kind];
  const label={recycle:'移入回收站',restore:'恢复',purge:'彻底删除'}[kind];
  opBanner('正在'+label+' '+paths.length+' 项…','busy');
  const r=await api(API_BASE+'/files/'+kind,{method:'POST',body:JSON.stringify({paths:paths,branch:curBranch()})});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data[key]>0) opBannerEnd('已'+label+' '+r.data[key]+'/'+(r.data.total||paths.length)+' 项','neutral');
  else opBannerEnd(label+'失败：'+(r.data&&r.data.error||r.status),false);
  selectedFiles.clear();
  loadFiles();
}
async function onFileClick(e){
  const btn=e.target.closest('button'); if(!btn) return;
  const li=btn.closest('li'); if(!li) return;
  const path=li.dataset.path, name=li.dataset.name, a=btn.dataset.a;
  if(a==='zip'){
    if(!await askConfirm('解压「'+name+'」到当前目录？\\n小于 50MB 直接解压，大于 50MB 会触发 GitHub 工作流异步解压。')) return;
    const btn0=btn.textContent; btn.disabled=true; btn.textContent='解压中...';
    opBanner('正在解压「'+name+'」…','busy');
    const r=await api(API_BASE+'/unzip-path',{method:'POST',body:JSON.stringify({path,branch:curBranch()})});
    btn.disabled=false; btn.textContent=btn0;
    if(r.status===401){ redirectLogin(); return; }
    if(r.ok&&r.data&&r.data.workflow){
      opBannerEnd('已触发解压「'+name+'」，正在异步解压',true);
      startUnzipPoll();
      return;
    }
    if(r.ok&&r.data&&r.data.ok) opBannerEnd(r.data.message||('解压完成「'+name+'」'),true);
    else opBannerEnd('解压失败：'+(r.data&&r.data.error||r.status),false);
    loadFiles();
    return;
  }
  if(a==='del'){
    if(!await askConfirm('确认删除「'+name+'」？将移入回收站，可恢复。')) return;
    opBanner('正在删除「'+name+'」…','busy');
    const r=await api(API_BASE+'/files/recycle',{method:'POST',body:JSON.stringify({paths:[path],branch:curBranch()})});
    if(r.status===401){ redirectLogin(); return; }
    const err=(r.data&&r.data.error)||(r.data&&r.data.results&&r.data.results[0]&&r.data.results[0].error);
    if(r.ok&&r.data&&r.data.ok) opBannerEnd('已删除「'+name+'」（已移入回收站）','neutral');
    else opBannerEnd('删除失败：'+(err||r.status),false);
    loadFiles();
    return;
  }
  if(a==='restore'){
    opBanner('正在恢复「'+name+'」…','busy');
    const r=await api(API_BASE+'/files/restore',{method:'POST',body:JSON.stringify({paths:[path],branch:curBranch()})});
    if(r.status===401){ redirectLogin(); return; }
    const err=(r.data&&r.data.error)||(r.data&&r.data.results&&r.data.results[0]&&r.data.results[0].error);
    if(r.ok&&r.data&&r.data.ok) opBannerEnd('已恢复「'+name+'」',true);
    else opBannerEnd('恢复失败：'+(err||r.status),false);
    loadFiles();
    return;
  }
  if(a==='purge'){
    if(!await askConfirm('确认彻底删除「'+name+'」？此操作不可恢复！')) return;
    opBanner('正在彻底删除「'+name+'」…','busy');
    const r=await api(API_BASE+'/files/purge',{method:'POST',body:JSON.stringify({paths:[path],branch:curBranch()})});
    if(r.status===401){ redirectLogin(); return; }
    const err=(r.data&&r.data.error)||(r.data&&r.data.results&&r.data.results[0]&&r.data.results[0].error);
    if(r.ok&&r.data&&r.data.ok) opBannerEnd('已彻底删除「'+name+'」',true);
    else opBannerEnd('彻底删除失败：'+(err||r.status),false);
    loadFiles();
    return;
  }
  if(a==='edit'){
    // 读取文件要走 GitHub，约 1 秒：按钮先转圈，避免以为没反应
    const old=btn.innerHTML;
    btn.disabled=true; btn.innerHTML='<span class="wk-spin"></span>打开中';
    const r=await api(fileApi(API_BASE+'/file?path='+encodeURIComponent(path)));
    btn.disabled=false; btn.innerHTML=old;
    if(r.status===401){ redirectLogin(); return; }
    if(!r.ok){ toast('读取失败：'+(r.data&&r.data.error||r.status),true); return; }
    const d=r.data||{};
    if(d.binary){ toast('二进制文件暂不支持在线编辑，请下载后修改再上传',true); return; }
    openFileEditor(path, d.content||'');
    return;
  }
  if(a==='rename'){
    const nw=prompt('重命名「'+name+'」为：', name);
    if(!nw||!nw.trim()||nw.trim()===name) return;
    const cut=path.lastIndexOf('/');
    const to=(cut>=0?path.slice(0,cut+1):'')+nw.trim();
    opBanner('正在重命名「'+name+'」…','busy');
    const r=await api(API_BASE+'/files/move',{method:'POST',body:JSON.stringify({from:path,to:to,branch:curBranch()})});
    if(r.status===401){ redirectLogin(); return; }
    if(r.ok&&r.data&&r.data.ok) opBannerEnd('已重命名为「'+String(r.data.moved||to).split('/').pop()+'」',true);
    else opBannerEnd('重命名失败：'+(r.data&&r.data.error||r.status),false);
    loadFiles();
    return;
  }
  if(a==='dl'){
    const repo='__REPO__';
    const url=repo?('https://raw.githubusercontent.com/'+repo+'/'+curBranch()+'/'+encodeURIComponent(path)):('#');
    if(!repo){ toast('仓库未配置',true); return; }
    window.open(url,'_blank');
  }
}
async function onFileListClick(e){
  // 文件夹整行点击进入
  const li=e.target.closest('li'); if(!li||li.dataset.type!=='dir') return;
  if(e.target.closest('button')) return; // 点击按钮时交给 onFileClick
  if(e.target.closest('input')) return;  // 点击复选框时不进入目录
  filePath=li.dataset.path;
  loadFiles();
}
// ---------- 文件编辑器：ACE 懒加载 + 语法高亮 / 自动补全 ----------
let aceReady=false, aceLoading=false, aceWaiters=[], aceEditor=null;
// 首次打开编辑器时按需加载 ACE（含补全与按文件名识别语言），不加载就不影响其它页面
// 逐个 CDN 尝试：主库 ace.js 成功后再加载扩展；某个 CDN 全部失败则换下一个；都失败则保留 textarea 兜底
function aceEnsure(cb){
  if(aceReady){ cb(); return; }
  aceWaiters.push(cb);
  if(aceLoading) return; // 已在加载中，排队等待
  aceLoading=true;
  let bi=0;
  const finish=function(base){
    try{ window.ace.config.set('basePath', base); }catch(e){}
    aceReady=true; aceLoading=false;
    const ws=aceWaiters; aceWaiters=[];
    ws.forEach(function(f){ try{ f(); }catch(e){} });
  };
  const loadOne=function(src, ok, fail){
    const sc=document.createElement('script'); sc.src=src;
    sc.onload=function(){ ok(); }; sc.onerror=function(){ fail(); };
    document.head.appendChild(sc);
  };
  const tryBase=function(){
    if(bi>=ACE_BASES.length){ aceLoading=false; aceWaiters=[]; return; } // 全部失败：保留纯文本兜底
    const base=ACE_BASES[bi++];
    loadOne(base+'/ace.js', function(){
      let k=0;
      const nx=function(){
        if(k>=ACE_EXTS.length){ finish(base); return; }
        loadOne(base+'/'+ACE_EXTS[k++], nx, nx); // 扩展失败不影响基本高亮
      };
      nx();
    }, tryBase);
  };
  tryBase();
}
// 读取/写入编辑器文本（ACE 未就绪时用原生 textarea 兜底，保证一定能编辑）
function fileEditGet(){
  if(aceEditor) return aceEditor.getValue();
  const t=document.querySelector('#fileEditArea textarea.fileedit-fallback');
  return t?t.value:'';
}
function fileEditSet(text){
  const box=$('#fileEditArea'); if(!box) return;
  if(aceEditor){ aceEditor.setValue(text||'', -1); return; }
  let t=box.querySelector('textarea.fileedit-fallback');
  if(!t){ t=document.createElement('textarea'); t.className='fileedit-fallback'; t.spellcheck=false; box.appendChild(t); }
  t.value=text||'';
}
function openFileEditor(path, content){
  fileEditPath=path;
  const pt=$('#fileEditPath'); if(pt) pt.textContent=path;
  // 先用纯文本立即打开，不等待 CDN：避免「打不开」或长时间白屏
  fileEditSet(content||'');
  $('#fileEditor').classList.remove('hidden');
  applyAce();
  // 高亮在后台按需加载，加载完成后自动把已打开的编辑器升级为高亮编辑器
  aceEnsure(function(){ applyAce(); });
}
// 当前是否深色（优先看手动指定的 data-theme，其次跟随系统）
function isDarkMode(){
  const dt=document.documentElement.getAttribute('data-theme');
  if(dt==='dark') return true;
  if(dt==='light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
// ACE 编辑器主题跟随后台深浅色
function aceThemeName(){
  return isDarkMode() ? 'ace/theme/tomorrow_night' : 'ace/theme/textmate';
}
// ACE 就绪时：初始化/切换语言模式、主题与自动补全（未就绪则保持纯文本兜底）
function applyAce(){
  const box=$('#fileEditArea');
  if(!window.ace || !box) return;
  if(!aceEditor){
    const t=box.querySelector('textarea.fileedit-fallback');
    const text=t?t.value:'';
    if(t) t.remove();
    aceEditor=window.ace.edit(box);
    aceEditor.session.setUseWrapMode(true);
    aceEditor.session.setTabSize(2);
    aceEditor.session.setUseSoftTabs(true);
    aceEditor.setOptions({
      showPrintMargin:false, fontSize:'13px',
      enableBasicAutocompletion:true, enableLiveAutocompletion:true, enableSnippets:true,
    });
    try{ aceEditor.setValue(text, -1); }catch(e){ try{ aceEditor.setValue(text||'', -1); }catch(e2){} }
  }
  applyAceMode(aceEditor, fileEditPath);
  try{ aceEditor.setTheme(aceThemeName()); }catch(e){}
  setTimeout(function(){ try{ aceEditor.resize(); }catch(e){} }, 60);
}
function applyAceMode(ed, path){
  let mode='ace/mode/text';
  try{
    const modelist=window.ace.require('ace/ext/modelist');
    if(modelist && modelist.getModeForPath){
      const m=modelist.getModeForPath(String(path||''));
      if(m && m.mode) mode=m.mode;
    }
  }catch(e){}
  try{ ed.session.setMode(mode); }catch(e){}
}
// 主题色改变后，编辑器主题也随之更新
function refreshAceTheme(){ if(aceEditor){ try{ aceEditor.setTheme(aceThemeName()); }catch(e){} } }
// ---------- 后台主题色（仅本机浏览器，localStorage 记住） ----------
function shadeHex(hex, amt){
  const n=parseInt(hex.slice(1),16);
  const f=function(v){ const x=Math.round(v+(amt<0?v*amt:(255-v)*amt)); return Math.max(0,Math.min(255,x)); };
  return '#'+[f((n>>16)&255),f((n>>8)&255),f(n&255)].map(function(v){ return v.toString(16).padStart(2,'0'); }).join('');
}
function applyAccent(hex){
  hex=String(hex||'').trim();
  if(!/^#[0-9a-fA-F]{6}$/.test(hex)) hex='#f97316';
  const n=parseInt(hex.slice(1),16);
  const rgb=((n>>16)&255)+','+((n>>8)&255)+','+(n&255);
  const root=document.documentElement;
  root.style.setProperty('--accent',hex);
  root.style.setProperty('--accent-h',shadeHex(hex,-0.12));
  root.style.setProperty('--accent-rgb',rgb);
  try{ localStorage.setItem('admin_accent',hex); }catch(e){}
  const sel=$('#setAccent'); if(sel) sel.value=hex;
  refreshAceTheme();
}
function initAccent(){
  let v='';
  try{ v=localStorage.getItem('admin_accent')||''; }catch(e){}
  applyAccent(v||'#f97316');
}
// ---------- 后台深浅色模式（跟随系统 / 浅色 / 深色；仅本机浏览器，localStorage 记住） ----------
function applyThemeMode(mode){
  mode = ['auto','light','dark'].indexOf(mode) >= 0 ? mode : 'auto';
  const root = document.documentElement;
  if(mode === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try{ localStorage.setItem('admin_theme_mode', mode); }catch(e){}
  const sel = $('#setThemeMode'); if(sel) sel.value = mode;
  refreshAceTheme(); // 编辑器主题随深浅色切换
}
function initThemeMode(){
  let m='auto';
  try{ m=localStorage.getItem('admin_theme_mode')||'auto'; }catch(e){}
  applyThemeMode(m);
  // 跟随系统时：系统深浅色变化后同步编辑器主题
  try{
    const mq=window.matchMedia('(prefers-color-scheme: dark)');
    const on=function(){ if(!document.documentElement.getAttribute('data-theme')) refreshAceTheme(); };
    if(mq.addEventListener) mq.addEventListener('change', on);
    else if(mq.addListener) mq.addListener(on);
  }catch(e){}
}
async function saveFileEdit(){
  const content = fileEditGet();
  opBanner('正在保存文件…','busy');
  const r=await api(API_BASE+'/file',{method:'PUT',body:JSON.stringify({path:fileEditPath,content,branch:curBranch()})});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    $('#fileEditor').classList.add('hidden');
    loadFiles();
    opBannerEnd('已保存到 GitHub 仓库（如需部署请点击「运行工作流」）',true);
  } else opBannerEnd('保存失败：'+(r.data&&r.data.error||r.status),false);
}
async function doUpload(files){
  if(!files.length) return;
  opBanner('正在上传 '+files.length+' 个文件…','busy');
  const fd=new FormData();
  fd.append('path', filePath);
  fd.append('branch', curBranch());
  files.forEach(f=>fd.append('files', f));
  const r=await fetch(API_BASE+'/upload',{method:'POST',body:fd,headers:{Authorization:'Bearer '+token}});
  let d=null; try{ d=await r.json(); }catch(e){}
  if(r.status===401){ redirectLogin(); return; }
  if(d&&d.ok) opBannerEnd(d.message||'上传成功',true);
  else opBannerEnd('上传失败：'+(d&&d.error||r.status),false);
  loadFiles();
}
function newFolder(){
  const name=prompt('输入文件夹名称：');
  if(!name||!name.trim()) return;
  const target=(filePath?filePath+'/':'')+name.trim();
  opBanner('正在创建文件夹「'+name.trim()+'」…','busy');
  const r=api(fileApi(API_BASE+'/file'),{method:'PUT',body:JSON.stringify({path:target+'/.gitkeep',content:'',branch:curBranch()})});
  r.then(res=>{
    if(res.ok&&res.data&&res.data.ok){ opBannerEnd('已创建文件夹「'+name.trim()+'」',true); loadFiles(); }
    else opBannerEnd('创建文件夹失败',false);
  });
}
// ---------- 文件管理：从网络下载 / 大文件解压状态 ----------
async function downloadFromUrl(){
  const url=prompt('输入要下载的文件地址（http/https，或 GitHub 仓库 owner/repo）：');
  if(!url||!url.trim()) return;
  const suggest=url.trim().split(/[?#]/)[0].split('/').filter(Boolean).pop()||'';
  const name=prompt('保存的文件名（可修改，留空自动识别）：', /\.[a-z0-9]{2,5}$/i.test(suggest)?suggest:'');
  const dir=filePath?filePath+'/':'';
  opBanner('正在从网络下载…','busy');
  const r=await api(API_BASE+'/download',{method:'POST',body:JSON.stringify({url:url.trim(),name:(name||'').trim(),path:dir,branch:curBranch()})});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){ opBannerEnd(r.data.message||'下载完成',true); loadFiles(); }
  else opBannerEnd('下载失败：'+(r.data&&r.data.error||r.status),false);
}
let unzipTimer=null, unzipSeen=false, unzipTries=0;
const UNZIP_DOT='<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);margin-right:6px"></span>';
function renderUnzipStatus(info){
  const el=$('#unzipStatus'); if(!el) return;
  if(!info){ el.classList.add('hidden'); el.innerHTML=''; return; }
  el.classList.remove('hidden');
  const label=info.label||'解压工作流';
  if(info.running){
    el.innerHTML=UNZIP_DOT+'<span>'+(info.text||'正在运行解压工作流…（大文件解压，约 10 秒完成）')+'</span>';
  }else{
    const okc=info.conclusion==='success';
    el.innerHTML=label+'已结束：'+(okc?'✅ 成功':'⚠️ '+(info.conclusion||'未知'))+
      (info.html_url?' <a href="'+info.html_url+'" target="_blank" style="color:var(--accent)">查看日志</a>':'');
    setTimeout(()=>{ const e2=$('#unzipStatus'); if(e2){ e2.classList.add('hidden'); e2.innerHTML=''; } },6000);
  }
}
async function checkUnzipStatus(){
  const r=await api(API_BASE+'/unzip-status');
  if(r.status===401){ redirectLogin(); return null; }
  if(!r.ok||!r.data||!r.data.ok) return null;
  return r.data;
}
function stopUnzipPoll(){ if(unzipTimer){ clearInterval(unzipTimer); unzipTimer=null; } }
async function unzipPollTick(){
  unzipTries++;
  const d=await checkUnzipStatus();
  if(!d){ if(unzipTries>=8){ stopUnzipPoll(); renderUnzipStatus(null); } return; }
  if(d.running){ unzipSeen=true; renderUnzipStatus({running:true}); return; }
  // GitHub 记录 run 有几秒延迟：没观察到 running 前先多等几轮
  if(!unzipSeen && unzipTries<8) return;
  stopUnzipPoll();
  const latest=d.latest||{};
  renderUnzipStatus({running:false,conclusion:latest.conclusion,html_url:latest.html_url});
  loadFiles();
}
function startUnzipPoll(){
  if(unzipTimer) return;
  stopClonePoll();
  unzipSeen=false; unzipTries=0;
  renderUnzipStatus({running:true});
  unzipTimer=setInterval(unzipPollTick,2500);
  unzipPollTick();
}
// ---------- 文件管理：克隆外部仓库（触发 clone-repo.yml）----------
let cloneTimer=null, cloneTries=0;
function stopClonePoll(){ if(cloneTimer){ clearInterval(cloneTimer); cloneTimer=null; } }
async function clonePollTick(target){
  cloneTries++;
  const r=await api(API_BASE+'/workflows/runs?workflow=clone-repo.yml');
  if(r.status===401){ redirectLogin(); return; }
  const d=r.data||{};
  if(!r.ok||!d.ok){ if(cloneTries>=8){ stopClonePoll(); renderUnzipStatus(null); } return; }
  if(d.running){ renderUnzipStatus({running:true,text:'正在克隆「'+(target||'目标目录')+'」…（约 10 秒完成）'}); return; }
  // 触发后 GitHub 记录 run 有几秒延迟，前几轮没观察到结果时继续等
  if(!d.latest && cloneTries<8) return;
  stopClonePoll();
  const latest=d.latest;
  if(!latest){ renderUnzipStatus({label:'克隆工作流',conclusion:'未发现运行记录（可能触发失败）'}); return; }
  renderUnzipStatus({label:'克隆工作流',conclusion:latest.conclusion,html_url:latest.html_url});
  if(latest.conclusion==='success') loadFiles();
}
async function cloneRepoFromUrl(){
  if(!await askConfirm('克隆一个外部仓库？\\n将自动触发 GitHub 工作流完成（约 10 秒），目标目录已存在且非空时会中止。')) return;
  const repo=prompt('输入要克隆的仓库（owner/repo 或完整 URL），例如 Hexo 主题：');
  if(!repo||!repo.trim()) return;
  const slug=(repo.trim().split('/').filter(Boolean).pop()||'repo').replace(/\.git$/,'');
  const sub=prompt('克隆到哪个目录？\\n可填相对当前目录的路径（如 themes/next）；以 / 开头表示从仓库根目录算起。', slug);
  if(sub===null) return;
  let name=(sub.trim()||slug);
  const fromRoot=name.charAt(0)==='/';
  while(name.charAt(0)==='/') name=name.slice(1);
  while(name && name.charAt(name.length-1)==='/') name=name.slice(0,-1);
  if(!name) name=slug;
  const target=fromRoot?name:((filePath?filePath+'/':'')+name);
  opBanner('正在触发克隆「'+name+'」工作流…','busy');
  const r=await api(API_BASE+'/clone-repo',{method:'POST',body:JSON.stringify({repo_url:repo.trim(),target_dir:target,branch:curBranch()})});
  if(r.status===401){ redirectLogin(); return; }
  if(r.ok&&r.data&&r.data.ok){
    opBannerEnd(r.data.message||('已触发克隆「'+name+'」工作流'),true);
    stopUnzipPoll();
    renderUnzipStatus({running:true,text:'正在克隆「'+name+'」…（约 10 秒完成）'});
    cloneTries=0;
    stopClonePoll();
    cloneTimer=setInterval(()=>clonePollTick(name),2500);
    clonePollTick(name);
  } else opBannerEnd('克隆失败：'+(r.data&&r.data.error||r.status),false);
}
// 进入文件页时：若后台仍有解压工作流在跑，恢复「正在运行」提示
async function resumeUnzipStatus(){
  if(unzipTimer) return;
  const d=await checkUnzipStatus();
  if(d&&d.running) startUnzipPoll();
}

// ---------- 写作页草稿自动保存（刷新后恢复，参考 cp.802213.xyz）----------
// 仅「发布新文章」页（/admin/write）自动保存；编辑已有文章不覆盖草稿。
const DRAFT_KEY='wk_draft_v1';
function loadDraft(){
  try{
    const raw=localStorage.getItem(DRAFT_KEY);
    if(!raw) return null;
    const d=JSON.parse(raw);
    return d&&typeof d==='object'?d:null;
  }catch(e){ return null; }
}
function saveDraft(){
  if(activePage!=='write'||editingPath) return;
  const d={
    title:$('#title').value,
    date:$('#date').value,
    tags:$('#tags').value,
    categories:$('#categories').value,
    content:editor?editor.getValue():'',
    ts:Date.now()
  };
  try{ localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); }catch(e){}
}
function clearDraft(){
  try{ localStorage.removeItem(DRAFT_KEY); }catch(e){}
}
function restoreDraft(){
  const d=loadDraft();
  if(!d) return;
  $('#title').value=d.title||'';
  // 日期不恢复草稿值：新文章日期始终为当前日期（调用方已设好）
  $('#tags').value=d.tags||'';
  $('#categories').value=d.categories||'';
  if(d.content){ pendingEditorValue=d.content; $('#editorTitle').textContent='发布新文章（已恢复草稿）'; }
  toast('已恢复上次未发布的草稿');
}

// ---------- init ----------
function redirectLogin(){ location.replace('/admin/login'); }
document.addEventListener('DOMContentLoaded', ()=>{
  initAccent(); // 恢复上次选择的主题色（仅本机浏览器）
  initThemeMode(); // 恢复上次选择的深浅色模式
  token = getToken();
  if(!token){ redirectLogin(); return; }
  // 记录 URL 中的会话 id（/admin/ai/<id>），供进入 AI 页时自动打开
  try{
    const m = location.pathname.match(/\\/admin\\/ai\\/([^\\/]+)\\/?$/);
    if(m) aiPendingConv = decodeURIComponent(m[1]);
  }catch(e){}
  // 校验登录态（独立管理员体系），无效跳登录页
  fetch('/api/admin/me').then(r=>r.json()).then(d=>{
    if(!d||!d.ok){ redirectLogin(); return; }
    $('#userName').textContent=d.username||'管理员';
    const au=$('#acUser'); if(au) au.value=d.username||'';
    if(window.__INITIAL__==='write'){
      enterWritePage();
    } else {
      switchTab(window.__INITIAL__||'manage');
    }
    // 全局：任意标签页都能看到「正在运行的部署工作流」与失败入口
    // 先确认 AI 是否已配置，再渲染横幅（决定失败横幅里是否给「发给 AI」按钮）
    checkAiConfigured().finally(()=>initBuildStatus());
  }).catch(()=>redirectLogin());

  $('#logoutBtn').onclick=async ()=>{
    try{ await fetch('/api/admin/logout',{method:'POST'}); }catch(e){}
    try{ document.cookie='bl_token=;path=/;max-age=0'; }catch(e){}
    location.replace('/admin/login');
  };
  // AI 助手：Enter 发送，Shift+Enter 换行
  const aiInputEl = $('#aiInput');
  if(aiInputEl){
    aiInputEl.addEventListener('keydown', e=>{
      if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); if(aiStreaming){ toast('正在生成中，可点「停止」中断'); return; } aiSend(); }
    });
    // 输入框随内容自动增高（上限后内部滚动），因为是底部对齐，视觉上向上拉升
    aiInputEl.addEventListener('input', aiAutoGrow);
    // 用户拖拽右下角手柄调整高度后记住该高度（之后自动增高以此为下限，不再缩回）
    aiInputEl.addEventListener('resize', function(){
      aiInputH = Math.round(aiInputEl.getBoundingClientRect().height);
      aiAutoGrow();
    });
    // 兜底：偶发点击不聚焦（流式渲染期间布局位移导致点击落空），点击时强制聚焦
    aiInputEl.addEventListener('click', function(){
      if(document.activeElement !== aiInputEl){ try{ aiInputEl.focus(); }catch(e){} }
    });
    aiAutoGrow();
  }
  // 手机端：尺寸变化 / 旋转 / 软键盘弹出时重新计算聊天区高度，保证输入框始终贴屏幕底边
  const aiFitSoon = ()=>{ if(window.innerWidth<=640) aiFitHeight(); };
  window.addEventListener('resize', aiFitSoon);
  window.addEventListener('orientationchange', ()=>setTimeout(aiFitSoon,120));
  if(window.visualViewport) window.visualViewport.addEventListener('resize', aiFitSoon);
  if(window.__INITIAL__==='ai') setTimeout(aiFitSoon, 350);
  // 新建文章：重置表单后 SPA 进入写作页（不刷新）
  $('#newBtn').onclick=()=>{
    editingPath='';
    ['title','date','tags','categories'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    $('#date').value=localToday();
    $('#editorTitle').textContent='发布新文章';
    $('#saveBtn').textContent='发布文章';
    pendingEditorValue='';
    try{ if(editor) editor.setValue(''); }catch(e){}
    go('write');
  };
  $('#saveBtn').onclick=savePost;
  // 写作页表单：输入即自动保存草稿；关闭/刷新前兜底保存
  ['title','date','tags','categories'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.addEventListener('input',saveDraft);
  });
  window.addEventListener('beforeunload', saveDraft);
  $('#postList').addEventListener('click',onListClick);
  // 管理文章：多选 / 批量删除 / 批量上传
  $('#postList').addEventListener('change',e=>{
    const c=e.target;
    if(!c||!c.classList||!c.classList.contains('postCheck')) return;
    const p=c.dataset.path;
    if(c.checked) selectedPosts.add(p); else selectedPosts.delete(p);
    updateBatchBar();
  });
  // 勾选 click 兜底：全量按 DOM 状态重建选中集合，防个别环境 change 事件丢失
  $('#postList').addEventListener('click',e=>{
    const c=e.target;
    if(!c||!c.classList||!c.classList.contains('postCheck')) return;
    setTimeout(()=>{
      selectedPosts.clear();
      $$('#postList .postCheck').forEach(x=>{ if(x.checked) selectedPosts.add(x.dataset.path); });
      updateBatchBar();
    },0);
  });
  $('#pickAll').onchange=e=>{
    const on=e.target.checked;
    $$('#postList .postCheck').forEach(c=>{
      c.checked=on;
      const p=c.dataset.path;
      if(on) selectedPosts.add(p); else selectedPosts.delete(p);
    });
    updateBatchBar();
  };
  $('#batchDelBtn').onclick=deleteSelectedPosts;
  // 「批量上传」已是独立页面：管理页按钮仅跳转过去
  $('#batchUpBtn').onclick=()=>go('upload');
  // 批量上传页：多次选文件累加到列表，一键发布
  $('#upPickBtn').onclick=()=>$('#uploadInput').click();
  $('#uploadInput').onchange=e=>{ addUploadFiles(Array.from(e.target.files||[])); e.target.value=''; };
  $('#upClearBtn').onclick=clearUploadQueue;
  $('#upPublishBtn').onclick=publishUploadQueue;
  $('#uploadList').addEventListener('click',onUploadListClick);
  $('#commentList').addEventListener('click',onCommentAction);
  // 评论管理：多选批量删除
  $('#commentList').addEventListener('change',e=>{
    const c=e.target;
    if(!c||!c.classList||!c.classList.contains('cmtCheck')) return;
    const card=c.closest('.wk-comment'); if(!card) return;
    const id=card.dataset.id; if(!id) return;
    if(c.checked) selectedComments.add(id); else selectedComments.delete(id);
    updateCommentBatch();
  });
  // 勾选 click 兜底：全量按 DOM 状态重建选中集合，防个别环境 change 事件丢失
  $('#commentList').addEventListener('click',e=>{
    const c=e.target;
    if(!c||!c.classList||!c.classList.contains('cmtCheck')) return;
    setTimeout(()=>{
      selectedComments.clear();
      $$('#commentList .wk-comment').forEach(card=>{
        const x=card.querySelector('.cmtCheck');
        if(x&&x.checked) selectedComments.add(card.dataset.id);
      });
      updateCommentBatch();
    },0);
  });
  $('#cmtPickAll').onchange=e=>{
    const on=e.target.checked;
    $$('#commentList .wk-comment').forEach(card=>{
      const c=card.querySelector('.cmtCheck'); if(!c) return;
      c.checked=on;
      if(on) selectedComments.add(card.dataset.id); else selectedComments.delete(card.dataset.id);
    });
    updateCommentBatch();
  };
  $('#cmtBatchDel').onclick=deleteSelectedComments;
  $$('#commentFilter .wk-btn').forEach(b=>b.onclick=()=>setCommentFilter(b.dataset.f));
  $('#fileList').addEventListener('click',onFileClick);
  $('#fileList').addEventListener('click',onFileListClick);
  $('#fileEditSave').onclick=saveFileEdit;
  $('#fileEditBack').onclick=()=>$('#fileEditor').classList.add('hidden');
  $('#upBtn').onclick=()=>$('#upInput').click();
  $('#upInput').onchange=e=>{ doUpload(Array.from(e.target.files||[])); e.target.value=''; };
  $('#upDirBtn').onclick=upLevel;
  $('#dlUrlBtn').onclick=downloadFromUrl;
  $('#cloneRepoBtn').onclick=cloneRepoFromUrl;
  const lm=$('#logModal'); if(lm) lm.addEventListener('click',e=>{ if(e.target===lm) closeLogModal(); });
  $('#branchSel').onchange=e=>{ fileBranch=e.target.value||'main'; filePath=''; loadFiles(); };
  $('#newFolderBtn').onclick=newFolder;
  $('#fileRefreshBtn').onclick=()=>{ loadBranches(); loadFiles(); resumeUnzipStatus(); };
  // 文件管理：多选 / 回收站
  $('#recycleBtn').onclick=()=>{ filePath=isRecycleView()?'':RECYCLE_DIR; loadFiles(); };
  $('#fileList').addEventListener('change',e=>{
    const c=e.target;
    if(!c||!c.classList||!c.classList.contains('filePick')) return;
    const p=c.dataset.path;
    if(c.checked) selectedFiles.add(p); else selectedFiles.delete(p);
    updateFileBatchBar();
  });
  // 勾选 click 兜底：全量按 DOM 状态重建选中集合，防个别环境 change 事件丢失
  $('#fileList').addEventListener('click',e=>{
    const c=e.target;
    if(!c||!c.classList||!c.classList.contains('filePick')) return;
    setTimeout(()=>{
      selectedFiles.clear();
      $$('#fileList .filePick').forEach(x=>{ if(x.checked) selectedFiles.add(x.dataset.path); });
      updateFileBatchBar();
    },0);
  });
  $('#filePickAll').onchange=e=>{
    const on=e.target.checked;
    $$('#fileList .filePick').forEach(c=>{
      c.checked=on;
      const p=c.dataset.path;
      if(on) selectedFiles.add(p); else selectedFiles.delete(p);
    });
    updateFileBatchBar();
  };
  $('#fileBatchRecycle').onclick=()=>fileBatchOp('recycle');
  $('#fileBatchRestore').onclick=()=>fileBatchOp('restore');
  $('#fileBatchPurge').onclick=()=>fileBatchOp('purge');
  fileParseUrl(); // 先按 URL 的 ?pwd= 恢复分支与目录，再加载分支
  loadBranches(true);
  $$('.wk-tab').forEach(t=>t.onclick=()=>switchTab(t.dataset.tab));
});
`;

export function renderAdminPage(siteUrl: string, ghRepo?: string, initial = "manage"): string {
  const repo = String(ghRepo || "");
  const INITIAL = ["manage","upload","comments","files","build","visit","subscribe","ai","settings","write"].includes(initial)
    ? initial
    : "manage";
  // 服务端就直接渲染出正确的初始页面，避免先闪一下「管理文章」再切过去
  const pageCls = (name: string) => "wk-page" + (INITIAL === name ? "" : " hidden");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>博客管理后台</title>
<link rel="stylesheet" href="${VDIRTOR_CSS}">
<style>${STYLE}</style>
</head>
<body>
<nav class="wk-nav">
  <div class="inner">
    <div class="brand">
      <span>博客后台</span>
    </div>
    <div class="spacer"></div>
    ${siteUrl ? '<a class="site" href="' + siteUrl + '" target="_blank">查看站点</a>' : ''}
    <span class="user" id="userName"></span>
    <button class="logout" id="logoutBtn">退出</button>
  </div>
</nav>

<div class="wk-tabs">
  <button class="wk-tab ${INITIAL === "manage" ? "active" : ""}" data-tab="manage">管理文章</button>
  <button class="wk-tab ${INITIAL === "comments" ? "active" : ""}" data-tab="comments">评论管理</button>
  <button class="wk-tab ${INITIAL === "files" ? "active" : ""}" data-tab="files">文件管理</button>
  <button class="wk-tab ${INITIAL === "build" ? "active" : ""}" data-tab="build">部署记录</button>
  <button class="wk-tab ${INITIAL === "theme" ? "active" : ""}" data-tab="theme">主题</button>
  <button class="wk-tab ${INITIAL === "visit" ? "active" : ""}" data-tab="visit">访问量</button>
  <button class="wk-tab ${INITIAL === "subscribe" ? "active" : ""}" data-tab="subscribe">订阅管理</button>
  <button class="wk-tab ${INITIAL === "ai" ? "active" : ""}" data-tab="ai">AI 助手</button>
  <button class="wk-tab ${INITIAL === "settings" ? "active" : ""}" data-tab="settings">设置</button>
</div>

<div class="wk-wrap">

  <!-- 全局工作流横幅：任意标签页都能看到「正在运行 / 失败」 -->
  <div id="globalBuildBanner" class="build-banner hidden" style="margin:0 0 12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap"></div>

  <!-- 管理文章（默认首页） -->
  <div id="page-manage" class="${pageCls("manage")}">
    <div class="wk-card">
      <div class="toolbar" style="justify-content:space-between;align-items:center">
        <h3 class="wk-title" style="margin:0;border:none;padding:0">已有文章<span class="wk-label" id="postTotal" style="margin:0 0 0 10px;font-weight:400"></span></h3>
        <div style="display:flex;gap:6px">
          <button class="wk-btn ghost sm" id="batchUpBtn">批量上传</button>
          <button class="wk-btn sm" id="newBtn">＋ 添加新文章</button>
        </div>
      </div>
      <div class="filters" id="postFilterBar" style="margin:10px 0 0;flex-wrap:wrap;gap:8px">
        <span class="wk-label" style="margin:0">排序</span>
        <select class="wk-input" id="postSort" onchange="applyPostView()" style="width:auto;max-width:150px;padding:4px 8px">
          <option value="date-desc">日期 倒序（新→旧）</option>
          <option value="date-asc">日期 正序（旧→新）</option>
          <option value="size-asc">大小 正序（小→大）</option>
          <option value="size-desc">大小 倒序（大→小）</option>
        </select>
        <span class="wk-label" style="margin:0 0 0 6px">分类</span>
        <select class="wk-input" id="postFCat" onchange="applyPostView()" style="width:auto;max-width:130px;padding:4px 8px"><option value="">全部</option></select>
        <span class="wk-label" style="margin:0 0 0 6px">标签</span>
        <select class="wk-input" id="postFTag" onchange="applyPostView()" style="width:auto;max-width:130px;padding:4px 8px"><option value="">全部</option></select>
        <span class="wk-label" style="margin:0 0 0 6px">格式</span>
        <select class="wk-input" id="postFFmt" onchange="applyPostView()" style="width:auto;max-width:130px;padding:4px 8px"><option value="">全部格式</option></select>
        <input class="wk-input" id="postFQ" placeholder="搜索标题 / 文件名" oninput="applyPostView()" style="width:160px;padding:4px 8px">
      </div>
      <div class="filters hidden" id="batchBar" style="margin:10px 0 0">
        <label class="wk-label" style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">
          <input type="checkbox" id="pickAll" style="width:auto"> 全选
        </label>
        <span class="wk-label" style="margin:0">已选 <b id="pickCount">0</b> 篇</span>
        <button class="wk-btn danger sm" id="batchDelBtn" disabled>删除所选</button>
      </div>
      <ul class="wk-list" id="postList"><li class="empty">加载中...</li></ul>
    </div>
  </div>

  <!-- 批量上传（独立页面：多次选文件累加到列表，一键发布） -->
  <div id="page-upload" class="${pageCls("upload")}">
    <div class="wk-card">
      <div class="toolbar" style="justify-content:space-between;align-items:center">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <button class="wk-btn ghost sm" onclick="go('manage')">← 返回管理文章</button>
          <h3 class="wk-title" style="margin:0;border:none;padding:0">批量上传文章</h3>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span class="wk-label" style="margin:0">已选 <b id="uploadCount">0</b> 个文件</span>
          <button class="wk-btn ghost sm" id="upPickBtn">＋ 选择文件</button>
          <button class="wk-btn ghost sm" id="upClearBtn">清空列表</button>
          <button class="wk-btn sm" id="upPublishBtn" disabled>一键发布</button>
        </div>
      </div>
      <p class="wk-label" style="margin-top:0">支持 .md / .markdown / .txt；可分多次选择，文件会依次累加到下方列表（同名自动跳过），逐个可移除，确认后一键发布。</p>
      <ul class="wk-list" id="uploadList"><li class="empty">还没有选择文件；点「＋ 选择文件」把文章加入列表，可分多次选</li></ul>
      <input type="file" id="uploadInput" accept=".md,.markdown,.txt" multiple class="hidden">
    </div>
  </div>

  <!-- 写作页 -->
  <div id="page-write" class="${pageCls("write")}">
    <div class="wk-card">
      <div class="toolbar" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:8px;min-width:0">
          <button class="wk-btn ghost sm" onclick="go('manage')">← 返回管理文章</button>
          <h3 class="wk-title" style="margin:0;border:none;padding:0" id="editorTitle">发布新文章</h3>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button class="wk-btn ghost sm" onclick="go('upload')">批量上传</button>
          <button class="wk-btn" id="saveBtn">发布文章</button>
        </div>
      </div>
      <label class="wk-label">标题</label>
      <input class="wk-input" id="title" placeholder="文章标题">
      <div class="wk-row">
        <div class="wk-field"><label class="wk-label">日期</label><input class="wk-input" type="date" id="date"></div>
        <div class="wk-field"><label class="wk-label">分类</label><input class="wk-input" id="categories" list="catList" placeholder="可输入或从历史下拉选择，多个用逗号分开"></div>
        <div class="wk-field"><label class="wk-label">标签</label><div style="position:relative"><input class="wk-input" id="tags" autocomplete="off" placeholder="多个用英文逗号隔开，可联想历史标签" oninput="updateTagSug()" onkeydown="tagSugKey(event)" onblur="setTimeout(hideTagSug,150)"><div id="tagSug" class="tag-sug" style="display:none"></div></div></div>
      </div>
      <datalist id="catList"></datalist>
      <datalist id="tagList"></datalist>
      <label class="wk-label">正文（Markdown，分屏预览）</label>
      <div id="edt"></div>
      <div class="msg" id="msg" style="margin-top:8px"></div>
    </div>
  </div>

  <!-- 评论管理 -->
  <div id="page-comments" class="${pageCls("comments")}">
    <div class="wk-card">
      <div class="toolbar" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <h3 class="wk-title" style="margin:0;border:none;padding:0">评论管理</h3>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <div id="commentFilter" class="filters">
            <button class="wk-btn act sm" data-f="all">全部</button>
            <button class="wk-btn ghost sm" data-f="waiting">待审批</button>
            <button class="wk-btn ghost sm" data-f="approved">已通过</button>
            <button class="wk-btn ghost sm" data-f="spam">垃圾</button>
          </div>
          <button class="wk-btn danger sm" id="cmtBatchDel" disabled>删除所选（<span id="cmtCount">0</span>）</button>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer"><input type="checkbox" id="cmtPickAll" style="width:auto">全选</label>
        </div>
      </div>
      <div id="commentList"><div class="empty">切换到此页加载评论</div></div>
    </div>
  </div>

  <!-- 文件管理 -->
  <div id="page-files" class="${pageCls("files")}">
    <div class="wk-card">
      <div class="toolbar" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <div style="display:flex;align-items:center;gap:10px">
          <h3 class="wk-title" style="margin:0;border:none;padding:0">文件管理</h3>
          <select class="wk-input" id="branchSel" style="width:auto;min-width:120px;padding:4px 8px" title="切换分支">
            <option value="">加载分支...</option>
          </select>
        </div>
        <div class="filters" id="fileOps">
          <button class="wk-btn ghost sm" id="upDirBtn" title="返回上一级">← 上一级</button>
          <button class="wk-btn sm" id="upBtn">上传</button>
          <button class="wk-btn ghost sm" id="dlUrlBtn" title="从网络下载文件保存到当前目录">从网络下载</button>
          <button class="wk-btn ghost sm" id="cloneRepoBtn" title="把外部 Git 仓库克隆到当前目录（如克隆一个 Hexo 主题）">克隆仓库</button>
          <button class="wk-btn ghost sm" id="newFolderBtn">新建文件夹</button>
          <button class="wk-btn ghost sm" id="fileRefreshBtn" title="刷新当前目录">刷新</button>
          <button class="wk-btn ghost sm" id="recycleBtn">回收站</button>
        </div>
        <input type="file" id="upInput" multiple style="display:none">
      </div>
      <div class="breadcrumb" id="fileCrumb" style="font-size:12px;color:var(--muted);padding:8px 6px 4px;word-break:break-all"></div>
      <div id="unzipStatus" class="hidden" style="margin:0 0 8px;padding:8px 10px;border-radius:6px;font-size:13px;background:var(--input-bg);color:var(--fg);display:flex;align-items:center;gap:8px"></div>
      <div class="filters hidden" id="fileBatchBar" style="margin:0 0 8px">
        <label class="wk-label" style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">
          <input type="checkbox" id="filePickAll" style="width:auto"> 全选
        </label>
        <span class="wk-label" style="margin:0">已选 <b id="filePickCount">0</b> 项</span>
        <button class="wk-btn danger sm" id="fileBatchRecycle">移入回收站</button>
        <button class="wk-btn sm hidden" id="fileBatchRestore">恢复</button>
        <button class="wk-btn danger sm hidden" id="fileBatchPurge">彻底删除</button>
      </div>
      <ul class="wk-list" id="fileList"><li class="empty">加载中...</li></ul>
    </div>
    <!-- 全屏文本编辑器 -->
    <div id="fileEditor" class="hidden" style="position:fixed;inset:0;background:var(--bg);z-index:100;display:flex;flex-direction:column">
      <div class="wk-nav" style="position:static;height:46px">
        <div class="inner">
          <button class="logout" id="fileEditBack" style="color:var(--nav-fg);border:1px solid var(--border);background:transparent;padding:3px 10px;border-radius:3px;cursor:pointer">← 返回</button>
          <span class="brand" style="font-size:12px;color:var(--nav-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" id="fileEditPath"></span>
          <div class="spacer"></div>
          <button class="logout" id="fileEditSave" style="color:#fff;background:var(--accent);border:none;padding:4px 14px;border-radius:3px;cursor:pointer">保存</button>
        </div>
      </div>
      <div id="fileEditArea"></div>
    </div>
  </div>

  <!-- 部署记录 -->
  <div id="page-build" class="${pageCls("build")}">
    <div class="wk-card">
      <div class="toolbar" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <h3 class="wk-title" style="margin:0;border:none;padding:0">工作流运行记录</h3>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <select class="wk-input" id="buildHistoryWf" onchange="loadBuildHistory()" title="切换要查看的工作流" style="width:auto;min-width:150px;padding:4px 8px">
            <option value="">全部工作流</option>
          </select>
          <button class="wk-btn ghost sm" onclick="loadBuildHistory()">刷新</button>
          <select class="wk-input" id="buildRunWf" title="选择要运行的工作流" style="width:auto;min-width:150px;padding:4px 8px">
            <option value="">选择要运行的工作流…</option>
          </select>
          <button class="wk-btn act sm" onclick="triggerSelectedWorkflow()">▶ 运行</button>
        </div>
      </div>
      <p class="wk-label" style="margin-top:0">左侧下拉切换查看不同工作流（完整部署 / 更新 GitHub Pages / 克隆仓库 等）的运行记录，右侧下拉选择要运行的工作流；点「查看日志」经 Cloudflare 代理直接看日志，无需跳转 GitHub。</p>
      <div class="table-scroll"><div id="buildHistory" class="empty">加载中...</div></div>
    </div>
  </div>

  <!-- 主题管理（自动检测 themes/ 目录 + 切换主题 + 克隆添加） -->
  <div id="page-theme" class="${pageCls("theme")}">
    <div class="wk-card">
      <div class="toolbar" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
        <h3 class="wk-title" style="margin:0;border:none;padding:0">已安装主题</h3>
        <button class="wk-btn ghost sm" onclick="loadThemes()">刷新</button>
      </div>
      <p class="wk-label" style="margin-top:0">自动检测仓库 themes/ 目录下的主题；切换会修改 _config.yml 并自动触发部署，站点几分钟后用新主题重建。</p>
      <div id="themeList"><div class="empty">加载中...</div></div>
    </div>

    <div class="wk-card">
      <h3 class="wk-title">添加主题</h3>
      <p class="wk-label" style="margin-top:0">粘贴 GitHub 主题地址，自动克隆到 themes/ 目录。支持项目主页（github.com/owner/repo）、分支页（…/tree/main）、.git 结尾的地址。</p>
      <div class="filters" style="flex-wrap:wrap">
        <input class="wk-input" id="themeRepoUrl" style="flex:1;min-width:220px" placeholder="https://github.com/owner/repo">
        <input class="wk-input" id="themeDirName" style="width:180px" placeholder="目录名（默认仓库名）">
        <button class="wk-btn sm" id="themeAddBtn" onclick="addTheme()">克隆主题</button>
      </div>
      <div class="msg" id="themeMsg"></div>
      <div class="build-banner hidden" id="themeCloneStatus"></div>
    </div>
  </div>

  <!-- 访问量（仅管理员可见） -->
  <div id="page-visit" class="${pageCls("visit")}">
    <div class="stats-scroll"><div class="stats">
      <div class="stat-card"><div class="num" id="statToday">-</div><div class="lbl">今日访问数</div></div>
      <div class="stat-card"><div class="num" id="statTotal">-</div><div class="lbl">总访问量</div></div>
    </div></div>

    <div class="wk-card">
      <h3 class="wk-title">访问趋势（最近 <span id="visitDaysLabel">30</span> 天<span id="visitChartScope"> · 全部站点</span>）</h3>
      <div class="filters" style="margin:0 0 10px">
        <button class="wk-btn ghost sm" onclick="setVisitDays(7)">7 天</button>
        <button class="wk-btn ghost sm" onclick="setVisitDays(30)">30 天</button>
        <button class="wk-btn ghost sm" onclick="setVisitDays(90)">90 天</button>
        <button class="wk-btn ghost sm" onclick="setVisitDays(365)">365 天</button>
        <input class="wk-input" id="visitDays" type="number" min="1" max="3650" value="30" style="width:88px" placeholder="自定义">
        <button class="wk-btn sm" onclick="applyVisitDays()">应用</button>
      </div>
      <div id="visitChart"><div class="empty">加载中...</div></div>
      <div id="visitBreakdown" class="vb-box"><span class="vb-chip">加载中...</span></div>
    </div>

    <div class="wk-card">
      <h3 class="wk-title">来源站点明细（最近 <span id="visitSiteDaysLabel">30</span> 天）</h3>
      <p class="wk-label" style="margin:0 0 10px">按访问来源域名统计，同一访客同一天在同一站点只计一次；未分类为未区分站点的历史访问量。<b>点击站点行可查看该站点的访问趋势</b>，再点一次恢复全部站点；每行右侧可删除该站点的历史明细（删除后数量归入「未分类」，总访问量不变）。</p>
      <div id="visitSiteList"><div class="empty">加载中...</div></div>
    </div>
  </div>

  <!-- 订阅管理（订阅者 + 订阅限制 + 群发 + 邮件模板；SMTP 服务器在「设置」页） -->
  <div id="page-subscribe" class="${pageCls("subscribe")}">
    <div class="wk-card">
      <h3 class="wk-title">订阅者</h3>
      <div class="stats-scroll"><div class="stats">
        <div class="stat-card"><div class="num" id="subTotal">-</div><div class="lbl">总数</div></div>
        <div class="stat-card"><div class="num" id="subConfirmed">-</div><div class="lbl">已确认</div></div>
        <div class="stat-card"><div class="num" id="subPending">-</div><div class="lbl">待确认</div></div>
        <div class="stat-card"><div class="num" id="subUnsub">-</div><div class="lbl">已退订</div></div>
      </div></div>
      <div class="filters" style="margin:10px 0">
        <select class="wk-input" id="subStatus" style="width:130px" onchange="loadSubscribers()">
          <option value="">全部状态</option>
          <option value="confirmed">已确认</option>
          <option value="pending">待确认</option>
          <option value="unsubscribed">已退订</option>
        </select>
        <input class="wk-input" id="subQ" style="width:200px" placeholder="按邮箱搜索">
        <button class="wk-btn ghost sm" onclick="loadSubscribers()">刷新</button>
      </div>
      <div id="subList"><div class="empty">加载中...</div></div>
    </div>

    <div class="wk-card">
      <h3 class="wk-title">订阅入口（多种接入方式）</h3>
      <p class="wk-label" style="margin-top:0">订阅页面由后台直接提供、不依赖主题，可分享链接或嵌入任意网站；自定义表单可调接口自行接入。</p>
      <div class="filters" style="margin:0 0 10px;align-items:center">
        <span class="wk-label" style="margin:0">订阅页面</span>
        <input class="wk-input" id="subPageUrl" style="flex:1;min-width:180px" readonly>
        <button class="wk-btn ghost sm" onclick="copySubPageUrl()">复制</button>
        <button class="wk-btn ghost sm" onclick="window.open($('#subPageUrl').value,'_blank')">打开</button>
      </div>
      <ul class="wk-label" style="margin:0;padding-left:18px;line-height:1.9">
        <li>主题订阅框：当前主题文章页的「订阅博客」提交后自动跳转订阅页面（带邮箱参数）</li>
        <li>接口订阅：<b>POST /api/subscribe</b>（body 传 email，以及验证方式对应的 captchaId/captchaCode 或 cfToken）</li>
        <li>验证配置查询：<b>GET /api/subscribe/verify</b>；内置验证码取图：<b>GET /api/captcha/new</b>（返回一次性 id + 图片）</li>
      </ul>
    </div>

    <div class="wk-card">
      <h3 class="wk-title">订阅限制（防刷）</h3>
      <p class="wk-label" style="margin-top:0">按东八区计日，当天新订阅达到上限后，其他人将无法再提交订阅。</p>
      <div class="filters" style="margin:0 0 10px;align-items:center">
        <span class="wk-label" style="margin:0">当日最多订阅量</span>
        <input class="wk-input" id="subDailyLimit" type="number" min="1" max="1000000" style="width:130px" placeholder="100">
        <span class="wk-label" style="margin:0">今日已订阅 <b id="subToday">-</b> 人</span>
        <button class="wk-btn sm" onclick="saveSubLimit()">保存</button>
      </div>
      <div class="msg" id="subLimitMsg"></div>
    </div>

    <div class="wk-card">
      <h3 class="wk-title">群发邮件</h3>
      <label class="wk-label">主题</label>
      <input class="wk-input" id="bcSubject">
      <label class="wk-label">正文（HTML，支持 {{site}} {{email}} {{unsubscribe}}）</label>
      <textarea class="wk-input" id="bcBody" rows="6"></textarea>
      <div class="filters" style="margin:14px 0 0">
        <button class="wk-btn sm" onclick="broadcastSubscribe()">发送给全部已确认订阅者</button>
        <span class="wk-label" style="margin:0;align-self:center">单次上限 100 封</span>
      </div>
    </div>

    <div class="wk-card">
      <h3 class="wk-title">订阅设置（邮件模板）</h3>
      <div class="wk-row">
        <div style="flex:1">
          <label class="wk-label">站点名称</label>
          <input class="wk-input" id="smSiteName" placeholder="我的博客">
        </div>
        <div style="flex:1">
          <label class="wk-label">站点地址</label>
          <input class="wk-input" id="smSiteUrl" placeholder="https://blog.example.com">
        </div>
      </div>
      <label class="wk-label">确认邮件主题</label>
      <input class="wk-input" id="smSubject">
      <label class="wk-label">确认邮件正文（HTML，支持 {{site}} {{email}} {{link}} {{unsubscribe}}）</label>
      <textarea class="wk-input" id="smBody" rows="6"></textarea>
      <label class="wk-label" style="margin-top:14px">新文章通知主题（发布新文章并构建完成后自动发送）</label>
      <input class="wk-input" id="smNotifySubject">
      <label class="wk-label">新文章通知正文（HTML，支持 {{site}} {{title}} {{url}} {{unsubscribe}}）</label>
      <textarea class="wk-input" id="smNotifyBody" rows="6"></textarea>
      <label class="wk-label" style="margin-top:14px">退订成功提示主题（用户主动点邮件里的退订链接后发送）</label>
      <input class="wk-input" id="smUnsubSubject">
      <label class="wk-label">退订成功提示正文（HTML，支持 {{site}} {{email}}）</label>
      <textarea class="wk-input" id="smUnsubBody" rows="4"></textarea>
      <p class="wk-label" style="margin:6px 0 0;line-height:1.7">所有通知/群发邮件都会自动带上「取消订阅」按钮；只有订阅人自己点退订链接才会收到这封提示邮件，后台删除订阅者不会发送。</p>
      <label class="wk-label" style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer">
        <input type="checkbox" id="smNeedConfirm" style="width:auto"> 需要邮件确认（关闭后提交即订阅成功）
      </label>
      <div class="filters" style="margin:12px 0 0;align-items:center">
        <span class="wk-label" style="margin:0">当日最多订阅量</span>
        <input class="wk-input" id="smDailyLimit" type="number" min="1" max="1000000" style="width:130px" placeholder="100">
        <span class="wk-label" style="margin:0">（按东八区计日，达到后当天不再接受新订阅，防刷）</span>
      </div>
      <label class="wk-label" style="margin-top:14px">订阅验证（提交订阅前的人机验证）</label>
      <div class="filters" style="margin:0 0 10px;align-items:center">
        <select class="wk-input" id="smVerify" style="width:220px" onchange="toggleCfFields()">
          <option value="none">无（不验证）</option>
          <option value="cf">Cloudflare Turnstile</option>
          <option value="builtin">内置图形验证码</option>
        </select>
        <span class="wk-label" style="margin:0">内置验证码开箱即用；Turnstile 需到 Cloudflare 控制台创建站点获取密钥</span>
      </div>
      <div id="smCfBox" style="display:none">
        <div class="wk-row">
          <div style="flex:1">
            <label class="wk-label">Turnstile Site Key（公开）</label>
            <input class="wk-input" id="smCfSiteKey" placeholder="0x4AAAAA...">
          </div>
          <div style="flex:1">
            <label class="wk-label">Turnstile Secret Key</label>
            <input class="wk-input" id="smCfSecretKey" type="password" placeholder="">
          </div>
        </div>
      </div>
      <div class="filters" style="margin:14px 0 0">
        <button class="wk-btn sm" onclick="saveSubscribeSettings()">保存配置</button>
      </div>
      <div class="msg" id="subMsg"></div>
    </div>
  </div>

  <!-- AI 助手（聊天：流式输出 + 历史记录） -->
  <div id="page-ai" class="${pageCls("ai")}">
    <div class="wk-card ai-chat">
      <div class="ai-side">
        <div class="ai-side-head">
          <button class="wk-btn ghost sm" onclick="aiToggleSide()" title="收起侧边栏">‹</button>
          <span class="wk-label" style="margin:0">会话</span>
          <div style="flex:1"></div>
          <button class="wk-btn ghost sm" onclick="loadAiConversations()" title="刷新">刷新</button>
        </div>
        <button class="wk-btn sm" style="width:100%;margin-top:6px" onclick="aiNewChat()">＋ 新建对话</button>
        <div class="ai-side-title">历史对话</div>
        <div id="aiConvList" class="ai-conv-list"><div class="empty">加载中...</div></div>
      </div>
      <div class="ai-main">
        <div class="ai-bar">
          <button class="wk-btn ghost sm" id="aiSideToggle" onclick="aiToggleSide()" title="展开侧边栏" style="display:none">› 会话</button>
          <span class="ai-chat-title" id="aiChatTitle" title="双击可重命名" ondblclick="aiRenameConv()">新对话</span>
          <span class="wk-label" id="aiChatHint" style="margin:0"></span>
          <div class="ai-bar-acts">
            <button class="wk-btn ghost sm ai-icon-btn" onclick="aiRenameConv()" title="编辑 / 重命名对话" aria-label="重命名对话">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
            <button class="wk-btn ghost sm" id="aiFullBtn" onclick="aiToggleFull()" title="全屏 / 退出全屏">全屏</button>
          </div>
        </div>
        <div id="aiMessages" class="ai-scroll"><div class="ai-col" id="aiCol"><div class="empty">开始和 AI 对话吧</div></div></div>
        <div class="ai-continue hidden" id="aiContinueBar" style="margin:0 14px">
          <span>这次回复未完成（可能因刷新 / 中断），可从断点继续。</span>
          <button class="wk-btn sm" onclick="aiContinue()">继续</button>
          <button class="wk-btn ghost sm" onclick="aiDismissContinue()">忽略</button>
        </div>
        <div class="msg" id="aiChatMsg" style="margin:0 14px"></div>
        <div class="ai-foot">
          <span class="wk-label" style="margin:0">模型</span>
          <select class="wk-input" id="aiChatModel" onchange="aiSetChatModel(this.value)" style="width:auto;flex:1 1 140px;min-width:80px;max-width:320px;padding:4px 8px"></select>
          <span class="wk-label" id="aiCfQuotaHint" onclick="aiCfQuota(true)" title="点击刷新" style="display:none;margin:0;cursor:pointer;white-space:nowrap"></span>
          <span class="wk-label" style="margin:0">权限</span>
          <select class="wk-input" id="aiChatPermission" onchange="aiSetPermission(this.value)" title="权限：安全模式=仅对话；重要确认=危险操作确认；全部确认=每步确认；完全允许=无需确认" style="width:auto;flex:0 0 auto;min-width:0;padding:4px 8px">
            <option value="safe" title="安全模式 · 仅对话，不执行任何操作">安全模式</option>
            <option value="important" title="重要确认 · 危险操作需确认">重要确认</option>
            <option value="all" title="全部确认 · 每次工具调用都需确认">全部确认</option>
            <option value="full" title="完全允许 · 无需确认，直接执行">完全允许</option>
          </select>
          <span class="wk-label" style="margin:0">思考强度</span>
          <select class="wk-input" id="aiChatThink" onchange="aiSetThink(this.value)" title="思考强度会作为 reasoning_effort 发给服务商；需所选模型支持推理（如 deepseek-reasoner），不支持时会报错" style="width:auto;flex:0 0 auto;min-width:0;padding:4px 8px">
            <option value="off">关闭</option>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
          <button class="wk-btn ghost sm ai-icon-btn" id="aiUsageBtn" onclick="aiToggleUsage(event)" title="查看已用 token / 缓存命中" aria-label="查看 token 用量">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          </button>
        </div>
        <div class="ai-input">
          <textarea class="wk-input" id="aiInput" rows="3" placeholder="输入文字"></textarea>
          <button class="wk-btn sm" id="aiSendBtn" onclick="aiSend()">发送</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 设置（后台设置[外观+工作流+站点功能]、SMTP 邮件服务器、AI 设置、密钥管理、API 说明；订阅数据与邮件模板在「订阅管理」页） -->
  <div id="page-settings" class="${pageCls("settings")}">
    <details class="wk-collapse">
      <summary>后台设置</summary>
      <div class="wk-collapse-body">
        <p class="wk-label" style="margin-top:0">外观与主题色仅作用于你这台设备的浏览器，不影响访客；工作流模式与站点功能对全站生效。</p>
        <div class="filters" style="margin:0 0 4px">
          <span class="wk-label" style="margin:0">深浅色</span>
          <select class="wk-input" id="setThemeMode" onchange="applyThemeMode(this.value)" style="width:auto;min-width:150px;padding:4px 8px">
            <option value="auto">跟随系统</option>
            <option value="light">浅色模式</option>
            <option value="dark">深色模式</option>
          </select>
        </div>
        <div class="filters" style="margin:10px 0 0">
          <span class="wk-label" style="margin:0">主题色</span>
          <select class="wk-input" id="setAccent" onchange="applyAccent(this.value)" style="width:auto;min-width:150px;padding:4px 8px">
            <option value="#f97316">橙色（默认）</option>
            <option value="#3b82f6">蓝色</option>
            <option value="#10b981">绿色</option>
            <option value="#8b5cf6">紫色</option>
            <option value="#ec4899">粉色</option>
            <option value="#ef4444">红色</option>
            <option value="#14b8a6">青色</option>
            <option value="#eab308">金色</option>
            <option value="#64748b">石板灰</option>
          </select>
        </div>
        <div class="filters" style="margin:14px 0 0">
          <span class="wk-label" style="margin:0">工作流触发模式</span>
          <select class="wk-input" id="workflowMode" style="width:auto;min-width:240px;padding:4px 8px">
            <option value="auto">自动 · 发文/删文后自动运行工作流</option>
            <option value="manual">手动 · 发文/删文后需自己运行工作流</option>
          </select>
        </div>
        <p class="wk-label" style="margin:8px 0 0;line-height:1.7">自动：发布 / 删除 / 批量上传文章后自动运行「更新 GitHub Pages」工作流，站点自动更新（新文章构建完成后邮件通知订阅者）。<br>手动：内容只推送到 GitHub，不自动构建；之后会在顶部日志位置提示你去运行工作流，适合攒几篇一起构建。</p>
        <div class="filters" style="margin:14px 0 0">
          <span class="wk-label" style="margin:0">访问量数据保留</span>
          <input class="wk-input" id="retentionDays" type="number" min="1" max="3650" style="width:110px" placeholder="365">
          <span class="wk-label" style="margin:0">天</span>
          <label class="wk-label" style="display:flex;align-items:center;gap:6px;margin:0 0 0 14px;cursor:pointer">
            <input type="checkbox" id="allowGuestComment" style="width:auto"> 允许访客评论（关闭后仅登录用户可评论）
          </label>
        </div>
        <div class="filters" style="margin:14px 0 0">
          <button class="wk-btn sm" onclick="saveWorkflowMode()">保存工作流模式</button>
          <button class="wk-btn sm" onclick="saveSiteSettings()">保存站点功能</button>
        </div>
        <div class="msg" id="adminMsg"></div>
        <div class="msg" id="siteMsg"></div>

        <!-- 管理员账号（用户名 / 密码，与评论区账号无关） -->
        <div style="border-top:1px solid var(--border);margin:16px 0 0;padding-top:14px">
          <p class="wk-label" style="margin-top:0"><b>管理员账号</b>：博客后台的独立登录账号（用户名 + 密码，与评论区账号无关）。用户名和密码都可修改，修改后当前登录保持有效，下次登录使用新的用户名 / 密码。<br>忘记密码？到 GitHub 仓库的 Actions 页手动运行「重置后台账号」工作流，账号密码会重置为 <b>admin / admin</b>（重置后登录页会重新出现「创建管理员」入口，建议登录后立即修改）。</p>
          <div class="wk-row">
            <div style="flex:1">
              <label class="wk-label">用户名</label>
              <input class="wk-input" id="acUser" autocomplete="username" placeholder="登录用户名">
            </div>
            <div style="flex:1">
              <label class="wk-label">旧密码（验证身份）</label>
              <input class="wk-input" id="pwOld" type="password" autocomplete="current-password">
            </div>
          </div>
          <div class="wk-row">
            <div style="flex:1">
              <label class="wk-label">新密码（留空表示不修改）</label>
              <input class="wk-input" id="pwNew" type="password" autocomplete="new-password" placeholder="至少 6 位">
            </div>
            <div style="flex:1">
              <label class="wk-label">确认新密码</label>
              <input class="wk-input" id="pwNew2" type="password" autocomplete="new-password">
            </div>
          </div>
          <div class="filters" style="margin:14px 0 0">
            <button class="wk-btn sm" onclick="changeAdminAccount()">保存账号修改</button>
          </div>
          <div class="msg" id="pwMsg"></div>
        </div>
      </div>
    </details>

    <details class="wk-collapse">
      <summary>SMTP 邮件服务器</summary>
      <div class="wk-collapse-body">
        <p class="wk-label" style="margin-top:0">用于发送订阅确认与群发邮件。<b>Workers 仅支持 465 端口（隐式 TLS）</b>；QQ/163 等邮箱请填写「授权码」而非登录密码。</p>
        <div class="wk-row">
          <div style="flex:2">
            <label class="wk-label">SMTP 服务器</label>
            <input class="wk-input" id="smHost" placeholder="smtp.qq.com">
          </div>
          <div style="flex:1">
            <label class="wk-label">端口</label>
            <input class="wk-input" id="smPort" type="number" value="465" placeholder="465">
          </div>
        </div>
        <div class="wk-row">
          <div style="flex:1">
            <label class="wk-label">用户名</label>
            <input class="wk-input" id="smUser" placeholder="you@qq.com">
          </div>
          <div style="flex:1">
            <label class="wk-label">密码 / 授权码</label>
            <input class="wk-input" id="smPass" type="password" placeholder="留空表示不修改">
          </div>
        </div>
        <div class="wk-row">
          <div style="flex:1">
            <label class="wk-label">发件人名称</label>
            <input class="wk-input" id="smFromName" placeholder="我的博客">
          </div>
          <div style="flex:1">
            <label class="wk-label">发件人邮箱（默认同用户名）</label>
            <input class="wk-input" id="smFromEmail" placeholder="you@qq.com">
          </div>
        </div>
        <div class="filters" style="margin:14px 0 0">
          <button class="wk-btn sm" onclick="saveSubscribeSettings()">保存 SMTP 配置</button>
          <input class="wk-input" id="smTestTo" style="width:220px" placeholder="测试收件邮箱">
          <button class="wk-btn ghost sm" onclick="sendSubscribeTest()">发送测试邮件</button>
        </div>
        <div class="msg" id="smtpMsg"></div>
      </div>
    </details>

    <details class="wk-collapse">
      <summary>AI 设置</summary>
      <div class="wk-collapse-body">
        <label class="wk-label" style="display:flex;align-items:center;gap:6px;margin-top:0;cursor:pointer;font-weight:600">
          <input type="checkbox" id="aiCfEnabled" style="width:auto" onchange="aiCfToggle(this.checked)"> 启用 Cloudflare Workers AI（需令牌具备 Workers AI 权限）
        </label>
        <div class="wk-label" id="aiCfQuotaTop" onclick="aiCfQuota(true)" style="display:none;margin:6px 0 0;cursor:pointer"></div>
        <div id="aiCfBox" style="display:none;border:1px solid var(--border);border-radius:3px;padding:10px;margin:8px 0 4px">
          <div class="filters" style="margin:0;align-items:flex-start">
            <div style="flex:1;min-width:200px">
              <label class="wk-label">Cloudflare Account ID</label>
              <input class="wk-input" id="aiCfAccountId" placeholder="账户 ID（32 位十六进制）">
            </div>
            <div style="flex:1;min-width:200px">
              <label class="wk-label">API 令牌（Workers AI 权限）</label>
              <input class="wk-input" id="aiCfApiKey" type="password" placeholder="留空表示不修改">
            </div>
          </div>
          <div class="filters" style="margin:10px 0 0">
            <button class="wk-btn sm" onclick="aiCfSave()">保存 Cloudflare 配置</button>
            <button class="wk-btn ghost sm" onclick="aiCfLoadModels()">获取模型列表</button>
            <button class="wk-btn ghost sm" onclick="aiCfQuota(true)">查询今日额度</button>
          </div>
          <div class="msg" id="aiCfMsg"></div>
          <div class="wk-label" id="aiCfQuotaBox" style="margin:6px 0 0"></div>
          <label class="wk-label" style="margin-top:12px">启用的模型（勾选后出现在 AI 助手「模型」下拉的 Cloudflare 分组）</label>
          <input class="wk-input" id="aiCfModelSearch" placeholder="搜索模型，如 llama / qwen / deepseek" oninput="aiCfRenderModels()">
          <div class="filters" style="margin:8px 0 0">
            <button class="wk-btn ghost sm" onclick="aiCfPickAll()">全选当前</button>
            <button class="wk-btn ghost sm" onclick="aiCfPickNone()">清空</button>
          </div>
          <div id="aiCfModelList" class="ai-model-list" style="margin-top:8px"></div>
        </div>
        <p class="wk-label" style="margin-top:14px">配置一个 OpenAI 兼容的 AI 接口（Chat Completions 协议）。填入基础地址与密钥后，可直接测试连通性与获取模型列表。</p>
        <label class="wk-label">API 地址（基础地址，带或不带结尾的 /v1 均可）</label>
        <input class="wk-input" id="aiBaseUrl" placeholder="https://api.openai.com/v1">
        <label class="wk-label" style="margin-top:12px">API 密钥</label>
        <input class="wk-input" id="aiApiKey" type="password" placeholder="留空表示不修改">
        <label class="wk-label" style="margin-top:12px">已选的模型（多个用英文逗号分隔，可直接编辑，与下方「可选模型」联动）</label>
        <input class="wk-input" id="aiModelsText" placeholder="如：gpt-4o-mini, deepseek-chat" oninput="aiSyncModelsFromText()">
        <label class="wk-label" style="display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer">
          <input type="checkbox" id="aiClientProxy" style="width:auto"> 前端代理：由浏览器直连服务商
        </label>
        <label class="wk-label" style="margin-top:14px">权限级别（AI 可执行的操作范围）</label>
        <select class="wk-input" id="aiPermission">
          <option value="safe">安全模式 · 仅对话，不执行任何操作</option>
          <option value="important">重要确认 · 危险操作需确认（写文件 / 删除 / 部署 / 改设置）</option>
          <option value="all">全部确认 · 每次工具调用都需确认</option>
          <option value="full">完全允许 · 无需确认，直接执行</option>
        </select>
        <div class="filters" style="margin:14px 0 0">
          <button class="wk-btn sm" onclick="saveAiSettings()">保存配置</button>
          <button class="wk-btn ghost sm" onclick="testAiSettings()">测试连通性</button>
          <button class="wk-btn ghost sm" onclick="loadAiModels()">获取模型列表</button>
        </div>
        <div class="msg" id="aiMsg"></div>
        <details class="wk-collapse" style="margin-top:12px;background:transparent;border:1px solid var(--border)">
          <summary>可选模型（勾选后可在 AI 助手中切换；测试连通性用第一个）</summary>
          <div class="wk-collapse-body" style="border-top:1px solid var(--border)">
            <input class="wk-input" id="aiModelSearch" placeholder="搜索模型，如 free / gpt / claude" oninput="renderAiModels()">
            <div class="filters" style="margin:8px 0 0">
              <span class="wk-label" style="margin:0" id="aiPickedCount"></span>
              <div style="flex:1"></div>
              <button class="wk-btn ghost sm" onclick="aiPickAll()">全选当前</button>
              <button class="wk-btn ghost sm" onclick="aiPickNone()">清空</button>
            </div>
            <div id="aiModelList" class="ai-model-list" style="margin-top:8px"></div>
          </div>
        </details>
        <details class="wk-collapse" style="margin-top:12px;background:transparent;border:1px solid var(--border)">
          <summary>系统提示词（AI 提示词）</summary>
          <div class="wk-collapse-body" style="border-top:1px solid var(--border)">
            <p class="wk-label" style="margin-top:0">直接作为系统提示词随每次对话发给模型（不写入历史记录）。可自行修改；改动会影响 AI 的工具调用与回答风格，<b>改动过大可能导致 AI 无法正常使用</b>。</p>
            <textarea class="wk-input" id="aiPrompt" rows="5" placeholder="例如：你是一个简洁的中文技术助手，回答尽量给要点。"></textarea>
            <div class="filters" style="margin:10px 0 0">
              <button class="wk-btn sm" onclick="aiSavePrompt()">保存提示词</button>
              <button class="wk-btn ghost sm" onclick="aiResetPrompt()">还原默认</button>
            </div>
          </div>
        </details>
        <details class="wk-collapse" style="margin-top:12px;background:transparent;border:1px solid var(--border)">
          <summary>AI 密钥（占位符，安全）</summary>
          <div class="wk-collapse-body" style="border-top:1px solid var(--border)">
            <p class="wk-label" style="margin-top:0">在此保存密钥（如第三方 API Key）。密钥值仅保存在服务端，<b>绝不会下发给 AI，也不会写进提示词</b>。AI 在写入文件或设置时使用占位符 <code>{名称}</code>，执行时会自动替换为真实值。<br>若 AI 需要凭据而你不便在对话里提供，它会发起<b>弹窗</b>让你在本地输入，输入内容直接写入服务端、<b>不会发送给 AI</b>。</p>
            <div class="wk-row">
              <div style="flex:1">
                <label class="wk-label">名称（用于占位符，如 MY_API）</label>
                <input class="wk-input" id="secName" placeholder="MY_API">
              </div>
              <div style="flex:2">
                <label class="wk-label">密钥值</label>
                <input class="wk-input" id="secValue" type="password" placeholder="粘贴密钥值">
              </div>
            </div>
            <div class="filters" style="margin:14px 0 0">
              <button class="wk-btn sm" onclick="saveSecret()">保存密钥</button>
              <button class="wk-btn ghost sm" onclick="loadSecrets()">刷新列表</button>
            </div>
            <div class="msg" id="secMsg"></div>
            <div id="secList" style="margin-top:10px"><div class="empty">加载中...</div></div>
          </div>
        </details>
      </div>
    </details>

    <details class="wk-collapse">
      <summary>API 说明</summary>
      <div class="wk-collapse-body">
        <div class="wk-api-h">访问量</div>
        <ul class="wk-list">
          <li>
            <div>
              <div class="name"><span class="chip">POST</span> /api/visit</div>
              <div class="meta">记录一次访问（前台调用）。同一访客同一天在同一站点只计一次，刷新不重复。可选请求体 {"site":"https://1.com"}（不传则按 Origin/Referer/Host 识别）。返回 {ok, counted, site, today, total}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /api/visit/stats</div>
              <div class="meta">查询访问量。返回 {ok, today, total}，today 按东八区计算</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/visit/sites?days=30</div>
              <div class="meta">按来源站点明细（需管理员登录）。返回 {ok, days, rangeTotal, legacy, sites:[{site,today,range,total}]}；legacy 为未分类（未区分站点）的历史数量</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">DELETE</span> /admin/api/visit/site?site=1.com</div>
              <div class="meta">删除某个站点的历史访问明细（需管理员登录）。只删站点分类明细，总访问量不变，删除的数量会归入 legacy（未分类）</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/visit/daily?days=30&amp;site=1.com</div>
              <div class="meta">按天趋势（需管理员登录）。days 取值 1-3650；可选 site 只看某个站点。返回 {ok, days, site, sum, series:[{day,count}]}；全部站点视图额外返回 siteSeries:[{site,series:[{day,count}]}]（折线图悬停显示站点拆分）</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/visit/settings</div>
              <div class="meta">读取数据保留天数（需管理员登录）。返回 {ok, retention_days}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">PUT</span> /admin/api/visit/settings</div>
              <div class="meta">保存数据保留天数（需管理员登录）。请求体 {"retention_days": 365}，取值 1-3650</div>
            </div>
          </li>
        </ul>

        <div class="wk-api-h">订阅</div>
        <ul class="wk-list">
          <li>
            <div>
              <div class="name"><span class="chip">POST</span> /api/subscribe</div>
              <div class="meta">提交订阅（前台调用，允许跨域）。body {"email":"a@b.com"}；返回 {ok, needConfirm, message}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /api/subscribe/confirm?token=xxx</div>
              <div class="meta">确认订阅（邮件里的链接）。返回一个提示页面</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /api/subscribe/unsubscribe?token=xxx</div>
              <div class="meta">退订（邮件里的链接）。先返回确认页，点「确认退订」（POST）后才执行</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /subscribe?email=xxx</div>
              <div class="meta">独立订阅页面（不依赖主题，可分享/嵌入）。按订阅设置显示对应验证方式</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /api/subscribe/verify</div>
              <div class="meta">查询订阅验证方式（none/cf/builtin）与 Turnstile Site Key，供自定义表单渲染</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /api/captcha/new</div>
              <div class="meta">内置验证码取图：返回一次性 id + data URI 图片；校验随 /api/subscribe 提交 captchaId + captchaCode</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /api/subscribe/stats</div>
              <div class="meta">订阅数统计。返回 {ok, total, confirmed}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/subscribe/settings</div>
              <div class="meta">读取 SMTP/订阅配置（需管理员登录）。返回配置，密码以 hasPass 表示</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">PUT</span> /admin/api/subscribe/settings</div>
              <div class="meta">保存配置（需管理员登录）。pass 留空表示不修改；dailyLimit 为当日最多订阅量（按东八区计日，默认 100）</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/subscribe/list?status=&q=</div>
              <div class="meta">订阅者列表（需管理员登录）。返回 {ok, total, stats, list:[{id,email,status,createdAt}]}，stats.today 为今日新订阅数</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">POST</span> /admin/api/subscribe/approve</div>
              <div class="meta">手动通过订阅者（需管理员登录）。body {"id":1}，将「待确认」直接置为「已确认」</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">DELETE</span> /admin/api/subscribe/subscriber?id=1</div>
              <div class="meta">删除订阅者（需管理员登录，不会给该邮箱发退订提示）</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">POST</span> /admin/api/subscribe/test</div>
              <div class="meta">发送测试邮件（需管理员登录）。body {"to":"a@b.com"}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">POST</span> /admin/api/subscribe/send</div>
              <div class="meta">群发邮件（需管理员登录）。body {"subject":"","body":"&lt;html&gt;"}</div>
            </div>
          </li>
        </ul>

        <div class="wk-api-h">AI</div>
        <p class="wk-label" style="margin:0 0 8px;line-height:1.7">以下接口均需管理员登录。遵循 OpenAI 兼容约定，地址会自动拼接 {baseUrl}/v1/...（已带 /v1 则不重复）。</p>
        <ul class="wk-list">
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/ai/settings</div>
              <div class="meta">读取 AI 配置。返回 {ok, baseUrl, model, enabled, hasKey}，密钥不回传</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">PUT</span> /admin/api/ai/settings</div>
              <div class="meta">保存 AI 配置。body {"baseUrl":"","apiKey":"","model":"","enabled":true}，apiKey 留空表示不修改</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">POST</span> /admin/api/ai/test</div>
              <div class="meta">测试连通性。向 {baseUrl}/chat/completions 发最小请求；body 可传 {"baseUrl","apiKey","model"} 覆盖。返回 {ok, elapsed, model, reply} 或 {ok:false, error}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/ai/models</div>
              <div class="meta">获取全部可用模型。调用 {baseUrl}/models，返回 {ok, count, models:[id...]}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">POST</span> /admin/api/ai/chat</div>
              <div class="meta">聊天（流式）。body {"messages":[...],"model"?}，转发到 {baseUrl}/chat/completions 并原样回传 SSE（text/event-stream）</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/ai/conversations</div>
              <div class="meta">历史会话列表。返回 {ok, list:[{id,title,createdAt,updatedAt}]}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">GET</span> /admin/api/ai/conversation?id=</div>
              <div class="meta">单个会话（含消息）。返回 {ok, conversation:{id,title,messages}}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">PUT</span> /admin/api/ai/conversation</div>
              <div class="meta">保存会话。body {"id"?,"title","messages"}，id 存在则更新，否则新建，返回 {ok, id}</div>
            </div>
          </li>
          <li>
            <div>
              <div class="name"><span class="chip">DELETE</span> /admin/api/ai/conversation?id=</div>
              <div class="meta">删除历史会话</div>
            </div>
          </li>
        </ul>
      </div>
    </details>
  </div>

</div>

<!-- 工作流日志弹窗（CF 代理获取，不跳转 GitHub） -->
<div id="logModal" class="hidden" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:200;display:flex;align-items:center;justify-content:center;padding:16px">
  <div class="wk-card" style="max-width:900px;width:100%;max-height:86vh;display:flex;flex-direction:column;margin:0">
    <div class="toolbar" style="justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap">
      <h3 class="wk-title" style="margin:0;border:none;padding:0">工作流日志<span id="logModalTitle" class="wk-label" style="margin-left:8px"></span></h3>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <a class="wk-btn ghost sm" id="logModalGh" target="_blank" rel="noopener">在 GitHub 打开 ↗</a>
        <button class="wk-btn ghost sm" onclick="closeLogModal()">关闭</button>
      </div>
    </div>
    <div id="logModalBody" style="flex:1;overflow:auto;white-space:pre-wrap;word-break:break-all;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--input-bg);color:var(--fg);border:1px solid var(--border);border-radius:3px;padding:10px;margin-top:10px">加载中...</div>
  </div>
</div>

<script src="${VDIRTOR_JS}"></script>
<script src="${MARKED_JS}"></script>
<script src="${DOMPURIFY_JS}"></script>
<script>var __INITIAL__='${INITIAL}';</script>
<script>${SCRIPT.replace(/__REPO__/g, repo)}</script>
</body>
</html>`;
}