const path = require("path");
const http = require('http');        // HTTP服务器API
const fs = require('fs');            // 文件系统API
const express = require('express');
const { class_PlayerCache, checkName } = require("./playercache.js");
const { log, globleConfig } = require('./utils.js');
var app = express();    // 创建新的HTTP服务器
var port = 0;
var server = null;
var DefaultSKINSITE = "original";

const Fetch = require("node-fetch");
// const iconv = require('iconv-lite')
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
var managePort = 0;
var manageServer = null;
// HTML 开始处理
// 注册URL
if (HANDLES == null || HANDLES.length <= 0) {
    log("[WARN] The server doesn't have any URL handles. Please check your config file.");
    process.exit(1)
    return;
}
for (let i = 0; i < HANDLES.length; i++) {
    let url = HANDLES[i].url;
    let idx = i + 0;
    let methodName = HANDLES[i].name || "default";
    let cachePath = `./cache/${methodName}`;
    PlayerCaches[idx] = new class_PlayerCache(cachePath);
    console.log("Register url path: " + url + " with cache: " + cachePath);
    app.get(url, function (req, res) { urlHandle_root(req, res, idx) });
    app.post(`${url}/api/profiles/minecraft`, function (req, res) { urlHandle_profiles_post(req, res, idx) });
    app.get(`${url}/sessionserver/session/minecraft/hasJoined`, function (req, res) { urlHandle_joinServer(req, res, idx) });
    app.post(`${url}/minecraftservices/minecraft/profile/lookup/bulk/byname`, function (req, res) { urlHandle_profiles_post(req, res, idx) });
    app.get(`${url}/sessionserver/session/minecraft/profile/*`, function (req, res) { urlHandle_profiles(req, res, idx) })
    app.get(`${url}/api/minecraft/profile/lookup/name/*`, function (req, res) { urlHandle_profiles(req, res, idx) })

    // Ban API endpoints
    let mApp = manageApp || app;
    mApp.post(`${url}/ban/uuid/:uuid/:time`, function (req, res) { urlHandle_ban_uuid(req, res, idx) });
    mApp.post(`${url}/ban/name/:name/:time`, function (req, res) { urlHandle_ban_name(req, res, idx) });

    // Management API endpoints
    mApp.post(`${url}/manage/query/:player`, function (req, res) { urlHandle_manage_query(req, res, idx) });
    mApp.post(`${url}/manage/list`, function (req, res) { urlHandle_manage_list(req, res, idx) });
    mApp.post(`${url}/manage/modify/:player`, function (req, res) { urlHandle_manage_modify(req, res, idx) });
    mApp.post(`${url}/manage/delete/:player`, function (req, res) { urlHandle_manage_delete(req, res, idx) });

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
        "LOGIN_TOO_FAST": "你的登录过快，请稍后再试"
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
    let k = PlayerCaches[from].add(dat.name, dat.id, api.id);
    if (k !== true) {
        if (detail && k && k.error) {
            res.status(403).send(buildDetailError(k, PlayerCaches[from], dat.name)).end();
        } else {
            res.status(204).end();
        }
    } else {
        res.send(response_data).end();
        PlayerCaches[from].new_login(player, new Date().getTime(), null);
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
        Fetch(`https://sessionserver.mojang.com/session/minecraft/hasJoined${args}`).then(data => {
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
        Fetch(api.root + `/sessionserver/session/minecraft/hasJoined${args}`).then(data => {
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
    log('[JOIN] <' + username + "> want to join. IP: " + ipdisplay + "");
    if (pending_players[username] === true) {
        detailReject(res, detail, "LOGIN_TOO_FAST", getMsg("LOGIN_TOO_FAST", {}));
        log(`[COOLDOWN] ${username} login too fast. (Pending)`)
        return;
    }
    let info = PlayerCaches[from].lookup(username);
    if (info) {
        if (info.ban == true) {
            if (info.banTime == 0) {
                console.log("Player was forever banned.")
                detailReject(res, detail, "BANNED_FOREVER", getMsg("BANNED_FOREVER", {}));
                return;
            }
            else if (info.banTime <= new Date().getTime()) {
                info.ban = false;
                PlayerCaches[from].new_ban(username, -1)
                console.log("<" + username + "> was unbanned (Timeout).")
            } else {
                console.log("Player was banned.")
                detailReject(res, detail, "BANNED", getMsg("BANNED", {}));
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
        console.log("Looking up for " + profile_name + " but not found. Try to search for it.");
        pending_players[profile_name] = true;
        let newH = JSON.parse(JSON.stringify(handle.handles))
        fetchPlayerInfo_step(`?username=${encodeURI(username)}&serverId=${serverId}${ip == null ? "" : `&ip=${ip}`}`, newH, res, username, from, detail);
    } else {
        if (handle.handles.includes(api.id)) {
            if (api.id == 'original') {
                Fetch(`https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURI(username)}&serverId=${serverId}${ip == null ? "" : `&ip=${ip}`}`).then(data => {
                    if (data.status == 204) {
                        console.log(`<${username}> was not found.`);
                        detailReject(res, detail, "VERIFY_FAILED", getMsg("VERIFY_FAILED", { name: api.name }));
                        throw "NOT_FOUND";
                    }
                    res.status(data.status);
                    return data.json()
                }
                ).then(data => {
                    log('[JOIN] <' + username + "> was allowed to join from <" + api.name + ">");
                    if (!PlayerCaches[from].lookup(username)) {
                        trySavePlayer(username, api, data, res, from, detail);
                    } else {
                        PlayerCaches[from].new_login(username, new Date().getTime(), ip);
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
                Fetch(api.root + `/sessionserver/session/minecraft/hasJoined?username=${encodeURI(username)}&serverId=${serverId}${ip == null ? "" : `&ip=${ip}`}`).then(data => {
                    if (data.status == 204) {
                        console.log(`<${username}> was not found.`);
                        detailReject(res, detail, "VERIFY_FAILED", getMsg("VERIFY_FAILED", { name: api.name }));
                        throw "NOT_FOUND";
                    }
                    res.status(data.status);
                    return data.json()
                }).then(data => {
                    log('[JOIN] <' + username + "> was allowed to join from <" + api.name + ">");
                    if (!PlayerCaches[from].lookup(username)) {
                        trySavePlayer(username, api, data, res, from, detail);
                    } else {
                        PlayerCaches[from].new_login(username, new Date().getTime(), ip);
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
    let profile_name = searchnameForUUID(uuid1, from);

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

        Fetch("https://api.minecraftservices.com/minecraft/profile/lookup/name/" + url).then(data => {
            res.status(data.status);
            return data.text()
        }).then(data => {
            res.send(data).end();
        }).catch(e => {
            console.error(e);
            res.status(204).end();
        })
    } else {
        log("[PROFILE] Looking up for " + profile_name + "(" + url + ") from <" + api.name + ">");

        if (api.id == 'original') {
            Fetch("https://sessionserver.mojang.com/session/minecraft/profile/" + url).then(data => {
                res.status(data.status);
                return data.text()
            }).then(data => {
                res.send(data).end();
            }).catch(e => {
                console.error(e);
                res.status(204).end();
            })

        } else {
            Fetch(api.root + "/sessionserver/session/minecraft/profile/" + url).then(data => {
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
    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });
    let handle = HANDLES[from];
    req.on('end', () => {
        try {
            let bdy = JSON.parse(body);
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
                    Fetch("https://api.minecraftservices.com/minecraft/profile/lookup/bulk/byname", {
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
                    Fetch(api.root + "/api/profiles/minecraft", {
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

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });

    req.on('end', () => {
        try {
            let data = JSON.parse(body);
            if (data.secret !== secret) {
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

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });

    req.on('end', () => {
        try {
            let data = JSON.parse(body);
            if (data.secret !== secret) {
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

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });

    req.on('end', () => {
        try {
            let data = JSON.parse(body);
            if (data.secret !== secret) {
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

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });

    req.on('end', () => {
        try {
            let data = JSON.parse(body);
            if (data.secret !== secret) {
                res.status(403).send({ "error": "Invalid secret key" }).end();
                return;
            }

            let players = PlayerCaches[from].list_players();
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

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });

    req.on('end', () => {
        try {
            let data = JSON.parse(body);
            if (data.secret !== secret) {
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

    let body = '';
    req.on('data', (chunk) => {
        body += chunk;
    });

    req.on('end', () => {
        try {
            let data = JSON.parse(body);
            if (data.secret !== secret) {
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

// 皮肤站处理结束


app.get('/', function (req, res) {
    res.sendFile(__dirname + "/web/public/" + "index.html");
})
// 管理界面和管理API注册到 manageApp（独立管理服务器）或 app（主服务器）
let uiApp = manageApp || app;
uiApp.get(manageUrl, function (req, res) {
    res.sendFile(__dirname + "/web/public/" + "manage.html");
})
uiApp.get('/api/methods', function (req, res) {
    let methods = HANDLES.map((handle, idx) => ({
        url: handle.url,
        name: handle.name || 'default'
    }));
    res.send(methods).end();
})
// 如果启用了独立管理服务器，为其添加 favicon 和 404 处理
if (manageApp) {
    manageApp.get('/', function (req, res) {
        res.sendFile(__dirname + "/web/public/" + "index.html");
    })
    manageApp.get("/favicon.ico", function (req, res) { res.end() })
    manageApp.get('*', function (req, res) {
        log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
        res.sendFile(__dirname + '/web/public/404.html');
    });
    manageApp.post("*", function (req, res) {
        log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
        res.sendFile(__dirname + '/web/public/404.html');
    })
    manageApp.use((err, req, res, next) => {
        console.error(err.stack);
        let errInfo = err.message;
        res.type('text/plain');
        res.status(500).send(JSON.stringify({ "code": 500, "msg": "Something went error.", "details": errInfo }));
    });
}
app.get("/favicon.ico", function (req, res) { res.end() })

app.get('*', function (req, res) {
    // log('404 handler..')
    // log(req.url);
    log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
    res.sendFile(__dirname + '/web/public/404.html');
});

app.post("*", function (req, res) {
    log("[UNKNOWN] " + (req.ip) + " -> " + req.url);
    res.sendFile(__dirname + '/web/public/404.html');
})
// HTML 处理结束
app.use((err, req, res, next) => {
    console.error(err.stack);
    let currentTime = new Date();
    let errInfo = err.message;
    res.type('text/plain');
    res.status(500).send(JSON.stringify({ "code": 500, "msg": "Something went error.", "details": errInfo }));
});


reloadConfig();
server = app.listen(port);
log(`Server is listening to ${port} port.`);
if (manageApp) {
    manageServer = manageApp.listen(managePort);
    log(`Management server is listening to ${managePort} port.`);
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
    if (server == null) return;
    // console.log(port)
    server.listen(port);            // 在端口运行它
    // port = server.address().port;
    log(`Server is listening to ${port} port.`);
    // log(`IP: 0.0.0.0:${port}`);

    // 重启管理服务器（如已启用）
    if (manageServer != null && managePort > 0) {
        manageServer.close();
        manageServer.listen(managePort);
        log(`Management server is listening to ${managePort} port.`);
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
