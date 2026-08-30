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
function parseCookies(req) {
    let out = {};
    let raw = req.headers.cookie;
    if (!raw) return out;
    raw.split(';').forEach(pair => {
        let i = pair.indexOf('=');
        if (i < 0) return;
        out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
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

    // Ban API endpoints
    let mApp = manageApp || app;
    mApp.post(`${url}/ban/uuid/:uuid/:time`, manageLimiter, function (req, res) { urlHandle_ban_uuid(req, res, idx) });
    mApp.post(`${url}/ban/name/:name/:time`, manageLimiter, function (req, res) { urlHandle_ban_name(req, res, idx) });

    // Management API endpoints
    mApp.post(`${url}/manage/query/:player`, manageLimiter, function (req, res) { urlHandle_manage_query(req, res, idx) });
    mApp.post(`${url}/manage/list`, manageLimiter, function (req, res) { urlHandle_manage_list(req, res, idx) });
    mApp.post(`${url}/manage/bans`, manageLimiter, function (req, res) { urlHandle_manage_bans(req, res, idx) });
    mApp.post(`${url}/manage/modify/:player`, manageLimiter, function (req, res) { urlHandle_manage_modify(req, res, idx) });
    mApp.post(`${url}/manage/delete/:player`, manageLimiter, function (req, res) { urlHandle_manage_delete(req, res, idx) });
    mApp.post(`${url}/manage/rebuild-uuid`, manageLimiter, function (req, res) { urlHandle_manage_rebuild_uuid(req, res, idx) });
    mApp.post(`${url}/manage/stats`, manageLimiter, function (req, res) { urlHandle_manage_stats(req, res, idx) });
    mApp.post(`${url}/manage/export`, manageLimiter, function (req, res) { urlHandle_manage_export(req, res, idx) });
    mApp.post(`${url}/manage/batch-delete`, manageLimiter, function (req, res) { urlHandle_manage_batch_delete(req, res, idx) });
    mApp.post(`${url}/manage/batch-unban`, manageLimiter, function (req, res) { urlHandle_manage_batch_unban(req, res, idx) });

}
// 皮肤站处理开始
var ErrorMessages = globleConfig.get("errorMessages", {});
var loginCooldownTime = globleConfig.get("login_cooldown", 5000);
function getMsg(key, vars) {
    const defaults = {
        "DUPLICATE_NAME": '该玩家名已被来自 "{from}" 的账号占用，不允许其他皮肤站的同名玩家登录',
        "DUPLICATE_UUID": '该账号的 UUID 与已有玩家 "{name}"（来自 "{from}"）冲突',
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
function trySavePlayer(player, api, response_data, res, from, detail) {
    log("[FOUND] Found <" + player + "> should come from <" + api.name + ">");
    let dat = response_data;
    // 登录时间与 ip 随 add 一次性写入缓存，不再写后再读再写
    let k = PlayerCaches[from].add(dat.name, dat.id, api.id, { lastLogin: new Date().getTime(), ip: null });
    if (k !== true) {
        if (detail && k && k.error) {
            res.status(403).send(buildDetailError(k, PlayerCaches[from], dat.name)).end();
        } else {
            res.status(204).end();
        }
    } else {
        res.send(response_data).end();
    }
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
        detailReject(res, detail, "NOT_FOUND", getMsg("NOT_FOUND", {}));
        log(`${player} not found in the remote server.`);
        try {
            delete pending_players[player];
        } catch (e) {
            log(e);
        }
        return;
    }
    let a = apis[0];
    let api = lookupApi(a);
    let b = apis;
    b.splice(0, 1);
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
const pending_players = {};
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

    if (PUSH_LOGINMETHOD_PLAYERS[profile_name] != undefined) {
        api = lookupApi(PUSH_LOGINMETHOD_PLAYERS[profile_name]);
    } else {
        if (info.lastLogin) {
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
        fetchPlayerInfo_step(buildHasJoinedQuery(username, serverId, ip), newH, res, username, from, detail);
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

    url = url.substring(url.lastIndexOf("/") + 1)
    let uuid1 = url;
    if (uuid1.endsWith("?unsigned=false")) {
        uuid1 = uuid1.substring(0, uuid1.length - "?unsigned=false".length);
    }
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
        api = lookupApi(info.from);
        if (info.uuid != null) {
            url = info.uuid;
        }
    }
    if (PUSH_LOGINMETHOD_PLAYERS[profile_name] != undefined) {
        api = lookupApi(PUSH_LOGINMETHOD_PLAYERS[profile_name]);
    } else if (api == null) {
        log("[PROFILE] Looking up for " + profile_name + " but not found.");
        // res.status(204).end();
        // return;
        api = lookupApi(DefaultSKINSITE);
        if (api == null) {
            res.send({
                "error": "ForbiddenOperationException",
                "errorMessage": "这位玩家可能还没有登录过服务器",
                "cause": ""
            }).status(204).end();
            return;
        }
    }
    if (profile_name == null) {
        log("[PROFILE] Looking up for " + url + " from <Original>");
        {
            fetchWithTimeout("https://sessionserver.mojang.com/session/minecraft/profile/" + encodeURIComponent(url)).then(data => {
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
            fetchWithTimeout("https://api.minecraftservices.com/minecraft/profile/lookup/name/" + encodeURIComponent(profile_name)).then(data => {
                res.status(data.status);
                return data.text()
            }).then(data => {
                res.send(data).end();
            }).catch(e => {
                console.error(e);
                res.status(204).end();
            })
            return;
        }
        log("[PROFILE] Looking up for " + profile_name + "(" + url + ") from <" + api.name + ">");

        if (api.id == 'original') {
            fetchWithTimeout("https://sessionserver.mojang.com/session/minecraft/profile/" + encodeURIComponent(url)).then(data => {
                res.status(data.status);
                return data.text()
            }).then(data => {
                res.send(data).end();
            }).catch(e => {
                console.error(e);
                res.status(204).end();
            })

        } else {
            fetchWithTimeout(api.root + "/sessionserver/session/minecraft/profile/" + encodeURIComponent(url)).then(data => {
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
function urlHandle_profiles_post(req, res, from) {
    // console.log('404 handler..')
    // console.log(req.url);
    let body = readBodyAccumulator(req, res);
    let handle = HANDLES[from];
    req.on('end', () => {
        try {
            let bdy = JSON.parse(body.value);
            if (bdy.length > 1) {
                res.status(403).send({
                    "error": "ForbiddenOperationException",
                    "errorMessage": "",
                    "cause": ""
                }).end();
                return;
            }
            for (let i = 0; i < 1; i++) {
                let info = PlayerCaches[from].lookup(bdy[i]);
                let api = info ? lookupApi(info.from) : null;
                if (PUSH_LOGINMETHOD_PLAYERS[bdy[i]] != undefined) {
                    api = lookupApi(PUSH_LOGINMETHOD_PLAYERS[bdy[i]]);
                } else if (api == null) {
                    log("[PROFILE][POST] Looking up <" + bdy[i] + "> but not found.")
                    api = lookupApi(DefaultSKINSITE);
                    if (api == null) {
                        res.send({
                            "error": "ForbiddenOperationException",
                            "errorMessage": "这位玩家可能还没有登录过服务器",
                            "cause": ""
                        }).status(204).end();
                        return;
                    }

                }
                log("[PROFILE][POST] Looking up <" + bdy[i] + "> from <" + api.name + ">")
                if (api.id == 'original') {
                    fetchWithTimeout("https://api.minecraftservices.com/minecraft/profile/lookup/bulk/byname", {
                        body: JSON.stringify([bdy[i]]),
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
                    fetchWithTimeout(api.root + "/api/profiles/minecraft", {
                        body: body,
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

function urlHandle_manage_query(req, res, from) {
    let playerName = req.params.player;
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

            let playerData = PlayerCaches[from].lookup(playerName);
            if (!playerData) {
                res.status(404).send({ "error": "Player not found in cache" }).end();
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

            // 分页/搜索/排序参数（可选）；不传 pageSize 时返回全部（向后兼容）
            let page = parseInt(data.page) || 1;
            let pageSize = parseInt(data.pageSize) || 0;
            let search = (typeof data.search === 'string') ? data.search : '';
            let field = ['name', 'uuid', 'from', 'all'].includes(data.field) ? data.field : 'all';
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
function urlHandle_manage_rebuild_uuid(req, res, from) {
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

            let count = PlayerCaches[from].rebuildUUIDCache(false);
            log(`[MANAGE] Rebuilt UUID cache table for <${handle.name || 'default'}>, current entries: ${count}`);
            res.send({ "success": true, "count": count }).end();
        } catch (e) {
            console.error(e);
            res.status(400).send({ "error": "Invalid request" }).end();
        }
    });
}

function urlHandle_manage_batch_delete(req, res, from) {
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
const MANAGE_CSP = "default-src 'self' blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

// 登录门控：未登录（无有效会话 Cookie）只返回登录页，登录后才能访问管理主页面
uiApp.get(manageUrl, manageSecurityHeaders, function (req, res) {
    res.setHeader('Content-Security-Policy', MANAGE_CSP);
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
                res.status(401).send({ "error": "未知的子配置" }).end();
                return;
            }
            let handle = HANDLES[idx];
            if (!handle.secret) {
                res.status(401).send({ "error": "该子配置未配置管理密钥（secret）" }).end();
                return;
            }
            if (!safeSecretEqual(String(data.secret || ''), handle.secret)) {
                log(`[LOGIN] Failed admin login attempt for <${handle.name || data.url}> from ${req.ip}`);
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
uiApp.get('/api/methods', manageSecurityHeaders, function (req, res) {
    let methods = HANDLES.map((handle, idx) => ({
        url: handle.url,
        name: handle.name || 'default'
    }));
    res.send(methods).end();
})
// 如果启用了独立管理服务器，为其添加 favicon 和 404 处理
if (manageApp) {
    manageApp.use(manageSecurityHeaders);
    manageApp.get('/', function (req, res) {
        res.sendFile(path.join(WEB_PUBLIC_DIR, 'index.html'));
    })
    manageApp.get("/favicon.ico", function (req, res) { res.end() })
    manageApp.get('*', function (req, res) {
        log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
        res.sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
    });
    manageApp.post("*", function (req, res) {
        log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
        res.sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
    })
    manageApp.use((err, req, res, next) => {
        console.error(err.stack);
        res.type('application/json');
        res.status(500).send({ "code": 500, "msg": "Internal server error" });
    });
}
app.get("/favicon.ico", function (req, res) { res.end() })

app.get('*', function (req, res) {
    // log('404 handler..')
    // log(req.url);
    log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
    res.sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
});

app.post("*", function (req, res) {
    log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
    res.sendFile(path.join(WEB_PUBLIC_DIR, '404.html'));
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
}

function reloadConfig() {
    log("Loading the config ...")
    globleConfig.reload();
    PUSH_LOGINMETHOD_PLAYERS = globleConfig.get("push", { "handles": [] }).handles;

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

process.on('unhandledRejection', (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(-1);
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
