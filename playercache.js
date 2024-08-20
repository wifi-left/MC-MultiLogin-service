const fs = require('fs');

const log = function (...info) {
    const date = new Date();
    const year = date.getFullYear().toString().padStart(4, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const hour = date.getHours().toString().padStart(2, "0");
    const minute = date.getMinutes().toString().padStart(2, "0");
    const second = date.getSeconds().toString().padStart(2, "0");

    for (let i = 0; i < info.length; i++) {
        console.log(`${month}-${day} ${hour}:${minute}:${second} - ${info[i]}`);
    }
}
var UUIDCache = {};

function checkName(name) {
    if (name == null || name == "") return false;

    if (name.search(/\./) != -1) return false;
    if (name.search(/\?/) != -1) return false;
    if (name.search(/\'/) != -1) return false;
    if (name.search(/\"/) != -1) return false;
    if (name.search(/\*/) != -1) return false;
    if (name.search(/\:/) != -1) return false;
    if (name.search(/\\/) != -1) return false;
    if (name.search(/\//) != -1) return false;
    if (name.search(/\>/) != -1) return false;
    if (name.search(/\</) != -1) return false;
    return true;
}
function class_PlayerCache(path) {
    this.path = path;
    this.lookup_uuid = function (uuid) {
        return UUIDCache[uuid];
    }
    this.cacheUUID = function (player, uuid) {
        UUIDCache[player] = uuid;
        try {
            fs.writeFileSync(this.path + "/ud.json", JSON.stringify(UUIDCache, null, 0));
        } catch (e) {
            console.error(e);
        }
    }
    this.lookup = function (player) {
        if (!checkName(player)) return false;
        if (fs.existsSync(this.path + "/" + player + ".json")) {
            try {
                return JSON.parse(fs.readFileSync(this.path + "/" + player + ".json"));
            } catch (e) {
                console.error(e);
            }
        }
        return false;

    }
    this.new_ban = function (player, time = 60 * 1000) {
        time = parseInt(time);
        if (!checkName(player)) return false;
        if (!fs.existsSync(this.path + "/" + player + ".json")) {
            return false;
        }
        try {
            let content = fs.readFileSync(this.path + "/" + player + ".json");
            let data = JSON.parse(content);
            if (time == 0) {
                data['ban'] = true;
                data['banStart'] = new Date();
                data['banTime'] = 0;
            } else if (time == -1) {
                data['ban'] = false;
                data['banTime'] = 0;
            } else {
                data['ban'] = true;
                data['banStart'] = new Date();
                data['banTime'] = new Date().getTime() + time;
            }
            fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error(e);
        }
        return false;
    }
    this.add_raw = function (player, info) {

        if (!checkName(player)) return false;
        if (fs.existsSync(this.path + "/" + player + ".json")) {
            return false;
        }
        this.cacheUUID(player, info.uuid);
        fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(info, null, 2));
        return true;
    }
    this.add = function (player, uuid, from) {
        let t = this.lookup_uuid(uuid);
        if (t == undefined) {

            this.add_raw(player, {
                "name": player,
                "uuid": uuid,
                "from": from
            });
            return true;
        } else {
            if (t != player) {
                let info = this.lookup(t);
                if (info.from != from) {
                    log(`<${player}>(From <${info.from}>) was not allowed to join the server. Because it has a duplicate uuid (the same as <${t}>(From <${info.from}>)).`)

                    return false;
                }
                log("[RENAME] <" + t + "> renamed to <" + player + ">")
                this.player_changename(t, player);
            }
        }
        return true;

    }
    this.player_changename = function (original_name, new_name) {
        if (!checkName(original_name)) return false;
        if (!fs.existsSync(this.path + "/" + original_name + ".json")) {
            return false;
        }
        try {
            let content = fs.readFileSync(this.path + "/" + original_name + ".json");
            let data = JSON.parse(content);
            let k = data['names'];
            if (k == undefined) {
                data['names'] = [];
            }
            data['old_names'].push(original_name)
            data['name'] = new_name;

            fs.rmSync(this.path + "/" + original_name + ".json")

            fs.writeFileSync(this.path + "/" + new_name + ".json", JSON.stringify(data, null, 2));

            return true;
        } catch (e) {
            console.error(e);
        }
        return false;

    }
    this.new_login = function (player, time, ip = "Unknown") {
        if (!checkName(player)) return false;
        if (!fs.existsSync(this.path + "/" + player + ".json")) {
            return false;
        }
        try {
            let content = fs.readFileSync(this.path + "/" + player + ".json");
            let data = JSON.parse(content);
            data['lastLogin'] = time;
            data['ip'] = ip;
            fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(data, null, 2));

            return true;
        } catch (e) {
            console.error(e);
        }
        return false;

    }
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path);
    }
    try {
        if (fs.existsSync(path + "/ud.json")) {
            UUIDCache = JSON.parse(fs.readFileSync(path + "/ud.json"));
        } else {
            UUIDCache = {};
        }
    } catch (e) {
        console.error(e);
        UUIDCache = {};
    }
}
const PlayerCache = new class_PlayerCache("./cache/");
module.exports = {
    PlayerCache, checkName, log
}