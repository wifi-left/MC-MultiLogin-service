const fs = require('fs');

const { log } = require('./utils.js');

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
    this.UUIDCache = {};
    this.lookup_uuid = function (uuid) {
        return this.UUIDCache[uuid];
    }
    this.cacheUUID = function (player, uuid) {
        this.UUIDCache[uuid] = player;
        try {
            fs.writeFileSync(this.path + "/a.ud.json", JSON.stringify(this.UUIDCache, null, 0));
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
    this.new_ban = function (player, time = 60 * 1000, reason = null) {
        time = parseInt(time);
        if (!checkName(player)) return false;
        if (!fs.existsSync(this.path + "/" + player + ".json")) {
            return false;
        }
        function applyReason(data, r) {
            if (r != null && r !== '') {
                data['banReason'] = r;
            } else {
                delete data['banReason'];
            }
        }
        try {
            let content = fs.readFileSync(this.path + "/" + player + ".json");
            let data = JSON.parse(content);
            if (time == 0) {
                data['ban'] = true;
                data['banStart'] = new Date();
                data['banTime'] = 0;
                applyReason(data, reason);
            } else if (time == -1) {
                data['ban'] = false;
                data['banTime'] = 0;
                delete data['banReason'];
            } else {
                data['ban'] = true;
                data['banStart'] = new Date();
                data['banTime'] = new Date().getTime() + time;
                applyReason(data, reason);
            }
            fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error(e);
        }
        return false;
    }
    this.add_raw = function (player, info) {

        if (!checkName(player)) return { error: "INVALID_NAME" };
        if (fs.existsSync(this.path + "/" + player + ".json")) {
            try {
                let existing = JSON.parse(fs.readFileSync(this.path + "/" + player + ".json"));
                return { error: "DUPLICATE_NAME", existingFrom: existing.from };
            } catch (e) {
                return { error: "DUPLICATE_NAME" };
            }
        }
        this.cacheUUID(player, info.uuid);
        fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(info, null, 2));
        return true;
    }
    this.add = function (player, uuid, from) {
        let t = this.lookup_uuid(uuid);
        if (t == undefined) {
            return this.add_raw(player, {
                "name": player,
                "uuid": uuid,
                "from": from
            });
        } else {
            if (t != player) {
                let info = this.lookup(t);
                // info may be false if UUID cache is stale (player file deleted manually);
                // still reject to avoid UUID conflicts.
                let existingFrom = info ? info.from : null;
                log(`<${player}>(From <${from}>) was not allowed to join the server. Because it has a duplicate uuid (the same as <${t}>(From <${existingFrom}>)).`)
                return { error: "DUPLICATE_UUID", existingName: t, existingFrom: existingFrom };
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
            let k = data['old_names'];
            if (k == undefined) {
                data['old_names'] = [];
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
    this.find_available_name = function (player) {
        let i = 2;
        while (i <= 9999) {
            let candidate = player + "_" + i;
            if (!fs.existsSync(this.path + "/" + candidate + ".json")) {
                return candidate;
            }
            i++;
        }
        return null;
    }
    this.list_players = function () {
        try {
            let files = fs.readdirSync(this.path);
            let players = [];
            for (let file of files) {
                if (file.endsWith('.json') && file !== 'a.ud.json') {
                    players.push(file.substring(0, file.length - 5));
                }
            }
            return players;
        } catch (e) {
            console.error(e);
            return [];
        }
    }
    this.modify = function (player, newData) {
        if (!checkName(player)) return false;
        if (!fs.existsSync(this.path + "/" + player + ".json")) {
            return false;
        }
        try {
            fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(newData, null, 2));
            if (newData.uuid && newData.name) {
                this.cacheUUID(newData.name, newData.uuid);
            }
            return true;
        } catch (e) {
            console.error(e);
        }
        return false;
    }
    this.delete = function (player) {
        if (!checkName(player)) return false;
        if (!fs.existsSync(this.path + "/" + player + ".json")) {
            return false;
        }
        try {
            let content = fs.readFileSync(this.path + "/" + player + ".json");
            let data = JSON.parse(content);
            if (data.uuid) {
                delete this.UUIDCache[data.uuid];
                fs.writeFileSync(this.path + "/a.ud.json", JSON.stringify(this.UUIDCache, null, 0));
            }
            fs.rmSync(this.path + "/" + player + ".json");
            return true;
        } catch (e) {
            console.error(e);
        }
        return false;
    }
    if (!fs.existsSync(path)) {
        fs.mkdirSync(path, { recursive: true });
    }
    try {
        if (fs.existsSync(path + "/a.ud.json")) {
            this.UUIDCache = JSON.parse(fs.readFileSync(path + "/a.ud.json"));
        } else {
            this.UUIDCache = {};
        }
    } catch (e) {
        console.error(e);
        this.UUIDCache = {};
    }
}
module.exports = {
    class_PlayerCache, checkName, log
}