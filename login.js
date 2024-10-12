const path = require("path");
const http = require('http');        // HTTP服务器API
const fs = require('fs');            // 文件系统API
const express = require('express');
const { PlayerCache, checkName } = require("./playercache.js");
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


var PUSH_LOGINMETHOD_PLAYERS = globleConfig.get("push", { "handles": [] }).handles;
var URL_APIS = globleConfig.get("apis", {});
var HANDLES = globleConfig.get("method", {});
var SkinDomains = globleConfig.get("skinDomains", ["127.0.0.1"]);
var DefaultSKINSITE = globleConfig.get("default", "original");
// HTML 开始处理
// 注册URL
for (let i = 0; i < HANDLES.length; i++) {
    let url = HANDLES[i].url;
    let idx = i + 0;
    console.log("Register url path: " + url);
    app.get(url, function (req, res) { urlHandle_root(req, res, idx) });
    app.post(`${url}/api/profiles/minecraft`, function (req, res) { urlHandle_profiles_post(req, res, idx) });
    app.get(`${url}/sessionserver/session/minecraft/hasJoined`, function (req, res) { urlHandle_joinServer(req, res, idx) });
    app.post(`${url}/minecraftservices/minecraft/profile/lookup/bulk/byname`, function (req, res) { urlHandle_profiles_post(req, res, idx) });
    app.get(`${url}/sessionserver/session/minecraft/profile/*`, function (req, res) { urlHandle_profiles(req, res, idx) })

}
// 皮肤站处理开始
function trySavePlayer(player, api, response_data, res) {
    log("[FOUND] Found <" + player + "> should come from <" + api.name + ">");
    let dat = response_data;
    let k = PlayerCache.add(dat.name, dat.id, api.id);
    if (k == false) res.status(204).end()
    else res.send(response_data).end();

}
function urlHandle_root(req, res, from) {
    // console.log('404 handler..')
    // console.log(req.url);
    log(req.url);

    res.send({
        "skinDomains": SkinDomains
    }).end();
}
function fetchPlayerInfo_step(args, apis, res, player) {
    if (apis.length <= 0) {
        res.status(204).end();
        log(`${player} not found in the remote server.`);
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
            trySavePlayer(player, api, data, res);
        }).catch(e => {
            // console.error(e);
            // res.status(204).end();
            // 寻找下一个
            fetchPlayerInfo_step(args, b, res, player);
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
            trySavePlayer(player, api, data, res);
        }).catch(e => {
            // console.error(e);
            // res.status(204).end();
            // 寻找下一个
            fetchPlayerInfo_step(args, b, res, player);
        })
    }
}
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
    let ipdisplay = ip + "";
    if (ip == undefined) ipdisplay = "Unknown"
    if (username == null || serverId == null || serverId == "" || username == "") {
        res.status(403).end();
        return;
    }
    log('[JOIN] <' + username + "> want to join. IP: " + ipdisplay + "");
    let info = PlayerCache.lookup(username);
    if (info.ban == true) {
        if (info.banTime == 0) {
            console.log("Player was forever banned.")
            res.status(204).end();
            return;
        }
        else if (info.banTime <= new Date().getTime()) {
            info.ban = false;
            PlayerCache.new_ban(username, -1)
            console.log("<" + username + "> was unbanned (Timeout).")
        } else {
            console.log("Player was banned.")
            res.status(204).end();
            return;
        }
    }
    let api = lookupApi(info.from);

    if (PUSH_LOGINMETHOD_PLAYERS[profile_name] != undefined) {
        api = lookupApi(PUSH_LOGINMETHOD_PLAYERS[profile_name]);
    }
    if (api == null) {
        console.log("Looking up for " + profile_name + " but not found. Try to search for it.");
        let newH = JSON.parse(JSON.stringify(handle.handles))
        fetchPlayerInfo_step(`?username=${encodeURI(username)}&serverId=${serverId}${ip == null ? "" : `&ip=${ip}`}`, newH, res, username);
    } else {
        if (handle.handles.includes(api.id)) {
            if (api.id == 'original') {
                Fetch(`https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURI(username)}&serverId=${serverId}${ip == null ? "" : `&ip=${ip}`}`).then(data => {
                    res.status(data.status);
                    if (data.status == 204) {

                        console.log(`<${username}> was not found.`);
                    }
                    return data.text()
                }
                ).then(data => {
                    log('[JOIN] <' + username + "> was allowed to join from <" + api.name + ">");

                    res.send(data).end();
                }).catch(e => {
                    console.error(e);
                    res.status(204).end();
                })

            } else {
                Fetch(api.root + `/sessionserver/session/minecraft/hasJoined?username=${encodeURI(username)}&serverId=${serverId}${ip == null ? "" : `&ip=${ip}`}`).then(data => {
                    res.status(data.status);
                    if (data.status == 204) {
                        console.log(`<${username}> was not found.`);
                    }
                    return data.text()
                }).then(data => {
                    log('[JOIN] <' + username + "> was allowed to join from <" + api.name + ">");
                    res.send(data).end();
                }).catch(e => {
                    console.error(e);
                    res.status(204).end();
                })
            }
        } else {
            console.log("The player used unsupported skin site <" + api.name + ">")
            res.status(204).end();
        }

    }
}
function searchnameForUUID(uuid) {
    return PlayerCache.lookup_uuid(uuid);
}
function urlHandle_profiles(req, res, from) {
    // console.log('404 handler..')
    // console.log(req.url);
    let handle = HANDLES[from];
    let url = req.url;
    url = url.substring(url.lastIndexOf("/") + 1)
    let uuid1 = url;
    if(uuid1.endsWith("?unsigned=false")){
        uuid1=uuid1.substring(0,uuid1.length - "?unsigned=false".length);
    }
    let profile_name = searchnameForUUID(uuid1);

    let info, api;
    if (!checkName(profile_name)) {
        log("[PROFILE] Looking up for " + url + " but check username failed.");
        // res.status(204).end();
        api = lookupApi(DefaultSKINSITE);
    } else {
        info = PlayerCache.lookup(profile_name);
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
                let info = PlayerCache.lookup(bdy[i]);
                let api = lookupApi(info.from);
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

// 皮肤站处理结束


app.get('/', function (req, res) {
    res.sendFile(__dirname + "/web/public/" + "index.html");
})
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
    if (server == null) return;
    // console.log(port)
    server.listen(port);            // 在端口运行它
    // port = server.address().port;
    log(`Server is listening to ${port} port.`);
    // log(`IP: 0.0.0.0:${port}`);

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
                let res = PlayerCache.new_ban(player, parseInt(time));
                if (res) {
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