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
        // 玩家元数据索引：避免列表/封禁/统计每次全量读取缓存文件
        this.playersMeta = {};
        try {
            let files = fs.readdirSync(this.path);
            for (let file of files) {
                if (!file.endsWith('.json') || file === 'a.ud.json') continue;
                let playerName = file.substring(0, file.length - 5);
                if (!checkName(playerName)) continue;
                try {
                    let data = JSON.parse(fs.readFileSync(this.path + "/" + file));
                    if (data && typeof data === 'object') {
                        this.playersMeta[playerName] = {
                            name: playerName,
                            uuid: data.uuid,
                            from: data.from,
                            lastLogin: data.lastLogin,
                            ban: data.ban === true,
                            banTime: data.banTime,
                            banReason: data.banReason,
                            banStart: data.banStart,
                            ip: data.ip
                        };
                    }
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
    // 维护内存元数据索引（player 为缓存文件名）
    this.setMeta = function (player, data) {
        if (!data || typeof data !== 'object') return;
        this.playersMeta[player] = {
            name: player,
            uuid: data.uuid,
            from: data.from,
            lastLogin: data.lastLogin,
            ban: data.ban === true,
            banTime: data.banTime,
            banReason: data.banReason,
            banStart: data.banStart,
            ip: data.ip
        };
    }
    this.deleteMeta = function (player) {
        delete this.playersMeta[player];
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
            this.setMeta(player, data);
            return true;
        } catch (e) {
            console.error(e);
        }
        return false;
    }
    this.add_raw = function (player, info, extra) {

        if (!checkName(player)) return { error: "INVALID_NAME" };
        if (fs.existsSync(this.path + "/" + player + ".json")) {
            try {
                let existing = JSON.parse(fs.readFileSync(this.path + "/" + player + ".json"));
                return { error: "DUPLICATE_NAME", existingFrom: existing.from };
            } catch (e) {
                return { error: "DUPLICATE_NAME" };
            }
        }
        // extra（如 lastLogin/ip）与信息合并为一次写入，避免写后再读再写
        let data = info;
        if (extra && typeof extra === 'object') {
            data = Object.assign({}, info, extra);
        }
        this.cacheUUID(player, data.uuid);
        fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(data, null, 2));
        this.setMeta(player, data);
        return true;
    }
    this.add = function (player, uuid, from, extra) {
        let t = this.lookup_uuid(uuid);
        if (t == undefined) {
            return this.add_raw(player, {
                "name": player,
                "uuid": uuid,
                "from": from
            }, extra);
        } else {
            if (t != player) {
                let info = this.lookup(t);
                // info may be false if UUID cache is stale (player file deleted manually);
                // still reject to avoid UUID conflicts.
                let existingFrom = info ? info.from : null;
                if (from == existingFrom) {
                    return this.player_changename(t, player, extra);
                } else {
                    log(`<${player}>(From <${from}>) was not allowed to join the server. Because it has a duplicate uuid (the same as <${t}>(From <${existingFrom}>)).`)
                    return { error: "DUPLICATE_UUID", existingName: t, existingFrom: existingFrom };
                }
            }
        }
        // 同名同 UUID：玩家已存在，仅更新登录信息（合并 extra）
        if (extra && typeof extra === 'object' && extra.lastLogin != null) {
            return this.new_login(player, extra.lastLogin, extra.ip);
        }
        return true;

    }
    this.player_changename = function (original_name, new_name, extra) {
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
            if (extra && typeof extra === 'object') {
                for (let key of Object.keys(extra)) {
                    data[key] = extra[key];
                }
            }
            this.cacheUUID(new_name,uid);
            fs.rmSync(this.path + "/" + original_name + ".json")

            fs.writeFileSync(this.path + "/" + new_name + ".json", JSON.stringify(data, null, 2));
            this.deleteMeta(original_name);
            this.setMeta(new_name, data);

            return true;
        } catch (e) {
            console.error(e);
        }
        return false;

    }
    this.new_login = function (player, time, ip = "Unknown", data = null) {
        if (!checkName(player)) return false;
        // 调用方已持有解析好的数据时直接复用，避免重复读文件
        let content = (data && typeof data === 'object') ? data : null;
        if (!content) {
            if (!fs.existsSync(this.path + "/" + player + ".json")) {
                return false;
            }
            try {
                content = JSON.parse(fs.readFileSync(this.path + "/" + player + ".json"));
            } catch (e) {
                console.error(e);
                return false;
            }
        }
        content['lastLogin'] = time;
        content['ip'] = ip;
        try {
            fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(content, null, 2));
            this.setMeta(player, content);
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
    // 全量列表（走内存索引，不读取缓存文件）
    this.list_players = function () {
        return Object.values(this.playersMeta).map(m => ({
            name: m.name,
            uuid: m.uuid,
            from: m.from,
            lastLogin: m.lastLogin,
            ban: m.ban === true,
            banTime: m.banTime,
            ip: m.ip
        }));
    }
    // 分页 + 搜索 + 排序列表（走内存索引）；pageSize <= 0 时返回全部
    this.list_players_page = function ({ page = 1, pageSize = 0, search = '', field = 'all', sort = 'name', dir = 1 } = {}) {
        let list = Object.values(this.playersMeta);
        let kw = String(search || '').toLowerCase();
        if (kw) {
            list = list.filter(m => {
                let name = String(m.name || '').toLowerCase();
                let uuid = String(m.uuid || '').toLowerCase();
                let from = String(m.from || '').toLowerCase();
                if (field === 'name') return name.includes(kw);
                if (field === 'uuid') return uuid.includes(kw);
                if (field === 'from') return from.includes(kw);
                return name.includes(kw) || uuid.includes(kw) || from.includes(kw);
            });
        }
        let d = dir >= 0 ? 1 : -1;
        list.sort((a, b) => {
            if (sort === 'lastLogin') {
                return ((Number(a.lastLogin) || 0) - (Number(b.lastLogin) || 0)) * d;
            }
            let va = String(a[sort] || '').toLowerCase();
            let vb = String(b[sort] || '').toLowerCase();
            if (va < vb) return -1 * d;
            if (va > vb) return 1 * d;
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        let total = list.length;
        let players = list;
        if (pageSize > 0) {
            let start = (Math.max(1, parseInt(page) || 1) - 1) * pageSize;
            players = list.slice(start, start + pageSize);
        }
        return {
            players: players.map(m => ({
                name: m.name,
                uuid: m.uuid,
                from: m.from,
                lastLogin: m.lastLogin,
                ban: m.ban === true,
                banTime: m.banTime,
                ip: m.ip
            })),
            total
        };
    }
    this.list_banned_players = function () {
        let bans = [];
        let now = Date.now();
        for (let m of Object.values(this.playersMeta)) {
            if (m.ban !== true) continue;
            let banTime = Number(m.banTime);
            if (banTime !== 0 && (!Number.isFinite(banTime) || banTime <= now)) continue;
            bans.push({
                name: m.name,
                banReason: m.banReason || '',
                banStart: m.banStart || null,
                banTime: m.banTime
            });
        }
        return bans;
    }
    // 统计（概览页）：总数 / 封禁 / 来源分布 / 最近登录 / 最近封禁，全部基于内存索引
    this.stats = function () {
        let total = 0, banned = 0, forever = 0, temp = 0;
        let sources = {};
        let recentLogins = [];
        let recentBans = [];
        let now = Date.now();
        for (let m of Object.values(this.playersMeta)) {
            total++;
            if (m.from) sources[m.from] = (sources[m.from] || 0) + 1;
            if (Number(m.lastLogin) > 0) {
                recentLogins.push({ name: m.name, lastLogin: m.lastLogin, from: m.from });
            }
            if (m.ban === true) {
                let bt = Number(m.banTime);
                if (bt === 0) {
                    banned++; forever++;
                    recentBans.push({ name: m.name, banTime: 0, banStart: m.banStart });
                } else if (Number.isFinite(bt) && bt > now) {
                    banned++; temp++;
                    recentBans.push({ name: m.name, banTime: bt, banStart: m.banStart });
                }
            }
        }
        recentLogins.sort((a, b) => Number(b.lastLogin) - Number(a.lastLogin));
        recentBans.sort((a, b) => new Date(b.banStart || 0) - new Date(a.banStart || 0));
        return {
            total,
            banned,
            forever,
            temp,
            sourceCount: Object.keys(sources).length,
            sources,
            recentLogins: recentLogins.slice(0, 5),
            recentBans: recentBans.slice(0, 5)
        };
    }
    // 导出用全量数据（仅在显式导出时调用）
    this.export_players = function () {
        return Object.values(this.playersMeta).map(m => ({
            name: m.name,
            uuid: m.uuid,
            from: m.from,
            lastLogin: m.lastLogin
        }));
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
            this.setMeta(player, newData);
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
            this.deleteMeta(player);
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
