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
function normalizeUUID(uuid) {
    if (uuid == null) return null;
    return (uuid + "").toLowerCase().replace(/-/g, "");
}
function getUUIDKeys(uuid) {
    let raw = uuid == null ? null : (uuid + "").toLowerCase();
    let normalized = normalizeUUID(uuid);
    if (raw == null || normalized == null) return [];
    if (raw === normalized) return [normalized];
    return [raw, normalized];
}
function class_PlayerCache(path) {
    this.path = path;
    this.UUIDCache = {};
    this.persistUUIDCache = function () {
        try {
            fs.writeFileSync(this.path + "/a.ud.json", JSON.stringify(this.UUIDCache, null, 0));
            return true;
        } catch (e) {
            console.error(e);
        }
        return false;
    }
    this.rebuildUUIDCacheFromFiles = function (overwriteConflict = false) {
        let changed = false;
        try {
            let files = fs.readdirSync(this.path);
            for (let file of files) {
                if (!file.endsWith('.json') || file === 'a.ud.json') continue;
                let playerName = file.substring(0, file.length - 5);
                if (!checkName(playerName)) continue;
                try {
                    let data = JSON.parse(fs.readFileSync(this.path + "/" + file));
                    if (!data || !data.uuid) continue;
                    let keys = getUUIDKeys(data.uuid);
                    for (let key of keys) {
                        let cachedPlayer = this.UUIDCache[key];
                        if (cachedPlayer == undefined) {
                            this.UUIDCache[key] = playerName;
                            changed = true;
                        } else if (cachedPlayer != playerName && overwriteConflict === true) {
                            this.UUIDCache[key] = playerName;
                            changed = true;
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }
        } catch (e) {
            console.error(e);
        }
        if (changed) {
            log(`[UUID_CACHE] Repaired UUID index for cache path ${this.path}`);
            this.persistUUIDCache();
        }
        return changed;
    }
    this.rebuildUUIDCache = function (overwriteConflict = false) {
        this.UUIDCache = {};
        this.rebuildUUIDCacheFromFiles(overwriteConflict);
        return Object.keys(this.UUIDCache).length;
    }
    this.lookup_uuid = function (uuid) {
        let keys = getUUIDKeys(uuid);
        for (let key of keys) {
            let mapped = this.UUIDCache[key];
            if (mapped != undefined) return mapped;
        }
        let target = normalizeUUID(uuid);
        if (target == null) return undefined;
        try {
            let files = fs.readdirSync(this.path);
            for (let file of files) {
                if (!file.endsWith('.json') || file === 'a.ud.json') continue;
                let playerName = file.substring(0, file.length - 5);
                try {
                    let data = JSON.parse(fs.readFileSync(this.path + "/" + file));
                    if (data && normalizeUUID(data.uuid) === target) {
                        this.cacheUUID(playerName, data.uuid);
                        return playerName;
                    }
                } catch (e) {
                    console.error(e);
                }
            }
        } catch (e) {
            console.error(e);
        }
        return undefined;
    }
    this.cacheUUID = function (player, uuid) {
        let keys = getUUIDKeys(uuid);
        if (keys.length <= 0) return false;
        for (let key of keys) {
            this.UUIDCache[key] = player;
        }
        if (this.persistUUIDCache()) {
            log(`[UUID_CACHE] Cache uuid ${keys[0]} for ${player}`);
            return true;
        }
        console.error(`[UUID_CACHE] Failed to persist uuid ${keys[0]} for ${player}`);
        return false;
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
                if (from == existingFrom) {
                    return this.player_changename(t, player);
                } else {
                    log(`<${player}>(From <${from}>) was not allowed to join the server. Because it has a duplicate uuid (the same as <${t}>(From <${existingFrom}>)).`)
                    return { error: "DUPLICATE_UUID", existingName: t, existingFrom: existingFrom };
                }
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
            let uid = data['uuid'];
            this.cacheUUID(new_name,uid);
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
                if (!file.endsWith('.json') || file === 'a.ud.json') continue;
                let playerName = file.substring(0, file.length - 5);
                try {
                    let data = JSON.parse(fs.readFileSync(this.path + "/" + file));
                    players.push({
                        name: playerName,
                        uuid: data.uuid,
                        from: data.from
                    });
                } catch (e) {
                    console.error(e);
                }
            }
            return players;
        } catch (e) {
            console.error(e);
            return [];
        }
    }
    this.list_banned_players = function () {
        try {
            let files = fs.readdirSync(this.path);
            let bans = [];
            let now = new Date().getTime();
            for (let file of files) {
                if (!file.endsWith('.json') || file === 'a.ud.json') continue;
                let playerName = file.substring(0, file.length - 5);
                try {
                    let data = JSON.parse(fs.readFileSync(this.path + "/" + file));
                    if (data?.ban !== true) continue;
                    let banTime = Number(data.banTime);
                    if (banTime !== 0 && (!Number.isFinite(banTime) || banTime <= now)) continue;
                    bans.push({
                        name: playerName,
                        banReason: data.banReason || '',
                        banStart: data.banStart || null,
                        banTime: data.banTime
                    });
                } catch (e) {
                    console.error(e);
                }
            }
            return bans;
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
                let keys = getUUIDKeys(data.uuid);
                for (let key of keys) {
                    delete this.UUIDCache[key];
                }
                this.persistUUIDCache();
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
        this.rebuildUUIDCacheFromFiles(false);
    } catch (e) {
        console.error(e);
        this.UUIDCache = {};
        this.rebuildUUIDCacheFromFiles(false);
    }
}
module.exports = {
    class_PlayerCache, checkName, log
}
