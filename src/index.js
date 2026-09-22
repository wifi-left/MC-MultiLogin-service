const path = require("path");
const http = require('http');        // HTTP服务器API
const https = require('https');      // HTTPS服务器API（管理端口可选启用）
const fs = require('fs');            // 文件系统API
const crypto = require('crypto');    // 常量时间比较密钥
const express = require('express');
const { class_PlayerCache, checkName } = require("./playercache.js");
const { log, globleConfig } = require('./utils.js');
const { config } = require("process");
const { ConfigControl } = require("./config_control.js");
var app = express();    // 创建新的HTTP服务器
var port = 0;
var server = null;
var DefaultSKINSITE = "original";

// 项目根目录（src/ 的上一级），所有运行时路径以根目录为锚，与启动目录无关
const ROOT_DIR = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT_DIR, 'cache');
const WEB_PUBLIC_DIR = path.join(ROOT_DIR, 'web', 'public');

const Fetch = fetch;
// 上游验证请求带超时（fetch_timeout，默认 10s），防止上游挂起导致登录请求永久阻塞、
// 以及 pending_players 标志泄漏造成该玩家被永久"登录过快"拦截
var fetchTimeoutMs = parseInt(globleConfig.get("fetch_timeout", 10000)) || 10000;
function fetchWithTimeout(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
    return Fetch(url, Object.assign({}, options, { signal: controller.signal })).finally(() => clearTimeout(timer));
}
// 构建 hasJoined 上游查询串：所有参数 encodeURIComponent，防止注入额外查询参数
function buildHasJoinedQuery(username, serverId, ip) {
    let q = `?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(serverId || '')}`;
    if (ip != null) q += `&ip=${encodeURIComponent(ip)}`;
    return q;
}
// 单次登录处理中正在解析名字的 uuid（去重，避免同一账号并发触发多轮上游查询）
const pending_name_lookup = new Set();
// push 表是普通对象：必须用 hasOwnProperty 判定。
// 否则名为 toString / constructor / valueOf / __proto__ 等合法玩家名会命中 Object.prototype
// 上的属性，被误判为"已指定来源"，这些玩家将永远登录失败。
function pushSourceFor(name) {
    if (typeof name !== 'string' || name === '') return null;
    let table = PUSH_LOGINMETHOD_PLAYERS || {};
    return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null;
}
// uuid 归一化（与 playercache.js 保持一致）
function normalizeUUID(uuid) {
    if (uuid == null) return null;
    return (uuid + "").toLowerCase().replace(/-/g, "");
}
function isUUIDLike(value) {
    return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value.toLowerCase().replace(/-/g, ""));
}
// 解码 yggdrasil/mojang profile 的 base64 textures 属性，取出皮肤与披风贴图地址
// 上游仍可能返回 http 贴图地址；管理页是 https 时会触发混合内容拦截，统一升级为 https
function upgradeTextureUrl(url) {
    if (typeof url !== 'string') return url;
    return url.replace(/^http:\/\//i, 'https://');
}
function decodeTexturesProperty(base64Value) {
    if (typeof base64Value !== 'string' || base64Value === '') return null;
    try {
        let parsed = JSON.parse(Buffer.from(base64Value, 'base64').toString('utf8'));
        if (!parsed || typeof parsed !== 'object') return null;
        let textures = parsed.textures || {};
        let skinTextures = textures.SKIN || {};
        let capeTextures = textures.CAPE || {};
        let skin = null, cape = null;
        if (typeof skinTextures.url === 'string' && skinTextures.url !== '') {
            skin = { url: upgradeTextureUrl(skinTextures.url), model: 'classic' };
            let meta = skinTextures.metadata || {};
            if (meta && String(meta.model).toLowerCase() === 'slim') skin.model = 'slim';
        }
        if (typeof capeTextures.url === 'string' && capeTextures.url !== '') {
            cape = { url: upgradeTextureUrl(capeTextures.url) };
        }
        return (skin || cape) ? { skin, cape } : null;
    } catch (e) {
        return null;
    }
}
function extractTextureInfo(profile) {
    if (!profile || typeof profile !== 'object') return null;
    let props = profile.properties;
    if (!Array.isArray(props)) return null;
    for (let prop of props) {
        if (prop && prop.name === 'textures') {
            let decoded = decodeTexturesProperty(prop.value);
            if (decoded) return decoded;
        }
    }
    return null;
}
/* ==================== 管理面板图片白名单 ====================
 * 管理面板的皮肤/披风由浏览器直连上游贴图域，CSP img-src 必须逐个列出允许的域名。
 * 白名单组成（取并集）：
 *   1. Mojang 官方贴图域（固定）
 *   2. config 的 skinDomains
 *   3. config 的 apis[].root 主机
 *   4. config 的 avatar_domains —— 私有部署的贴图域名写在这里
 * avatar_domains 建议只写在 config/config.json（已被 .gitignore 忽略、不入库），
 * 不要写进 config/config_example.json，避免私有域名随仓库公开。
 */
const AVATAR_BASE_HOSTS = ['textures.minecraft.net', 'sessionserver.mojang.com', 'api.mojang.com'];
var AvatarDomains = [];
// 白名单/ CSP 串在每次请求都会用到，缓存到下一次配置重载
var avatarHostsCache = null;
var avatarImgSrcCache = null;
function skinDomainToHost(value) {
    if (typeof value !== 'string' || value === '') return null;
    try {
        if (/^https?:\/\//i.test(value)) return new URL(value).hostname;
    } catch (e) {
        return null;
    }
    let host = value.trim().replace(/^\/+/, '').split('/')[0].split(':')[0];
    return host === '' ? null : host;
}
// 当前生效的图片域名白名单（供 CSP 与管理端展示）
function avatarAllowedHosts() {
    if (avatarHostsCache) return avatarHostsCache.slice();
    let hosts = new Set(AVATAR_BASE_HOSTS);
    for (let d of SkinDomains) {
        let host = skinDomainToHost(d);
        if (host) hosts.add(host);
    }
    for (let api of URL_APIS) {
        if (!api || typeof api.root !== 'string' || api.root === '') continue;
        let host = skinDomainToHost(api.root);
        if (host) hosts.add(host);
    }
    for (let d of AvatarDomains) {
        let host = skinDomainToHost(d);
        if (host) hosts.add(host);
    }
    avatarHostsCache = Array.from(hosts);
    return avatarHostsCache.slice();
}
function avatarImgSrc() {
    if (!avatarImgSrcCache) {
        avatarImgSrcCache = "img-src 'self' data: blob: " + avatarAllowedHosts().map(h => 'https://' + h).join(' ');
    }
    return avatarImgSrcCache;
}
// 配置里可能写成数组或逗号分隔的字符串
function parseAvatarDomains(value) {
    if (Array.isArray(value)) return value.filter(v => typeof v === 'string' && v !== '');
    if (typeof value === 'string' && value !== '') {
        return value.split(',').map(s => s.trim()).filter(s => s !== '');
    }
    return [];
}
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout
})


var PUSH_LOGINMETHOD_PLAYERS = globleConfig.get("push", { "handles": {} }).handles;
var URL_APIS = globleConfig.get("apis", {});
var HANDLES = globleConfig.get("method", []);
var SkinDomains = globleConfig.get("skinDomains", ["127.0.0.1"]);
var DefaultSKINSITE = globleConfig.get("default", "original");
var PlayerCaches = {};
// 管理服务器配置
var manageUrl = globleConfig.get("manage_url", "/manage");
var manageApp = globleConfig.get("manage_port", 0) > 0 ? express() : null;
var manageHost = globleConfig.get("manage_host", "127.0.0.1");
var managePort = 0;
var manageServer = null;
var manageHttpsOptions = null;

// 如果管理端口启用了 trust proxy（部署在 nginx 等反代后面），
// req.ip 会取真实客户端 IP，限流和日志才能按真实来源统计。
if (manageApp && globleConfig.get("manage_trust_proxy", false) === true) {
    manageApp.set('trust proxy', 1);
}

// 读取 HTTPS 配置（manage_https_cert / manage_https_key），两者都存在且文件可读时管理端口使用 HTTPS
function initManageHttps() {
    let cert = globleConfig.get("manage_https_cert", "");
    let key = globleConfig.get("manage_https_key", "");
    if (!cert || !key) {
        manageHttpsOptions = null;
        return;
    }
    try {
        manageHttpsOptions = {
            cert: fs.readFileSync(path.join(ROOT_DIR, cert)),
            key: fs.readFileSync(path.join(ROOT_DIR, key))
        };
    } catch (e) {
        manageHttpsOptions = null;
        log(`[WARN] Cannot load manage_https_cert/key (${e.message}), management server will use HTTP.`);
    }
}
function listenManageServer() {
    if (manageHttpsOptions) {
        manageServer = https.createServer(manageHttpsOptions, manageApp).listen(managePort, manageHost);
    } else {
        manageServer = manageApp.listen(managePort, manageHost);
    }
}

// 管理路由安全响应头（防点击劫持 / 类型嗅探 / 信息泄露）
function manageSecurityHeaders(req, res, next) {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
}

// 皮肤贴图反代：仅允许白名单域名，且必须是图片
var skinProxyEnabled = true;
var SKIN_PROXY_MAX_BYTES = 4 * 1024 * 1024;
function isAllowedSkinHost(host) {
    if (typeof host !== 'string' || host === '') return false;
    let list = avatarAllowedHosts();
    return list.some(h => h.toLowerCase() === host.toLowerCase());
}
function guessImageType(buffer) {
    if (!buffer || buffer.length < 12) return null;
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png';
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
    if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}
// 管理面板鉴权：必须持有有效的管理会话 Cookie。
// 不接受 URL 查询串里的 secret —— URL 会被写进访问日志、浏览器历史与 Referer，等于明文泄露密钥。
function hasManageAccess(req) {
    return getAdminSession(req) != null;
}
// 管理接口统一门禁：未登录一律 401；会话还必须与接口所属的子配置一致，
// 避免用 A 子配置的会话去管理 B 子配置的玩家数据。
// 另外做跨站校验：会话 Cookie 成为唯一凭据后，其它站点不得借用它产生副作用（CSRF 纵深防御）。
function isCrossSiteRequest(req) {
    // 1) 首选浏览器自带的 Sec-Fetch-Site：它由浏览器按"发起页面"与"请求目标"的真实来源判定，
    //    不受反向代理改写 Host 影响，比 Origin/Host 比对可靠得多。
    //    管理面板自身发起的请求一定是 same-origin；其它站点（含同站不同子域/不同端口）不可信，
    //    且管理页已用 frame-ancestors 'none' 禁止被嵌入，因此只放行 same-origin / none。
    let site = req.headers['sec-fetch-site'];
    if (typeof site === 'string' && site !== '') {
        let v = site.trim().toLowerCase();
        return v !== 'same-origin' && v !== 'none';
    }
    // 2) 没有该头（老旧浏览器 / 非浏览器客户端）时退回 Origin 与 Host 比对。
    //    没有 Origin 头的一律放行：curl、服务端脚本不会自动带上受害者的 Cookie，无法被 CSRF 利用。
    let origin = req.headers.origin;
    if (!origin) return false;
    let originHost;
    try {
        originHost = new URL(origin).host.toLowerCase();
    } catch (e) {
        // "null"（沙箱 iframe / data: 页面）等解析失败的情况按跨站处理
        return true;
    }
    let hosts = [req.headers.host];
    // 反向代理场景：nginx 默认会把 Host 改写成上游地址，此时只有 X-Forwarded-Host 才等于浏览器看到的主机名。
    // 该头只有非浏览器客户端能伪造，而它们本就不携带 Cookie，因此放开它不构成 CSRF 风险。
    if (globleConfig.get("manage_trust_proxy", false) === true && req.headers['x-forwarded-host']) {
        hosts.push(String(req.headers['x-forwarded-host']).split(',')[0]);
    }
    // 大小写不敏感：浏览器会把 Origin 里的主机名小写化，而 Host 头保留用户输入的大小写
    return !hosts.some(h => typeof h === 'string' && h.trim().toLowerCase() === originHost);
}
// 管理接口的拒绝/失败统一记一行日志，便于排查"谁在试探"。
// 注意：详细的排查信息只进日志，不放进响应体（未鉴权的调用者看不到内部细节）。
function logManageReject(req, status, reason) {
    log(`[MANAGE][${status}] ${reason} - ${req.method} ${req.originalUrl} from ${req.ip || 'unknown'}`);
}
function requireManageSession(handleUrl) {
    return function (req, res, next) {
        let session = getAdminSession(req);
        if (!session) {
            // 面板对 401 使用自己的提示文案（不读这里的 body），所以这里保持通用，不透露鉴权方式
            logManageReject(req, 401, 'Unauthorized (no valid admin session)');
            res.status(401).send({ "error": "Unauthorized" }).end();
            return;
        }
        if (handleUrl != null && session.m !== handleUrl) {
            // 只有已登录的会话才可能走到这里，面板会原样展示该原因，故保留可读文案
            logManageReject(req, 403, `Forbidden (session sub-config <${session.m}> != <${handleUrl}>)`);
            res.status(403).send({ "error": "当前登录的子配置无权访问该接口" }).end();
            return;
        }
        if (isCrossSiteRequest(req)) {
            // 打印实际取值，便于排查反向代理改写 Host、主机名大小写等部署问题
            logManageReject(req, 403, `Forbidden (cross-site; Origin=${req.headers.origin || '-'} Host=${req.headers.host || '-'} Sec-Fetch-Site=${req.headers['sec-fetch-site'] || '-'})`);
            res.status(403).send({ "error": "跨站请求被拒绝：请通过配置的 manage_url 同源打开管理面板（若管理端口在反向代理之后，请保留 Host 头或开启 manage_trust_proxy）" }).end();
            return;
        }
        next();
    };
}
// 对外的封禁 API（{url}/ban/*）默认关闭：它会用请求体密钥鉴权、可被外部脚本直接调用，
// 需要显式配置 ban_api: true 才启用。管理面板的封禁操作走 /manage/ban/*（登录会话鉴权）。
function requireBanApiEnabled(req, res, next) {
    if (globleConfig.get("ban_api", false) === true) {
        next();
        return;
    }
    // 对未鉴权的调用者只回通用错误；"如何开启"只写日志（面板已改用 /manage/ban/*，不依赖该接口）
    logManageReject(req, 403, 'Forbidden (ban_api is disabled; set ban_api: true to enable the external ban API)');
    res.status(403).send({ "error": "Forbidden" }).end();
}
async function handleSkinProxy(req, res) {
    if (!skinProxyEnabled) {
        res.status(404).send({ "error": "Not Found" }).end();
        return;
    }
    if (!hasManageAccess(req)) {
        logManageReject(req, 403, 'Forbidden (skin proxy requires an admin session)');
        res.status(403).send({ "error": "Forbidden" }).end();
        return;
    }
    let raw = String(req.query.url || '').trim();
    if (raw === '') {
        res.status(400).send({ "error": "Missing url" }).end();
        return;
    }
    // 上游可能返回 http 贴图地址，统一按 https 取
    if (raw.startsWith('http://')) raw = 'https://' + raw.substring(7);
    let target;
    try {
        target = new URL(raw);
    } catch (e) {
        res.status(400).send({ "error": "Invalid url" }).end();
        return;
    }
    if (target.protocol !== 'https:') {
        res.status(400).send({ "error": "Only https is allowed" }).end();
        return;
    }
    if (!isAllowedSkinHost(target.hostname)) {
        res.status(403).send({ "error": "Domain not in whitelist: " + target.hostname }).end();
        return;
    }
    try {
        let data = await fetchWithTimeout(target.toString(), { method: 'GET' });
        if (!data.ok) {
            res.status(data.status === 404 ? 404 : 502).send({ "error": "Upstream returned " + data.status }).end();
            return;
        }
        let declared = parseInt(data.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > SKIN_PROXY_MAX_BYTES) {
            res.status(413).send({ "error": "Image too large" }).end();
            return;
        }
        let buf = Buffer.from(await data.arrayBuffer());
        if (buf.length > SKIN_PROXY_MAX_BYTES) {
            res.status(413).send({ "error": "Image too large" }).end();
            return;
        }
        let type = guessImageType(buf);
        if (!type) {
            res.status(415).send({ "error": "Upstream response is not a supported image" }).end();
            return;
        }
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.send(buf).end();
    } catch (e) {
        console.error(e);
        res.status(502).send({ "error": "Failed to fetch skin texture" }).end();
    }
}
// 是否使用反代：默认启用，可用 skin_proxy: false 关闭
function skinUrlTransform(raw) {
    if (typeof raw !== 'string' || raw === '') return raw;
    if (!skinProxyEnabled) return raw;
    let base = (typeof manageUrl === 'string' && manageUrl !== '') ? manageUrl.replace(/\/+$/, '') : '/manage';
    return base + '/skin-proxy?url=' + encodeURIComponent(raw);
}

// 管理接口限流：每 IP 每分钟最多 manage_rate_limit 次（默认 120，0 关闭），防暴力猜密钥
var manageRateBuckets = new Map();
function manageLimiter(req, res, next) {
    let limit = parseInt(globleConfig.get("manage_rate_limit", 120)) || 0;
    if (limit <= 0) { next(); return; }
    let ip = req.ip || 'unknown';
    let now = Date.now();
    let bucket = manageRateBuckets.get(ip);
    if (!bucket || (now - bucket.start) >= 60000) {
        bucket = { start: now, count: 0 };
        manageRateBuckets.set(ip, bucket);
    }
    // 清理过期桶，防止内存无限增长
    if (manageRateBuckets.size > 10000) {
        for (let [k, b] of manageRateBuckets) {
            if ((now - b.start) >= 60000) manageRateBuckets.delete(k);
        }
    }
    bucket.count++;
    if (bucket.count > limit) {
        res.status(429).send({ "error": "Too many requests. Please wait a moment and retry." }).end();
        return;
    }
    next();
}

// 公开端点限流（hasJoined/profiles/profiles_post）：防止被用作上游代理轰炸或反复触发目录扫描
// 每 IP 每分钟 public_rate_limit 次（默认 60，0 关闭）
var publicRateBuckets = new Map();
function publicLimiter(req, res, next) {
    let limit = parseInt(globleConfig.get("public_rate_limit", 60)) || 0;
    if (limit <= 0) { next(); return; }
    let ip = req.ip || 'unknown';
    let now = Date.now();
    let bucket = publicRateBuckets.get(ip);
    if (!bucket || (now - bucket.start) >= 60000) {
        bucket = { start: now, count: 0 };
        publicRateBuckets.set(ip, bucket);
    }
    if (publicRateBuckets.size > 10000) {
        for (let [k, b] of publicRateBuckets) {
            if ((now - b.start) >= 60000) publicRateBuckets.delete(k);
        }
    }
    bucket.count++;
    if (bucket.count > limit) {
        res.status(429).send({ "error": "Too many requests. Please wait a moment and retry." }).end();
        return;
    }
    next();
}

// 常量时间比较密钥，避免时序侧信道
function safeSecretEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    let ha = crypto.createHash('sha256').update(a).digest();
    let hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// 请求体大小限制：防止超大请求体导致内存耗尽（超限返回 413 并终止请求）
// 返回可变对象 { value }，data 事件累积到 value，调用方在 end 事件中读取 body.value
var bodyLimitBytes = (parseInt(globleConfig.get("body_limit_mb", 1)) || 1) * 1024 * 1024;
function readBodyAccumulator(req, res, limitBytes = bodyLimitBytes) {
    const acc = { value: '' };
    let size = 0;
    req.on('data', (chunk) => {
        size += chunk.length;
        if (size > limitBytes) {
            res.status(413).send({ "error": "Request body too large" }).end();
            req.destroy();
            return;
        }
        acc.value += chunk;
    });
    return acc;
}

// ===== 管理面板登录会话（httpOnly Cookie，未登录无法访问管理主页面） =====
var adminSessionKey = crypto.randomBytes(32); // 会话签名密钥，重启后会话失效
var ADMIN_SESSION_COOKIE = 'ml_admin_session';
function issueSessionToken(methodUrl, ttlMs) {
    let payload = Buffer.from(JSON.stringify({ m: methodUrl, exp: Date.now() + ttlMs })).toString('base64url');
    let sig = crypto.createHmac('sha256', adminSessionKey).update(payload).digest('base64url');
    return payload + '.' + sig;
}
function verifySessionToken(token) {
    if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
    let parts = token.split('.');
    if (parts.length !== 2) return null;
    let expected;
    try {
        expected = crypto.createHmac('sha256', adminSessionKey).update(parts[0]).digest('base64url');
    } catch (e) {
        return null;
    }
    let sb = Buffer.from(parts[1]), eb = Buffer.from(expected);
    if (sb.length !== eb.length || !crypto.timingSafeEqual(sb, eb)) return null;
    try {
        let data = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        if (!data || !data.m || !data.exp || Date.now() > data.exp) return null;
        return data;
    } catch (e) {
        return null;
    }
}
// 原型安全的字典：玩家名/来源 id 都可能与 Object.prototype 上的属性同名
function newDict() {
    return Object.create(null);
}
function parseCookies(req) {
    let out = newDict();
    let raw = req.headers.cookie;
    if (!raw) return out;
    raw.split(';').forEach(pair => {
        let i = pair.indexOf('=');
        if (i < 0) return;
        let value;
        try {
            value = decodeURIComponent(pair.slice(i + 1).trim());
        } catch (e) {
            // 畸形百分号编码（如 "x=%"）会让 decodeURIComponent 抛异常。
            // 这里必须吞掉：否则请求 500，异步路由（皮肤反代）还会变成未处理拒绝
            return;
        }
        out[pair.slice(0, i).trim()] = value;
    });
    return out;
}
function getAdminSession(req) {
    return verifySessionToken(parseCookies(req)[ADMIN_SESSION_COOKIE]);
}
// HTML 开始处理
// 注册URL
if (HANDLES == null || HANDLES.length <= 0) {
    log("[WARN] The server doesn't have any URL handles. Please check your config file.");
    process.exit(1)
    return;
}

// 全局中间件：记录所有请求的 URL（必须放在所有路由之前）
app.use((req, res, next) => {
    if (globleConfig.get("debug", false)) {
        log(`[debug] Recieved: [${req.method}] ${req.originalUrl}`);
    }
    // 或者使用 req.url（可能会被路由重写，originalUrl 更可靠）
    next(); // 继续传递给后续的路由
});


for (let i = 0; i < HANDLES.length; i++) {
    let url = HANDLES[i].url;
    let idx = i + 0;
    let methodName = HANDLES[i].name || "default";
    let cachePath = path.join(CACHE_DIR, methodName);
    PlayerCaches[idx] = new class_PlayerCache(cachePath);
    console.log("Register url path: " + url + " with cache: " + cachePath);
    app.get(url, function (req, res) { urlHandle_root(req, res, idx) });
    app.post(`${url}/api/profiles/minecraft`, publicLimiter, function (req, res) { urlHandle_profiles_post(req, res, idx) });
    app.get(`${url}/sessionserver/session/minecraft/hasJoined`, publicLimiter, function (req, res) { urlHandle_joinServer(req, res, idx) });
    app.post(`${url}/minecraftservices/minecraft/profile/lookup/bulk/byname`, publicLimiter, function (req, res) { urlHandle_profiles_post(req, res, idx) });
    app.get(`${url}/sessionserver/session/minecraft/profile/*`, publicLimiter, function (req, res) { urlHandle_profiles(req, res, idx) })
    app.get(`${url}/api/minecraft/profile/lookup/name/*`, publicLimiter, function (req, res) { urlHandle_profiles(req, res, idx) })

    // Ban API endpoints（对外机器接口：默认关闭，需配置 ban_api: true；用请求体 secret 鉴权）
    let mApp = manageApp || app;
    mApp.post(`${url}/ban/uuid/:uuid/:time`, manageLimiter, requireBanApiEnabled, function (req, res) { urlHandle_ban_uuid(req, res, idx) });
    mApp.post(`${url}/ban/name/:name/:time`, manageLimiter, requireBanApiEnabled, function (req, res) { urlHandle_ban_name(req, res, idx) });

    // Management API endpoints —— 全部要求管理面板已登录（会话按子配置绑定）
    let gate = requireManageSession(url);
    mApp.post(`${url}/manage/ban/:target/:time`, manageLimiter, gate, function (req, res) { urlHandle_manage_ban(req, res, idx) });
    mApp.post(`${url}/manage/alias-conflicts`, manageLimiter, gate, function (req, res) { urlHandle_manage_alias_conflicts(req, res, idx) });
    mApp.post(`${url}/manage/query/:player`, manageLimiter, gate, function (req, res) { urlHandle_manage_query(req, res, idx) });
    mApp.post(`${url}/manage/list`, manageLimiter, gate, function (req, res) { urlHandle_manage_list(req, res, idx) });
    mApp.post(`${url}/manage/bans`, manageLimiter, gate, function (req, res) { urlHandle_manage_bans(req, res, idx) });
    mApp.post(`${url}/manage/modify/:player`, manageLimiter, gate, function (req, res) { urlHandle_manage_modify(req, res, idx) });
    mApp.post(`${url}/manage/delete/:player`, manageLimiter, gate, function (req, res) { urlHandle_manage_delete(req, res, idx) });
    mApp.post(`${url}/manage/rebuild-uuid`, manageLimiter, gate, function (req, res) { urlHandle_manage_rebuild_uuid(req, res, idx) });
    mApp.post(`${url}/manage/check-uuid`, manageLimiter, gate, function (req, res) { urlHandle_manage_check_uuid(req, res, idx) });
    mApp.post(`${url}/manage/player-info/:query`, manageLimiter, gate, function (req, res) { urlHandle_manage_player_info(req, res, idx) });
    mApp.post(`${url}/manage/names/:query`, manageLimiter, gate, function (req, res) { urlHandle_manage_names(req, res, idx) });
    mApp.post(`${url}/manage/avatar/:query`, manageLimiter, gate, function (req, res) { urlHandle_manage_avatar(req, res, idx) });
    mApp.post(`${url}/manage/stats`, manageLimiter, gate, function (req, res) { urlHandle_manage_stats(req, res, idx) });
    mApp.post(`${url}/manage/export`, manageLimiter, gate, function (req, res) { urlHandle_manage_export(req, res, idx) });
    mApp.post(`${url}/manage/batch-delete`, manageLimiter, gate, function (req, res) { urlHandle_manage_batch_delete(req, res, idx) });
    mApp.post(`${url}/manage/batch-unban`, manageLimiter, gate, function (req, res) { urlHandle_manage_batch_unban(req, res, idx) });

}
// 皮肤站处理开始
var ErrorMessages = globleConfig.get("errorMessages", {});
var loginCooldownTime = globleConfig.get("login_cooldown", 5000);
function getMsg(key, vars) {
    const defaults = {
        "DUPLICATE_NAME": '该玩家名已被来自 "{from}" 的账号占用，不允许其他皮肤站的同名玩家登录',
        "DUPLICATE_UUID": '该账号的 UUID 与已有玩家 "{name}"（来自 "{from}"）冲突',
        "NAME_TAKEN": '玩家名 "{name}" 已被来自 "{from}" 的账号占用，且该账号当前仍使用此名称',
        "NAME_TAKEN_OTHER_SOURCE": '玩家名 "{name}" 已被来自 "{from}" 的账号占用，来源不同无法自动改名',
        "NAME_UNCHANGED": '玩家名 "{name}" 仍由该账号（来自 "{from}"）持有，无法为你改名，请更换名称',
        "NAME_LOOKUP_FAILED": '无法确认玩家名 "{name}" 持有者的当前名称（来源 "{from}" 查询失败），请稍后再试或更换名称',
        "HOLDER_RENAMED": '玩家名 "{name}" 的原持有者已改名为 "{newName}"，已自动为其更新档案',
        "HOLDER_REMOVED": '玩家名 "{name}" 的原持有者账号已不存在，已移除其历史档案',
        "BANNED_FOREVER": "您已被永久封禁",
        "BANNED": "您已被封禁",
        "NOT_FOUND": "玩家未在任何已配置的皮肤站找到",
        "UNSUPPORTED_SKIN_SITE": "该玩家注册的皮肤站不在此服务器支持列表中",
        "FETCH_ERROR": "连接验证服务器失败",
        "VERIFY_FAILED": "验证失败，你应当通过 {name} 进入",
        "LOGIN_TOO_FAST": "你的登录过快，请稍后再试",
        "BAN_UNTIL": "解封时间: "
    };
    let msg = (ErrorMessages[key] !== undefined) ? ErrorMessages[key] : (defaults[key] || key);
    if (vars) {
        for (let k of Object.keys(vars)) {
            msg = msg.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k] != null ? vars[k] : "");
        }
    }
    return msg;
}
function detailReject(res, detail, cause, message) {
    if (detail) {
        res.status(403).send({
            "error": "ForbiddenOperationException",
            "errorMessage": message,
            "cause": cause
        }).end();
    } else {
        res.status(204).end();
    }
}
function buildDetailError(k, cache, playerName) {
    if (k.error === "DUPLICATE_NAME") {
        let body = {
            "error": "ForbiddenOperationException",
            "errorMessage": getMsg("DUPLICATE_NAME", { from: k.existingFrom }),
            "cause": "DUPLICATE_NAME"
        };
        if (cache && playerName) {
            let availableId = cache.find_available_name(playerName);
            if (availableId) body.availableId = availableId;
        }
        return body;
    }
    if (k.error === "NAME_TAKEN") {
        let key = k.reason === "other_source" ? "NAME_TAKEN_OTHER_SOURCE" : "NAME_TAKEN";
        return {
            "error": "ForbiddenOperationException",
            "errorMessage": getMsg(key, { name: k.existingName, from: k.existingFrom }),
            "cause": key
        };
    }
    if (k.error === "NAME_UNCHANGED") {
        return {
            "error": "ForbiddenOperationException",
            "errorMessage": getMsg("NAME_UNCHANGED", { name: k.existingName, from: k.existingFrom }),
            "cause": "NAME_UNCHANGED"
        };
    }
    if (k.error === "NAME_LOOKUP_FAILED") {
        return {
            "error": "ForbiddenOperationException",
            "errorMessage": getMsg("NAME_LOOKUP_FAILED", { name: k.existingName, from: k.existingFrom }),
            "cause": "NAME_LOOKUP_FAILED"
        };
    }
    if (k.error === "HOLDER_RENAMED" || k.error === "HOLDER_REMOVED") {
        let key = k.error;
        return {
            "error": "ForbiddenOperationException",
            "errorMessage": getMsg(key, { name: k.existingName, newName: k.newName || "" }),
            "cause": key
        };
    }
    if (k.error === "DUPLICATE_UUID") {
        return {
            "error": "ForbiddenOperationException",
            "errorMessage": getMsg("DUPLICATE_UUID", { name: k.existingName, from: k.existingFrom }),
            "cause": "DUPLICATE_UUID"
        };
    }
    return {
        "error": "ForbiddenOperationException",
        "errorMessage": getMsg(k.error || "UNKNOWN", {}),
        "cause": k.error || "UNKNOWN"
    };
}
// 改名冲突处理用的上游查询闭包：只在旧档案自身的来源里查（来源不同一律不查）
function buildNameResolver(api) {
    return {
        available: true,
        // 本轮改名链中已处理过的 uuid：命中即判定为环，立即终止
        visited: [],
        nameForUuid: async function (uuid) {
            let key = normalizeUUID(uuid);
            if (key == null) return { status: "missing" };
            // 并发去重：同一 uuid 已有解析在进行时不重复打上游，也不误判为"账号不存在"
            if (pending_name_lookup.has(key)) return { status: "failed" };
            pending_name_lookup.add(key);
            try {
                return await probeNameForUuid(api, key);
            } finally {
                pending_name_lookup.delete(key);
            }
        }
    };
}
function trySavePlayer(player, api, response_data, res, from, detail) {
    log("[FOUND] Found <" + player + "> should come from <" + api.name + ">");
    let dat = response_data;
    // 登录时间与 ip 随 add 一次性写入缓存，不再写后再读再写
    let resolver = buildNameResolver(api);
    PlayerCaches[from].add(dat.name, dat.id, api.id, { lastLogin: new Date().getTime(), ip: null }, resolver, 0)
        .then(k => {
            if (k === true) {
                res.send(response_data).end();
                return;
            }
            if (k && (k.error === "HOLDER_RENAMED" || k.error === "HOLDER_REMOVED")) {
                // 冲突的另一方已被自动处理，本次登录本身是成功的
                log(`[RENAME] conflict resolved on the other side (${k.error}: ${k.existingName} -> ${k.newName || '(removed)'}), allowing <${player}> to join.`);
                res.send(response_data).end();
                return;
            }
            if (detail && k && k.error) {
                res.status(403).send(buildDetailError(k, PlayerCaches[from], dat.name)).end();
            } else {
                res.status(204).end();
            }
        })
        .catch(e => {
            console.error(e);
            if (detail) {
                res.status(403).send(buildDetailError({ error: "NAME_LOOKUP_FAILED", existingName: player }, PlayerCaches[from], dat.name)).end();
            } else {
                res.status(204).end();
            }
        });
}
function urlHandle_root(req, res, from) {
    // console.log('404 handler..')
    // console.log(req.url);
    log(req.url);

    res.send({
        "skinDomains": SkinDomains
    }).end();
}
function fetchPlayerInfo_step(args, apis, res, player, from, detail) {
    if (apis.length <= 0) {
        try {
            detailReject(res, detail, "NOT_FOUND", getMsg("NOT_FOUND", {}));
            log(`${player} not found in the remote server.`);
        } finally {
            // 无论响应是否发送成功都要释放 pending 标记，否则该玩家会被永久判为"登录过快"
            delete pending_players[player];
        }
        return;
    }
    let a = apis[0];
    let api = lookupApi(a);
    // 不能原地 splice 传入数组：这里改用切片，避免调用方持有的引用被改写
    let b = apis.slice(1);
    // 配置里写了不存在的来源 id 时必须跳过：api 为 null 时访问 api.name 会抛异常，
    // 而异常会让 pending_players 标记泄漏，该玩家此后一直收到"登录过快"
    if (!api) {
        log("[WARN] Unknown api id <" + a + "> in config, skipping.");
        fetchPlayerInfo_step(args, b, res, player, from, detail);
        return;
    }
    log("Looking up " + api.name + " [" + player + "]")
    if (api.id == 'original') {
        fetchWithTimeout(`https://sessionserver.mojang.com/session/minecraft/hasJoined${args}`).then(data => {
            if (data.status == 204) {
                throw "Not found";
            }
            res.status(data.status);
            return data.json()
        }
        ).then(data => {
            trySavePlayer(player, api, data, res, from, detail);
            try {
                delete pending_players[player];
            } catch (e) {
                log(e);
            }
        }).catch(e => {
            // console.error(e);
            // res.status(204).end();
            // 寻找下一个
            fetchPlayerInfo_step(args, b, res, player, from, detail);
        })

    } else {
        fetchWithTimeout(api.root + `/sessionserver/session/minecraft/hasJoined${args}`).then(data => {
            if (data.status == 204) {
                throw "Not found";
            }
            res.status(data.status);
            return data.json()
        }).then(data => {
            // 记录了
            try {
                delete pending_players[player];
            } catch (e) {
                log(e);
            }
            trySavePlayer(player, api, data, res, from, detail);
        }).catch(e => {
            // console.error(e);
            // res.status(204).end();
            // 寻找下一个
            fetchPlayerInfo_step(args, b, res, player, from, detail);
        })
    }
}
// 原型安全：玩家名可能等于 Object.prototype 上的属性名（toString / constructor / __proto__ ...）
const pending_players = Object.create(null);
function urlHandle_joinServer(req, res, from) {
    // console.log('404 handler..')
    // console.log(req.url);
    let handle = HANDLES[from];
    if (handle.handles == undefined) {
        throw "Wrong config for " + handle.url;
        return;
    }
    let username = req.query.username;
    let profile_name = username;
    let serverId = req.query.serverId;
    let ip = req.query.ip;
    let detail = req.query.detail === 'true';
    let ipdisplay = ip + "";
    if (ip == undefined) ipdisplay = "Unknown"
    if (username == null || serverId == null || serverId == "" || username == "") {
        res.status(403).end();
        return;
    }
    log('[JOIN][' + handle.name + '] <' + username + "> want to join. IP: " + ipdisplay + "");
    if (pending_players[username] === true) {
        detailReject(res, detail, "LOGIN_TOO_FAST", getMsg("LOGIN_TOO_FAST", {}));
        log(`[COOLDOWN] ${username} login too fast. (Pending)`)
        return;
    }
    let info = PlayerCaches[from].lookup(username);
    // 请求内文件是否被本流程重写过（封禁超时解封会重写文件，导致本地 info 与磁盘不一致）
    let infoFresh = true;
    if (info) {
        if (info.ban == true) {
            if (info.banTime == 0) {
                console.log("Player was forever banned.")
                let msg = getMsg("BANNED_FOREVER", {});
                if (info.banReason) msg += '\n' + info.banReason;
                detailReject(res, detail, "BANNED_FOREVER", msg);
                return;
            }
            else if (info.banTime <= new Date().getTime()) {
                info.ban = false;
                PlayerCaches[from].new_ban(username, -1)
                infoFresh = false;
                console.log("<" + username + "> was unbanned (Timeout).")
            } else {
                console.log("Player was banned.")
                let msg = getMsg("BANNED", {});
                if (info.banReason) msg += '\n' + info.banReason;
                msg += '\n' + getMsg("BAN_UNTIL", {}) + new Date(info.banTime).toLocaleString('zh-CN', { hour12: false });
                detailReject(res, detail, "BANNED", msg);
                return;
            }
        }
    }
    let api = info ? lookupApi(info.from) : null;

    let pushedFrom = pushSourceFor(profile_name);
    if (pushedFrom != null) {
        api = lookupApi(pushedFrom);
    } else {
        // info 可能为 false（档案不存在）：此前这里会直接抛异常，登录请求挂起
        if (info && info.lastLogin) {
            let lastLoginTime = parseInt(info.lastLogin);
            if (!isNaN(lastLoginTime)) {
                if (new Date().getTime() - lastLoginTime < loginCooldownTime) {
                    log(`[COOLDOWN] ${username} login too fast. (Cooldown)`)
                    detailReject(res, detail, "LOGIN_TOO_FAST", getMsg("LOGIN_TOO_FAST", {}));
                    return;
                }
            }
        }
    }
    if (api == null) {
        log("Looking up for " + profile_name + " but not found. Try to search for it.");
        pending_players[profile_name] = true;
        let newH = JSON.parse(JSON.stringify(handle.handles))
        try {
            fetchPlayerInfo_step(buildHasJoinedQuery(username, serverId, ip), newH, res, username, from, detail);
        } catch (e) {
            // 同步异常也要释放标记，否则该玩家会被永久拦截
            delete pending_players[profile_name];
            throw e;
        }
    } else {
        if (handle.handles.includes(api.id)) {
            if (api.id == 'original') {
                fetchWithTimeout('https://sessionserver.mojang.com/session/minecraft/hasJoined' + buildHasJoinedQuery(username, serverId, ip)).then(data => {
                    if (data.status == 204) {
                        console.log(`<${username}> was not found.`);
                        detailReject(res, detail, "VERIFY_FAILED", getMsg("VERIFY_FAILED", { name: api.name }));
                        throw "NOT_FOUND";
                    }
                    res.status(data.status);
                    return data.json()
                }
                ).then(data => {
                    log('[JOIN][' + handle.name + '] <' + username + "> was allowed to join from <" + api.name + ">");
                    if (!info) {
                        trySavePlayer(username, api, data, res, from, detail);
                    } else {
                        PlayerCaches[from].new_login(username, new Date().getTime(), ip, infoFresh ? info : null);
                        res.send(data).end();
                    }
                    // 
                }).catch(e => {
                    if (e !== "NOT_FOUND") {
                        console.error(e);
                        detailReject(res, detail, "FETCH_ERROR", getMsg("FETCH_ERROR", {}));
                    }
                })

            } else {
                fetchWithTimeout(api.root + '/sessionserver/session/minecraft/hasJoined' + buildHasJoinedQuery(username, serverId, ip)).then(data => {
                    if (data.status == 204) {
                        console.log(`<${username}> was not found.`);
                        detailReject(res, detail, "VERIFY_FAILED", getMsg("VERIFY_FAILED", { name: api.name }));
                        throw "NOT_FOUND";
                    }
                    res.status(data.status);
                    return data.json()
                }).then(data => {
                    log('[JOIN][' + handle.name + '] <' + username + "> was allowed to join from <" + api.name + ">");
                    if (!info) {
                        trySavePlayer(username, api, data, res, from, detail);
                    } else {
                        PlayerCaches[from].new_login(username, new Date().getTime(), ip, infoFresh ? info : null);
                        res.send(data).end();
                    }
                    // res.send(data).end();
                }).catch(e => {
                    if (e !== "NOT_FOUND") {
                        console.error(e);
                        detailReject(res, detail, "FETCH_ERROR", getMsg("FETCH_ERROR", {}));
                    }
                })
            }
        } else {
            console.log("The player used unsupported skin site <" + api.name + ">")
            detailReject(res, detail, "UNSUPPORTED_SKIN_SITE", getMsg("UNSUPPORTED_SKIN_SITE", {}));
        }

    }
}
function searchnameForUUID(uuid, from) {
    return PlayerCaches[from].lookup_uuid(uuid);
}
function urlHandle_profiles(req, res, from) {
    // console.log('404 handler..')
    // console.log(req.url);
    let handle = HANDLES[from];
    let url = req.url;

    // 分离查询串(如 ?unsigned=false)：uuid1 与 url 都必须是干净路径段，
    // 查询参数原样保留并在拼上游地址时追加，避免查询串污染路径段导致上游返回 400
    let query = "";
    let qIndex = url.indexOf("?");
    if (qIndex != -1) {
        query = url.substring(qIndex);
        url = url.substring(0, qIndex);
    }
    url = url.substring(url.lastIndexOf("/") + 1)
    let uuid1 = url;
    let profile_name = null;
    if (req.url.indexOf("/name/") != -1) {
        profile_name = url;
        url = null;
    } else {
        profile_name = searchnameForUUID(uuid1, from);
    }


    let info, api;
    if (!checkName(profile_name)) {
        if (profile_name != null) {
            log("[PROFILE] Looking up for " + uuid1 + " but check username (" + profile_name + ") failed.");
        } else {
            log("[PROFILE] Looking up for " + uuid1 + " but can't find it in cache.");
        }
        // res.status(204).end();
        api = lookupApi(DefaultSKINSITE);
    } else {
        info = PlayerCaches[from].lookup(profile_name);
        // 走内存索引找到名字、但档案文件已被删除时 lookup 返回 false，此前会抛异常
        api = info ? lookupApi(info.from) : null;
        if (info && info.uuid != null) {
            url = info.uuid;
        }
    }
    let pushedFrom = pushSourceFor(profile_name);
    if (pushedFrom != null) {
        api = lookupApi(pushedFrom);
        // push 表里写了不存在的来源 id：退回到默认来源，否则下面 api.name 会空指针 500
        if (api == null) {
            log("[PROFILE][WARN] Unknown api id <" + pushedFrom + "> in push config, falling back to <" + DefaultSKINSITE + ">.");
            api = lookupApi(DefaultSKINSITE);
        }
    } else if (api == null) {
        log("[PROFILE] Looking up for " + profile_name + " but not found.");
        // res.status(204).end();
        // return;
        api = lookupApi(DefaultSKINSITE);
        if (api == null) {
            res.status(200).send({
                "error": "ForbiddenOperationException",
                "errorMessage": "这位玩家可能还没有登录过服务器",
                "cause": ""
            }).end();
            return;
        }
    }
    // 按名字查询但来源仍为空（默认来源也没在 apis 里配置）：按"还没登录过服务器"处理，
    // 否则下面分支会访问 api.name / api.id 抛空指针导致 500
    if (api == null && profile_name != null) {
        log("[PROFILE] No available source for <" + profile_name + "> (check apis / default config).");
        res.status(200).send({
            "error": "ForbiddenOperationException",
            "errorMessage": "这位玩家可能还没有登录过服务器",
            "cause": ""
        }).end();
        return;
    }
    if (profile_name == null) {
        log("[PROFILE] Looking up for " + url + " from <Original>");
        {
            fetchWithTimeout("https://sessionserver.mojang.com/session/minecraft/profile/" + encodeURIComponent(url) + query).then(data => {
                res.status(data.status);
                return data.text()
            }).then(data => {
                res.send(data).end();
            }).catch(e => {
                console.error(e);
                res.status(204).end();
            })
        }

    } else {
        if (url == null) {
            log("[PROFILE] Looking up for " + profile_name + " from <" + api.name + ">");
            if (api.id == 'original') {
                fetchWithTimeout("https://api.minecraftservices.com/minecraft/profile/lookup/name/" + encodeURIComponent(profile_name)).then(data => {
                    res.status(data.status);
                    return data.text()
                }).then(data => {
                    res.send(data).end();
                }).catch(e => {
                    console.error(e);
                    res.status(204).end();
                })
            } else {
                // yggdrasil 站点按名字取 profile：POST /api/profiles/minecraft，命中则回传数组首个元素
                fetchWithTimeout(api.root + "/api/profiles/minecraft", {
                    body: JSON.stringify([profile_name]),
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }).then(data => {
                    res.status(data.status);
                    return data.text()
                }).then(dat => {
                    let arr = null;
                    try { arr = JSON.parse(dat); } catch (e) { }
                    if (Array.isArray(arr) && arr.length > 0) {
                        res.send(JSON.stringify(arr[0])).end();
                    } else {
                        res.status(204).end();
                    }
                }).catch(e => {
                    console.error(e);
                    res.status(204).end();
                })
            }
            return;
        }
        log("[PROFILE] Looking up for " + profile_name + "(" + url + ") from <" + api.name + ">");

        if (api.id == 'original') {
            fetchWithTimeout("https://sessionserver.mojang.com/session/minecraft/profile/" + encodeURIComponent(url) + query).then(data => {
                res.status(data.status);
                return data.text()
            }).then(data => {
                res.send(data).end();
            }).catch(e => {
                console.error(e);
                res.status(204).end();
            })

        } else {
            fetchWithTimeout(api.root + "/sessionserver/session/minecraft/profile/" + encodeURIComponent(url) + query).then(data => {
                res.status(data.status);
                return data.text()
            }
            ).then(data => {
                res.send(data).end();
            }).catch(e => {
                console.error(e);
                res.status(204).end();
            })
        }
    }
}
function lookupApi(apiname) {
    for (let i = 0; i < URL_APIS.length; i++) {
        if (URL_APIS[i].id == apiname) {
            return URL_APIS[i];
        };
    }
    return null;
}
/* ==================== 上游档案 / 贴图 解析 ==================== */
// 统一的档案响应读取：限制体积并解析 JSON；204/非 2xx 视为"无档案"
async function readProfileJson(resp) {
    try {
        if (!resp || !resp.ok) return null;
        let declared = parseInt(resp.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) return null;
        let text = await resp.text();
        if (!text || text.length > 2 * 1024 * 1024) return null;
        let data = JSON.parse(text);
        return (data && typeof data === 'object') ? data : null;
    } catch (e) {
        return null;
    }
}
// 从某个来源按 uuid 取档案（官方走 Mojang 会话服务）
async function fetchProfileByUuid(api, uuid) {
    if (!api || uuid == null || uuid === '') return null;
    let target = normalizeUUID(uuid);
    try {
        if (api.id === 'original') {
            let r = await fetchWithTimeout('https://sessionserver.mojang.com/session/minecraft/profile/' + encodeURIComponent(target));
            return await readProfileJson(r);
        }
        if (!api.root) return null;
        let r = await fetchWithTimeout(api.root + '/sessionserver/session/minecraft/profile/' + encodeURIComponent(target));
        return await readProfileJson(r);
    } catch (e) {
        console.error(e);
        return null;
    }
}
// 账号当前名字（未改名返回同名，账号不存在返回 null）
async function getNameForUuid(api, uuid) {
    if (!api) return null;
    let data = await fetchProfileByUuid(api, uuid);
    if (!data) return null;
    let name = data.name;
    return (typeof name === 'string' && name !== '') ? name : null;
}
// 带状态区分地查询 uuid 的当前名字：found（拿到名字）/ missing（上游明确无此账号）/ failed（查询失败）
async function probeNameForUuid(api, uuid) {
    if (!api) return { status: "failed" };
    let target = normalizeUUID(uuid);
    if (target == null) return { status: "missing" };
    try {
        let resp;
        if (api.id === 'original') {
            resp = await fetchWithTimeout('https://sessionserver.mojang.com/session/minecraft/profile/' + encodeURIComponent(target));
        } else if (api.root) {
            resp = await fetchWithTimeout(api.root + '/sessionserver/session/minecraft/profile/' + encodeURIComponent(target));
        } else {
            return { status: "failed" };
        }
        if (resp.status === 204 || resp.status === 404) return { status: "missing" };
        if (!resp.ok) return { status: "failed" };
        let declared = parseInt(resp.headers.get('content-length'));
        if (Number.isFinite(declared) && declared > 2 * 1024 * 1024) return { status: "failed" };
        let text = await resp.text();
        if (!text || text.length > 2 * 1024 * 1024) return { status: "failed" };
        let data = JSON.parse(text);
        let name = data && data.name;
        if (typeof name === 'string' && name !== '') return { status: "found", name: name };
        return { status: "missing" };
    } catch (e) {
        console.error(e);
        return { status: "failed" };
    }
}
// 从某个来源按名字取档案（非官方 yggdrasil 走 /api/profiles/minecraft）
async function fetchProfileByName(api, name) {
    if (!api || name == null || name === '') return null;
    try {
        if (api.id === 'original') {
            let r = await fetchWithTimeout('https://api.mojang.com/users/profiles/minecraft/' + encodeURIComponent(name));
            let data = await readProfileJson(r);
            if (!data || !data.id) return null;
            return { id: data.id, name: data.name };
        }
        if (!api.root) return null;
        let r = await fetchWithTimeout(api.root + '/api/profiles/minecraft', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([name])
        });
        let data = await readProfileJson(r);
        if (Array.isArray(data)) return data.length > 0 ? data[0] : null;
        if (data && data.id) return data;
        return null;
    } catch (e) {
        console.error(e);
        return null;
    }
}
// 短 TTL 档案缓存：管理端反复查询同一玩家时不重复打上游
const profile_cache = new Map();
const PROFILE_CACHE_TTL = 60 * 1000;
function getCachedProfile(key) {
    let item = profile_cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expire) {
        profile_cache.delete(key);
        return null;
    }
    return item.value;
}
function setCachedProfile(key, value) {
    if (profile_cache.size > 500) {
        let now = Date.now();
        for (let [k, v] of profile_cache) {
            if (now > v.expire) profile_cache.delete(k);
        }
    }
    profile_cache.set(key, { value: value, expire: Date.now() + PROFILE_CACHE_TTL });
}
// 管理端：按名字或 uuid 解析玩家真实信息
// 来源顺序：显式指定的 from → push 表 → 本地档案记录的来源 → 子配置 handles 顺序
// 查询形态：跟随用户输入（输入 UUID 就按 UUID 查；输入名字就按名字查）
async function resolvePlayerInfo(cache, handle, query, fromOverride) {
    let info = null;
    let uuidQuery = isUUIDLike(query) ? normalizeUUID(query) : null;
    // 本地档案里的 uuid 只作为"名字查不到时的兜底"（例如玩家已改名），
    // 不再用来决定查询形态：那个 uuid 往往只有档案记录的来源认识，
    // 拿它去问其它来源（尤其是用户显式选定的来源）必然查不到，
    // 结果就变成了"无论选哪个来源，最后都回到缓存记录的来源"。
    let cachedUuid = null;
    if (uuidQuery) {
        let name = cache.lookup_uuid(uuidQuery);
        if (name) info = cache.lookup(name);
    } else {
        info = cache.lookup(query);
        if (info && info.uuid) cachedUuid = normalizeUUID(info.uuid);
    }
    let preferred = null;
    if (fromOverride) {
        preferred = lookupApi(fromOverride);
        if (!preferred) return { error: "SOURCE_UNSUPPORTED", message: "未知来源: " + fromOverride };
    } else if (info && info.from) {
        preferred = lookupApi(info.from);
    }
    let chain = [];
    let candidates = [];
    if (preferred) candidates.push(preferred);
    let pushedSourceId = info ? pushSourceFor(info.name) : null;
    if (pushedSourceId != null) {
        let pushed = lookupApi(pushedSourceId);
        if (pushed) candidates.push(pushed);
    }
    for (let id of (handle.handles || [])) {
        let api = lookupApi(id);
        if (api) candidates.push(api);
    }
    let seen = newDict();
    let list = [];
    for (let api of candidates) {
        if (!api || seen[api.id]) continue;
        seen[api.id] = true;
        list.push(api);
    }
    let profile = null;
    let resolvedFrom = null;
    let resolvedVia = null;
    // 按 name/uuid 走一遍全部候选来源，命中即停
    async function lookupPass(via, target) {
        for (let api of list) {
            let cacheKey = (via === 'uuid' ? 'u:' : 'n:') + api.id + ':' + String(target).toLowerCase();
            let got = getCachedProfile(cacheKey);
            if (got === null) {
                got = via === 'uuid' ? await fetchProfileByUuid(api, target) : await fetchProfileByName(api, target);
                setCachedProfile(cacheKey, got);
            }
            chain.push({ from: api.id, fromName: api.name, found: !!got, via: via });
            if (got) return { profile: got, from: api.id, via: via };
        }
        return null;
    }
    let hit = await lookupPass(uuidQuery ? 'uuid' : 'name', uuidQuery || query);
    if (!hit && !uuidQuery && cachedUuid) {
        // 名字在任何来源都没命中：再用本地档案记录的 uuid 试一次，兼容"玩家已改名"的情况
        hit = await lookupPass('uuid', cachedUuid);
    }
    if (hit) {
        profile = hit.profile;
        resolvedFrom = hit.from;
        resolvedVia = hit.via;
    }
    if (!profile) {
        return {
            error: "PLAYER_NOT_FOUND",
            message: "未在任何已配置来源查询到该玩家",
            lookupChain: chain
        };
    }
    let finalName = (typeof profile.name === 'string' && profile.name !== '') ? profile.name : (info ? info.name : query);
    let finalUUID = profile.id ? normalizeUUID(profile.id) : uuidQuery;
    // 档案可能缺 textures（如 /api/profiles/minecraft 的返回值），补取一次完整档案
    let textureSource = profile;
    if (!extractTextureInfo(textureSource) && finalUUID) {
        let api = lookupApi(resolvedFrom);
        let cacheKey = 'u:' + resolvedFrom + ':' + finalUUID;
        let full = getCachedProfile(cacheKey);
        if (full === null) {
            full = await fetchProfileByUuid(api, finalUUID);
            setCachedProfile(cacheKey, full);
        }
        if (full) textureSource = full;
    }
    let textures = extractTextureInfo(textureSource);
    // 贴图地址改写：启用反代时改成同源地址（WebGL 预览与 <img> 都不受跨站限制）；
    // 关闭反代时保留直链，平面图片仍可显示，但 3D 预览停用（见 preview3d）
    if (textures) {
        textures = JSON.parse(JSON.stringify(textures));
        if (skinProxyEnabled) {
            if (textures.skin) textures.skin.proxyUrl = skinUrlTransform(textures.skin.url);
            if (textures.cape) textures.cape.proxyUrl = skinUrlTransform(textures.cape.url);
        }
    }
    if (!info && finalName) info = cache.lookup(finalName);
    let history = finalName ? cache.name_history(finalName) : null;
    let warnings = [];
    if (resolvedVia === 'uuid' && !uuidQuery) {
        warnings.push("按名字未在任何来源命中，已改用本地档案记录的 UUID 查询（该玩家可能已改名）");
    }
    if (!textures) {
        warnings.push("该来源未提供贴图信息（textures），无法渲染皮肤/披风");
    } else if (!skinProxyEnabled) {
        warnings.push("皮肤贴图反代已关闭（配置 skin_proxy: false）：3D 预览已停用，仅显示平面贴图");
    }
    return {
        query: query,
        name: finalName,
        uuid: finalUUID,
        queryVia: uuidQuery ? 'uuid' : 'name',
        resolvedVia: resolvedVia,
        resolvedFrom: resolvedFrom,
        fromName: lookupApi(resolvedFrom) ? lookupApi(resolvedFrom).name : resolvedFrom,
        profileFrom: info ? info.from : null,
        cache: info ? {
            name: info.name,
            uuid: info.uuid,
            from: info.from,
            ban: info.ban === true,
            banTime: info.banTime,
            banReason: info.banReason,
            lastLogin: info.lastLogin,
            ip: info.ip,
            old_names: Array.isArray(info['old_names']) ? info['old_names'] : []
        } : null,
        textures: textures,
        history: history,
        lookupChain: chain,
        skinProxy: skinProxyEnabled,
        preview3d: skinProxyEnabled && textures != null,
        allowedImgHosts: avatarAllowedHosts(),
        warnings: warnings
    };
}
function urlHandle_profiles_post(req, res, from) {
    // console.log('404 handler..')
    // console.log(req.url);
    let body = readBodyAccumulator(req, res);
    let handle = HANDLES[from];
    req.on('end', () => {
        try {
            let bdy = JSON.parse(body.value);
            // 协议只接受"最多一个名字"的数组；非数组/空数组按"没有这个玩家"处理，
            // 避免 undefined 之类的值被透传到上游查询
            if (!Array.isArray(bdy) || bdy.length <= 0 || typeof bdy[0] !== 'string' || bdy[0] === '') {
                res.status(204).end();
                return;
            }
            if (bdy.length > 1) {
                res.status(403).send({
                    "error": "ForbiddenOperationException",
                    "errorMessage": "",
                    "cause": ""
                }).end();
                return;
            }
            let queryName = bdy[0];
            {
                let info = PlayerCaches[from].lookup(queryName);
                let api = info ? lookupApi(info.from) : null;
                let pushedSourceId = pushSourceFor(queryName);
                if (pushedSourceId != null) {
                    api = lookupApi(pushedSourceId);
                } else if (api == null) {
                    log("[PROFILE][POST] Looking up <" + queryName + "> but not found.")
                    api = lookupApi(DefaultSKINSITE);
                    if (api == null) {
                        res.status(200).send({
                            "error": "ForbiddenOperationException",
                            "errorMessage": "这位玩家可能还没有登录过服务器",
                            "cause": ""
                        }).end();
                        return;
                    }

                }
                log("[PROFILE][POST] Looking up <" + queryName + "> from <" + api.name + ">")
                if (api.id == 'original') {
                    fetchWithTimeout("https://api.minecraftservices.com/minecraft/profile/lookup/bulk/byname", {
                        body: JSON.stringify([queryName]),
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }).then(data => {
                        res.status(data.status);
                        return data.text()
                    }).then(dat => {
                        res.send(dat).end();
                    }).catch(e => {
                        console.error(e);
                        res.status(204).end();
                    })

                } else {
                    // console.log(api.root + "/api/profiles/minecraft")
                    // 发给上游的必须是 JSON 文本，早前这里传的是请求体累加器对象，上游只会收到 "[object Object]"
                    fetchWithTimeout(api.root + "/api/profiles/minecraft", {
                        body: JSON.stringify([queryName]),
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }).then(data => {
                        res.status(data.status);
                        return data.text()
                    })
                        .then(dat => {
                            res.send(dat).end();
                        }).catch(e => {
                            console.error(e);
                            res.status(204).end();
                        });
                }
            }
        } catch (e) {
            console.error(e);
            res.status(204).send({
                "error": "ForbiddenOperationException",
                "errorMessage": "",
                "cause": ""
            }).end();
        }
        // 处理请求内容
    });
}

// 统一封禁动作：time 0=永久、-1=解封、正整数=毫秒时长
function applyBan(cache, playerName, time, reason) {
    let t = parseInt(time);
    if (t === 0) return { ok: cache.new_ban(playerName, 0, reason), desc: '永久封禁' };
    if (t === -1) return { ok: cache.new_ban(playerName, -1), desc: '解除封禁' };
    return { ok: cache.new_ban(playerName, t, reason), desc: '临时封禁 ' + t + 'ms' };
}
// 管理面板封禁/解封（走登录会话，面板不再调用对外的 /ban/* 接口）
// body 可选：{ reason, type: 'name' | 'uuid' }，不传 type 时按目标形态自动识别
// 用户名冲突清单（面板"用户名冲突"页）：名字既是在用档案的当前名，又被另一个档案记为曾用名。
// 只读内存索引、不读盘、不访问上游；**仅供查看，不提供修复动作**（是否清理由人工决定）。
function urlHandle_manage_alias_conflicts(req, res, from) {
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            JSON.parse(body.value);
            let conflicts = PlayerCaches[from].aliasConflicts();
            res.send({ "success": true, "count": conflicts.length, "conflicts": conflicts }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}
function urlHandle_manage_ban(req, res, from) {
    let target = String(req.params.target == null ? '' : req.params.target).trim();
    let time = parseInt(req.params.time);
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = {};
            if (body.value) {
                try { data = JSON.parse(body.value) || {}; } catch (e) { data = {}; }
            }
            if (target === '') {
                res.status(400).send({ "error": "Missing player name or uuid" }).end();
                return;
            }
            if (!Number.isFinite(time)) {
                res.status(400).send({ "error": "Invalid time" }).end();
                return;
            }
            let kind = (data.type === 'uuid' || data.type === 'name') ? data.type : 'auto';
            let cache = PlayerCaches[from];
            let playerName = null;
            if (kind === 'uuid' || (kind === 'auto' && isUUIDLike(target))) {
                playerName = cache.lookup_uuid(target);
            } else if (checkName(target)) {
                playerName = target;
            } else {
                res.status(400).send({ "error": "Invalid player name or uuid" }).end();
                return;
            }
            if (!playerName || !cache.lookup(playerName)) {
                res.status(404).send({
                    "error": "该子配置的缓存中没有这个玩家（只查询当前子配置的 cache 目录）",
                    "cause": "PLAYER_NOT_FOUND"
                }).end();
                return;
            }
            let reason = (typeof data.reason === 'string' && data.reason.trim() !== '') ? data.reason.trim() : null;
            let r = applyBan(cache, playerName, time, reason);
            if (!r.ok) {
                res.status(500).send({ "error": "Failed to apply ban" }).end();
                return;
            }
            log(`[MANAGE] ${r.desc} <${playerName}>${playerName === target ? '' : ' (' + target + ')'}`);
            res.send({ "success": true, "player": playerName, "time": time, "desc": r.desc }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}
function urlHandle_ban_uuid(req, res, from) {
    let uuid = req.params.uuid;
    let time = parseInt(req.params.time);
    let handle = HANDLES[from];
    let secret = handle.secret;

    if (!secret) {
        res.status(403).send({ "error": "Secret key not configured for this endpoint" }).end();
        return;
    }

    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = JSON.parse(body.value);
            if (!safeSecretEqual(data.secret, secret)) {
                res.status(403).send({ "error": "Invalid secret key" }).end();
                return;
            }

            let playerName = PlayerCaches[from].lookup_uuid(uuid);
            if (!playerName) {
                res.status(404).send({ "error": "Player not found" }).end();
                return;
            }

            let reason = (typeof data.reason === 'string' && data.reason.trim() !== '') ? data.reason.trim() : null;
            let result;
            if (time === 0) {
                result = PlayerCaches[from].new_ban(playerName, 0, reason);
                log(`[BAN API] Permanently banned <${playerName}> (UUID: ${uuid})`);
            } else if (time === -1) {
                result = PlayerCaches[from].new_ban(playerName, -1);
                log(`[BAN API] Unbanned <${playerName}> (UUID: ${uuid})`);
            } else {
                result = PlayerCaches[from].new_ban(playerName, time, reason);
                log(`[BAN API] Temporarily banned <${playerName}> (UUID: ${uuid}) for ${time}ms`);
            }

            if (result) {
                res.send({ "success": true, "player": playerName, "uuid": uuid }).end();
            } else {
                res.status(500).send({ "error": "Failed to apply ban" }).end();
            }
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_ban_name(req, res, from) {
    let playerName = req.params.name;
    let time = parseInt(req.params.time);
    let handle = HANDLES[from];
    let secret = handle.secret;

    if (!secret) {
        res.status(403).send({ "error": "Secret key not configured for this endpoint" }).end();
        return;
    }

    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = JSON.parse(body.value);
            if (!safeSecretEqual(data.secret, secret)) {
                res.status(403).send({ "error": "Invalid secret key" }).end();
                return;
            }

            if (!checkName(playerName)) {
                res.status(400).send({ "error": "Invalid player name" }).end();
                return;
            }

            let reason = (typeof data.reason === 'string' && data.reason.trim() !== '') ? data.reason.trim() : null;
            let result;
            if (time === 0) {
                result = PlayerCaches[from].new_ban(playerName, 0, reason);
                log(`[BAN API] Permanently banned <${playerName}>`);
            } else if (time === -1) {
                result = PlayerCaches[from].new_ban(playerName, -1);
                log(`[BAN API] Unbanned <${playerName}>`);
            } else {
                result = PlayerCaches[from].new_ban(playerName, time, reason);
                log(`[BAN API] Temporarily banned <${playerName}> for ${time}ms`);
            }

            if (result) {
                res.send({ "success": true, "player": playerName }).end();
            } else {
                res.status(404).send({ "error": "Player not found in cache" }).end();
            }
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

/* ==================== 管理面板 API ====================
 * 这一组 handler 只做业务处理：鉴权统一交给路由上的 requireManageSession(url)——
 * 必须已登录，且会话绑定的子配置与接口所属子配置一致。
 * 因此这里不再校验请求体里的 secret（密钥只用于登录，以及对外的 /ban/* 机器接口）。
 */
function urlHandle_manage_query(req, res, from) {
    let playerName = req.params.player;
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            // 鉴权已由路由门禁完成，Handler 内不再需要请求体字段；
            // 这里只保留格式校验与体积限制（非法 JSON / 超大请求体一律拒绝）
            JSON.parse(body.value);

            // 本地缓存按"名称"存文件，认不出 UUID：直接说清楚，免得像"这个玩家不存在"那样误导
            if (isUUIDLike(playerName)) {
                res.status(400).send({
                    "error": "本地缓存查询只支持玩家名，不支持 UUID",
                    "cause": "UUID_NOT_SUPPORTED",
                    "hint": "按 UUID 查请用「远程信息」（/manage/player-info）或「UUID 互转换」"
                }).end();
                return;
            }
            if (!checkName(playerName)) {
                res.status(400).send({ "error": "Invalid player name" }).end();
                return;
            }

            let playerData = PlayerCaches[from].lookup(playerName);
            if (!playerData) {
                // 说清"只是这个子配置的缓存里没有"：不同子配置用各自的 cache 目录，
                // 玩家可能存在于其它子配置（或从未登录过），避免被误认为接口异常
                res.status(404).send({
                    "error": "该子配置的缓存中没有这个玩家（只查询当前子配置的 cache 目录）",
                    "cause": "PLAYER_NOT_FOUND"
                }).end();
                return;
            }

            res.send({ "success": true, "data": playerData }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_list(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = JSON.parse(body.value);

            // 分页/搜索/排序参数（可选）；不传 pageSize 时返回全部（向后兼容）
            let page = parseInt(data.page) || 1;
            let pageSize = parseInt(data.pageSize) || 0;
            let search = (typeof data.search === 'string') ? data.search : '';
            let field = ['name', 'uuid', 'from', 'oldname', 'all'].includes(data.field) ? data.field : 'all';
            let sort = ['name', 'uuid', 'from', 'lastLogin'].includes(data.sort) ? data.sort : 'name';
            let dir = parseInt(data.dir) || 1;

            let r = PlayerCaches[from].list_players_page({ page, pageSize, search, field, sort, dir });
            res.send({ "success": true, "players": r.players, "total": r.total, "count": r.total, "page": page, "pageSize": pageSize }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_stats(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            // 鉴权已由路由门禁完成，Handler 内不再需要请求体字段；
            // 这里只保留格式校验与体积限制（非法 JSON / 超大请求体一律拒绝）
            JSON.parse(body.value);

            let s = PlayerCaches[from].stats();
            res.send({ "success": true, ...s }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_export(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            // 鉴权已由路由门禁完成，Handler 内不再需要请求体字段；
            // 这里只保留格式校验与体积限制（非法 JSON / 超大请求体一律拒绝）
            JSON.parse(body.value);

            let players = PlayerCaches[from].export_players();
            res.send({ "success": true, "players": players, "count": players.length }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_bans(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            // 鉴权已由路由门禁完成，Handler 内不再需要请求体字段；
            // 这里只保留格式校验与体积限制（非法 JSON / 超大请求体一律拒绝）
            JSON.parse(body.value);

            let players = PlayerCaches[from].list_banned_players();
            res.send({ "success": true, "players": players, "count": players.length }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_modify(req, res, from) {
    let playerName = req.params.player;
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = JSON.parse(body.value);

            if (!checkName(playerName)) {
                res.status(400).send({ "error": "Invalid player name" }).end();
                return;
            }

            if (!data.playerData) {
                res.status(400).send({ "error": "Missing playerData field" }).end();
                return;
            }

            let result = PlayerCaches[from].modify(playerName, data.playerData);
            if (result) {
                log(`[MANAGE] Modified player data for <${playerName}>`);
                res.send({ "success": true, "player": playerName }).end();
            } else {
                res.status(404).send({ "error": "Player not found in cache" }).end();
            }
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_delete(req, res, from) {
    let playerName = req.params.player;
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            // 鉴权已由路由门禁完成，Handler 内不再需要请求体字段；
            // 这里只保留格式校验与体积限制（非法 JSON / 超大请求体一律拒绝）
            JSON.parse(body.value);

            if (!checkName(playerName)) {
                res.status(400).send({ "error": "Invalid player name" }).end();
                return;
            }

            let result = PlayerCaches[from].delete(playerName);
            if (result) {
                log(`[MANAGE] Deleted player cache for <${playerName}>`);
                res.send({ "success": true, "player": playerName }).end();
            } else {
                res.status(404).send({ "error": "Player not found in cache" }).end();
            }
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}
function urlHandle_manage_player_info(req, res, from) {
    let query = req.params.query;
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = {};
            if (body.value) {
                try { data = JSON.parse(body.value) || {}; } catch (e) { data = {}; }
            }
            let q = String(query == null ? '' : query).trim();
            if (q === '') {
                res.status(400).send({ "error": "Missing player name or uuid" }).end();
                return;
            }
            resolvePlayerInfo(PlayerCaches[from], handle, q, data.from || null).then(r => {
                if (r.error) {
                    res.status(r.error === "PLAYER_NOT_FOUND" ? 404 : 400).send(Object.assign({ "success": false }, r)).end();
                    return;
                }
                res.send(Object.assign({ "success": true }, r)).end();
            }).catch(e => {
                console.error(e);
                res.status(500).send({ "error": "Failed to resolve player info" }).end();
            });
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

// 曾用名检索（改名搜索追踪）：命中曾用名时返回对应档案
function urlHandle_manage_names(req, res, from) {
    let query = req.params.query;
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = {};
            if (body.value) {
                try { data = JSON.parse(body.value) || {}; } catch (e) { data = {}; }
            }
            let name = String(query == null ? '' : query).trim();
            if (!checkName(name)) {
                res.status(400).send({ "error": "Invalid player name" }).end();
                return;
            }
            let cache = PlayerCaches[from];
            let matched = cache.lookup_oldname(name);
            let matches = matched.map(n => {
                let h = cache.name_history(n);
                if (h) h.records = cache.lookup(n) || null;
                return h;
            }).filter(h => h != null);
            // 该名字本身是否也是个在用档案（"当前正在使用"），与曾用名命中并列返回
            let current = cache.name_history(name);
            if (current) current.records = cache.lookup(name) || null;
            let note;
            if (matches.length > 0 && current) note = "该名字既是以下档案的曾用名，也正在被另一个账号使用";
            else if (matches.length > 0) note = "该名字是以下玩家的曾用名";
            else if (current) note = "没有玩家以该名字作为曾用名，但该名字当前正被使用";
            else note = "没有玩家以该名字作为曾用名，当前也没有账号使用该名字";
            res.send({
                "success": true,
                "query": name,
                "matched": matches.length > 0,
                "matches": matches,
                "currentNameOwner": current,
                "note": note
            }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

// 贴图元信息（不作为图片代理）：管理端按返回的直链在浏览器侧渲染
function urlHandle_manage_avatar(req, res, from) {
    let query = req.params.query;
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = {};
            if (body.value) {
                try { data = JSON.parse(body.value) || {}; } catch (e) { data = {}; }
            }
            let name = String(query == null ? '' : query).trim();
            if (!checkName(name)) {
                res.status(400).send({ "error": "Invalid player name" }).end();
                return;
            }
            let cache = PlayerCaches[from];
            let info = cache.lookup(name);
            if (!info) {
                res.status(404).send({ "error": "Player not found in cache" }).end();
                return;
            }
            let textures = extractTextureInfo(info);
            res.send({
                "success": true,
                "name": info.name == null ? name : info.name,
                "uuid": info.uuid == null ? null : info.uuid,
                "textures": textures,
                "allowedImgSrc": avatarImgSrc(),
                "allowedImgHosts": avatarAllowedHosts()
            }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_rebuild_uuid(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            // 鉴权已由路由门禁完成，Handler 内不再需要请求体字段；
            // 这里只保留格式校验与体积限制（非法 JSON / 超大请求体一律拒绝）
            JSON.parse(body.value);

            let cache = PlayerCaches[from];
            let before = Object.keys(cache.UUIDCache).length;
            let count = cache.rebuildUUIDCache(false);
            let dropped = Math.max(0, before - count);
            log(`[MANAGE] Rebuilt UUID cache table for <${handle.name || 'default'}>, current entries: ${count}, dropped: ${dropped}`);
            res.send({ "success": true, "count": count, "dropped": dropped }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

// UUID 索引体检（可修复）：报告并清理幽灵条目 / 重复 uuid / 缺失映射
function urlHandle_manage_check_uuid(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = {};
            if (body.value) {
                try { data = JSON.parse(body.value) || {}; } catch (e) { data = {}; }
            }

            let cache = PlayerCaches[from];
            // 修复前备份索引文件，便于人工回退
            if (data.fix === true) {
                let indexPath = path.join(cache.path, 'a.ud.json');
                if (fs.existsSync(indexPath)) {
                    try {
                        fs.copyFileSync(indexPath, indexPath + '.bak');
                    } catch (e) {
                        console.error(e);
                    }
                }
            }
            let r = cache.verifyUUIDCache({ fix: data.fix === true });
            log(`[MANAGE] Checked UUID index for <${handle.name || 'default'}>: stale ${r.stale.length}, duplicate ${r.duplicate.length}, missing ${r.missing.length}, repaired ${r.repaired}`);
            res.send({
                "success": true,
                "fix": data.fix === true,
                "repaired": r.repaired,
                "entries": r.entries,
                "staleCount": r.stale.length,
                "duplicateCount": r.duplicate.length,
                "missingCount": r.missing.length,
                "stale": r.stale,
                "duplicate": r.duplicate,
                "missing": r.missing,
            }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_batch_delete(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = JSON.parse(body.value);

            if (!Array.isArray(data.players) || data.players.length <= 0) {
                res.status(400).send({ "error": "Missing players array" }).end();
                return;
            }

            let deleted = [];
            let failed = [];
            for (let name of data.players) {
                if (!checkName(name)) { failed.push(name); continue; }
                if (PlayerCaches[from].delete(name)) {
                    deleted.push(name);
                    log(`[MANAGE] Deleted player cache for <${name}> (batch)`);
                } else {
                    failed.push(name);
                }
            }
            res.send({ "success": true, "deleted": deleted, "failed": failed }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_batch_unban(req, res, from) {
    let handle = HANDLES[from];
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = JSON.parse(body.value);

            if (!Array.isArray(data.players) || data.players.length <= 0) {
                res.status(400).send({ "error": "Missing players array" }).end();
                return;
            }

            let unbanned = [];
            let failed = [];
            for (let name of data.players) {
                if (!checkName(name)) { failed.push(name); continue; }
                if (PlayerCaches[from].new_ban(name, -1)) {
                    unbanned.push(name);
                    log(`[MANAGE] Unbanned <${name}> (batch)`);
                } else {
                    failed.push(name);
                }
            }
            res.send({ "success": true, "unbanned": unbanned, "failed": failed }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

// 皮肤站处理结束


app.get('/', function (req, res) {
    res.sendFile(path.join(WEB_PUBLIC_DIR, 'index.html'));
})
// 管理界面和管理API注册到 manageApp（独立管理服务器）或 app（主服务器）
let uiApp = manageApp || app;
// img-src：启用反代时贴图全部同源下发，无需放开外部域名；关闭反代时平面贴图直连上游，需按配置放开
function manageCsp() {
    let imgSrc = skinProxyEnabled ? "img-src 'self' data: blob:" : avatarImgSrc();
    return "default-src 'self' blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
        + imgSrc
        + "; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
}

// 登录门控：未登录（无有效会话 Cookie）只返回登录页，登录后才能访问管理主页面
uiApp.get(manageUrl, manageSecurityHeaders, function (req, res) {
    res.setHeader('Content-Security-Policy', manageCsp());
    let session = getAdminSession(req);
    if (!session) {
        res.sendFile(path.join(WEB_PUBLIC_DIR, 'login.html'));
        return;
    }
    res.sendFile(path.join(WEB_PUBLIC_DIR, 'manage.html'));
})
// 登录接口：校验子配置 URL + 密钥，通过后下发 httpOnly 会话 Cookie
uiApp.post(manageUrl + '/login', manageSecurityHeaders, manageLimiter, function (req, res) {
    let body = readBodyAccumulator(req, res);
    req.on('end', () => {
        try {
            let data = JSON.parse(body.value);
            let idx = HANDLES.findIndex(h => h.url === data.url);
            if (idx < 0) {
                // 登录页会原样展示这些文案，故保持可读；同时记日志便于发现试探行为
                logManageReject(req, 401, 'Login failed (unknown sub-config: ' + (data.url == null ? 'null' : String(data.url).slice(0, 64)) + ')');
                res.status(401).send({ "error": "未知的子配置" }).end();
                return;
            }
            let handle = HANDLES[idx];
            if (!handle.secret) {
                logManageReject(req, 401, `Login failed (sub-config <${handle.name || handle.url}> has no secret configured)`);
                res.status(401).send({ "error": "该子配置未配置管理密钥（secret）" }).end();
                return;
            }
            if (!safeSecretEqual(String(data.secret || ''), handle.secret)) {
                logManageReject(req, 401, `Login failed (wrong secret for <${handle.name || handle.url}>)`);
                res.status(401).send({ "error": "管理密钥错误" }).end();
                return;
            }
            let remember = data.remember === true;
            let ttlMs = remember ? 7 * 24 * 3600 * 1000 : (parseInt(globleConfig.get("manage_session_hours", 12)) || 12) * 3600 * 1000;
            let token = issueSessionToken(handle.url, ttlMs);
            // 启用 HTTPS 时附加 Secure，避免会话 Cookie 经明文 HTTP 传输被窃取
            let secureFlag = manageHttpsOptions ? '; Secure' : '';
            res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(ttlMs / 1000)}${secureFlag}`);
            log(`[LOGIN] Admin logged in for method <${handle.name || handle.url}> from ${req.ip}`);
            res.send({ "success": true, "url": handle.url, "name": handle.name || 'default' }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
})
// 登出接口：清除会话 Cookie
uiApp.post(manageUrl + '/logout', manageSecurityHeaders, function (req, res) {
    let secureFlag = manageHttpsOptions ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${ADMIN_SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureFlag}`);
    res.send({ "success": true }).end();
})
// 会话查询：供管理面板展示当前登录的子配置
uiApp.get(manageUrl + '/api/session', manageSecurityHeaders, function (req, res) {
    let session = getAdminSession(req);
    if (!session) {
        res.send({ "loggedIn": false }).end();
        return;
    }
    let idx = HANDLES.findIndex(h => h.url === session.m);
    res.send({ "loggedIn": true, "url": session.m, "name": (idx >= 0 ? (HANDLES[idx].name || 'default') : session.m) }).end();
})
// 登录页渲染子配置下拉框时必须调用，因此这个接口保持公开：只暴露子配置的 url 与名称，
// 不含任何密钥或玩家数据。
uiApp.get('/api/methods', manageSecurityHeaders, function (req, res) {
    let methods = HANDLES.map((handle, idx) => ({
        url: handle.url,
        name: handle.name || 'default'
    }));
    res.send(methods).end();
})
// 面板自用的 3D 预览脚本（three.js + skinview3d 打包产物，同源加载）
// 用 no-cache + ETag 让浏览器每次校验：升级后立即生效，未变更则 304
uiApp.get('/vendor/mcviewer.js', manageSecurityHeaders, function (req, res) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(WEB_PUBLIC_DIR, 'vendor', 'mcviewer.js'));
})
// 皮肤贴图反代：仅管理端，且必须是已登录的管理会话 + 白名单域名 + 图片
uiApp.get(manageUrl + '/skin-proxy', manageSecurityHeaders, function (req, res) {
    // 处理函数是异步的：必须兜住 Promise 拒绝，否则会变成未处理拒绝（旧版本会直接退出进程）
    handleSkinProxy(req, res).catch(e => {
        console.error(e);
        if (!res.headersSent) res.status(500).send({ "error": "Internal error" }).end();
    });
})
// 管理面板"角色信息查询"用：每个子配置可用的来源（皮肤站）列表。需要登录。
uiApp.get('/api/sources', manageSecurityHeaders, requireManageSession(null), function (req, res) {
    let all = [];
    let seenAll = Object.create(null);
    for (let api of URL_APIS) {
        if (!api || !api.id || seenAll[api.id]) continue;
        seenAll[api.id] = true;
        all.push({ id: api.id, name: api.name || api.id });
    }
    let byUrl = Object.create(null);
    for (let handle of HANDLES) {
        let list = [];
        for (let id of (handle.handles || [])) {
            let api = lookupApi(id);
            if (api) list.push({ id: api.id, name: api.name || api.id });
        }
        byUrl[handle.url] = { name: handle.name || 'default', sources: list };
    }
    res.send({ all: all, handles: byUrl }).end();
})
// 管理接口是 POST-only。浏览器直接访问（在地址栏里敲 /xxx/manage/query/名字）会走 GET，
// 若不专门处理就会落到 404 兜底并被记成 [UNKNOWN]，很容易被误判为"接口不存在"。
// 这里对管理路径的非 POST 请求给出明确的 405 与提示，且不再记录成 [UNKNOWN]。
function manageMethodHint(req, res, next) {
    if (req.method === 'POST' || req.method === 'OPTIONS') { next(); return; }
    let pathname = req.path || '';
    // 管理面板自身的路由（{manage_url}、{manage_url}/skin-proxy、{manage_url}/api/*）不是 POST-only
    if (typeof manageUrl === 'string' && manageUrl !== ''
        && (pathname === manageUrl || pathname.indexOf(manageUrl + '/') === 0)) {
        next();
        return;
    }
    let isManagePath = HANDLES.some(h => typeof h.url === 'string' && h.url !== '' && (
        pathname === h.url + '/manage' || pathname.indexOf(h.url + '/manage/') === 0 || pathname.indexOf(h.url + '/ban/') === 0));
    if (!isManagePath) { next(); return; }
    // 响应体只给标准错误；操作指引只写日志
    logManageReject(req, 405, 'Method Not Allowed (management API is POST-only; use the panel, or POST {manage_url}/login for a session cookie)');
    res.status(405).set('Allow', 'POST').send({ "error": "Method Not Allowed" }).end();
}
// 如果启用了独立管理服务器，为其添加 favicon 和 404 处理
if (manageApp) {
    manageApp.use(manageSecurityHeaders);
    manageApp.get('/', function (req, res) {
        res.sendFile(path.join(WEB_PUBLIC_DIR, 'index.html'));
    })
    manageApp.get("/favicon.ico", function (req, res) { res.end() })
    manageApp.use(manageMethodHint);
    manageApp.get('*', function (req, res) {
        log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
        res.status(404).sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
    });
    manageApp.post("*", function (req, res) {
        log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
        res.status(404).sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
    })
    manageApp.use((err, req, res, next) => {
        console.error(err.stack);
        res.type('application/json');
        res.status(500).send({ "code": 500, "msg": "Internal server error" });
    });
}
app.get("/favicon.ico", function (req, res) { res.end() })

app.use(manageMethodHint);

app.get('*', function (req, res) {
    // log('404 handler..')
    // log(req.url);
    log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
    res.status(404).sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
});

app.post("*", function (req, res) {
    log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
    res.status(404).sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
})

// HTML 处理结束
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.type('application/json');
    res.status(500).send({ "code": 500, "msg": "Internal server error" });
});


reloadConfig();
server = app.listen(port);
log(`Server is listening to ${port} port.`);
if (manageApp) {
    initManageHttps();
    listenManageServer();
    log(`Management server is listening to ${managePort} port${manageHost ? " on " + manageHost : ""}${manageHttpsOptions ? " (HTTPS)" : ""}.`);
} else {
    // 未配置 manage_port 时管理路由会挂在对外登录端口上：管理面板与 /ban API 会随登录端口一起暴露
    log("[WARN] manage_port is not set: management routes (/manage/*, /ban/*) are served on the public login port. It is recommended to set manage_port and keep manage_host at 127.0.0.1.");
}

function reloadConfig() {
    log("Loading the config ...")
    globleConfig.reload();
    PUSH_LOGINMETHOD_PLAYERS = globleConfig.get("push", { "handles": [] }).handles;
    // 图片白名单与来源表依赖配置，必须在任何 return 之前刷新
    refreshAvatarConfig();

    try {
        if (server != null)
            server.close();
        log("Restarting the server...")
    } catch (e) {
        console.log(e);
    }
    // log()
    port = globleConfig.get("port", 25600); // 8123
    managePort = globleConfig.get("manage_port", 0);
    manageHost = globleConfig.get("manage_host", "127.0.0.1");
    if (server == null) return;
    // console.log(port)
    server.listen(port);            // 在端口运行它
    // port = server.address().port;
    log(`Server is listening to ${port} port.`);
    // log(`IP: 0.0.0.0:${port}`);

    // 重启管理服务器（如已启用）
    if (manageServer != null && managePort > 0) {
        manageServer.close();
        initManageHttps();
        listenManageServer();
        log(`Management server is listening to ${managePort} port${manageHost ? " on " + manageHost : ""}${manageHttpsOptions ? " (HTTPS)" : ""}.`);
    }
    loginCooldownTime = globleConfig.get("login_cooldown", 5000);
    // Node使用'on'方法注册事件处理程序
    // 当服务器收到新请求,则运行函数处理它

    log("服务器启动成功！");
    log("重新加载服务器配置文件。")
}
// 重新读取与图片白名单相关的配置（skinDomains / apis / avatar_domains）
function refreshAvatarConfig() {
    SkinDomains = globleConfig.get("skinDomains", ["127.0.0.1"]);
    URL_APIS = globleConfig.get("apis", {});
    AvatarDomains = parseAvatarDomains(globleConfig.get("avatar_domains", []));
    // 皮肤贴图反代：默认启用（WebGL 预览要求同源/允许跨站的贴图）
    skinProxyEnabled = globleConfig.get("skin_proxy", true) !== false;
    // 配置变化会使缓存失效（CSP 头每请求重建，因此无需重启即可生效）
    avatarHostsCache = null;
    avatarImgSrcCache = null;
    let hosts = avatarAllowedHosts();
    log(`[MANAGE] 图片白名单（CSP img-src）共 ${hosts.length} 个域名: ${hosts.join(', ')}`);
    if (AvatarDomains.length > 0) {
        log(`[MANAGE] 其中来自 avatar_domains 配置: ${AvatarDomains.join(', ')}`);
    }
    log(`[MANAGE] 皮肤贴图反代: ${skinProxyEnabled ? '启用' : '关闭'}（skin_proxy）`);
}

process.on('unhandledRejection', (err) => {
    // 不能因为单个请求的未处理拒绝就退出进程：那会让所有玩家的登录一起中断。
    // 这里只记录（旧行为是 process.exit(-1)，一次畸形请求即可打掉整个登录服务）。
    console.error("[UNHANDLED_REJECTION] " + (err instanceof Error ? (err.stack || err.message) : String(err)));
});
const HELPINFO = "\n--------------------------------\nhelp - Show the help message\nstop - Stop & Exit\nreload - Reload the config file.\nban <player> <time> - ban a player\n--------------------------------";
function runCommand() {
    readline.on(`line`, name => {
        // console.log(`你好 ${name}!`)
        if (name == 'help') {
            log(HELPINFO);
        } else if (name == 'stop') {
            try {
                server.close();
                if (manageServer) manageServer.close();
            }
            catch (e) {
                console.error(e);
            }
            log("Exiting...")
            readline.close();
            process.exit(0);
            // process
        } else if (name == 'reload') {
            reloadConfig();

        } else if (name.startsWith('ban')) {
            let args = name.split(" ");
            if (args.length >= 3) {
                let player = args[1];
                let time = args[2];
                let banned = false;
                for (let idx in PlayerCaches) {
                    let res = PlayerCaches[idx].new_ban(player, parseInt(time));
                    if (res) {
                        banned = true;
                    }
                }
                if (banned) {
                    log("已封禁 " + player + "，时长：" + time + "ms，解封时间：" + new Date(new Date().getTime() + parseInt(time)))
                } else {
                    log("无法封禁 <" + player + ">，他可能没有登陆过服务器。")
                }

            } else {
                log("Unknown args: ban <player> <time(ms)>\n*<time(ms)> set to -1 to pardon him.");
            }
        } else {
            log("Unknown commands: " + name + "\nType 'help' for help.");
        }
        // console.log(" > ")
        // console.log(1);
    });
    // runCommand();

}
(async () => {
    try {
        await runCommand();
        // process.exit(0);
    } catch (e) {
        throw e;
    }
})();
