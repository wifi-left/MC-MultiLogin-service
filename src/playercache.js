const fs = require('fs');

const { log, globleConfig } = require('./utils.js');

// 改名级联上限：一次登录处理中最多沿 uuid 链自动改名几次，超出即拒绝（防止上游异常导致无限递归）
const MAX_RENAME_CHAIN = 3;
// 本次进程内已提示过的"曾用名冲突"（按 缓存目录+名字+档案 去重）：
// 索引每次启动都按磁盘重建、同一目录还可能被多个子配置共用，不去重就会重复刷屏
const aliasConflictLogged = new Set();
const aliasConflictSummaryLogged = new Set();

function checkName(name) {
    // 必须是字符串：调用方可能把索引里的非字符串值（如命中 Object.prototype 的属性）传进来
    if (typeof name !== 'string' || name === "") return false;

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
// 原型安全的字典：uuid / 玩家名 / 来源 id 都可能与 Object.prototype 上的属性同名
function newDict() {
    return Object.create(null);
}
// JSON.parse 得到的是普通对象，必须转成无原型字典再使用
function toDict(value) {
    let out = newDict();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (let key of Object.keys(value)) out[key] = value[key];
    }
    return out;
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
    // 归一化形态优先：索引以它为准，带横线的原始形态只作为兼容键
    return [normalized, raw];
}
// 档兼容：old_names 必须是字符串数组，历史数据可能是字符串或缺失
function normalizeOldNames(names) {
    if (Array.isArray(names)) return names.filter(n => typeof n === 'string' && n !== '');
    if (typeof names === 'string' && names !== '') return [names];
    return [];
}
function class_PlayerCache(path) {
    this.path = path;
    this.UUIDCache = newDict();
    // 曾用名检索使用的临时索引：oldName(小写) -> [档案名]（不落盘）
    // 玩家名做键的字典一律用无原型对象：玩家名可以等于 toString/constructor/__proto__ 等
    // Object.prototype 上的属性名，普通对象会让 hasOwnProperty 判定失效（这些玩家无法登录）
    this.oldNameIndex = Object.create(null);
    this.persistUUIDCache = function () {
        try {
            fs.writeFileSync(this.path + "/a.ud.json", JSON.stringify(this.UUIDCache, null, 0));
            return true;
        } catch (e) {
            console.error(e);
        }
        return false;
    }
    // 索引仅保留指向"存在的档案文件"的条目：磁盘文件是唯一权威，索引只是派生物
    this.pruneStaleUUIDEntries = function () {
        let removed = [];
        for (let key of Object.keys(this.UUIDCache)) {
            let name = this.UUIDCache[key];
            let data = this.readFile(name);
            if (!data) {
                removed.push({ key: key, name: name, reason: "missing_file" });
                delete this.UUIDCache[key];
                continue;
            }
            if (normalizeUUID(data.uuid) !== normalizeUUID(key)) {
                removed.push({ key: key, name: name, reason: "uuid_mismatch", fileUUID: data.uuid == null ? null : data.uuid });
                delete this.UUIDCache[key];
            }
        }
        return removed;
    }
    // 曾用名冲突清单：某名字既是在用档案的当前名，又被另一个档案记为曾用名
    // （名字被回收后又被重新注册）。只读内存索引 playersMeta，不读盘、不访问上游。
    // 返回 [{ name, owner: {name,uuid,from,lastLogin}, current: {name,uuid,from,lastLogin} }]
    this.aliasConflicts = function () {
        let side = m => (m ? { name: m.name, uuid: m.uuid == null ? null : m.uuid, from: m.from == null ? null : m.from, lastLogin: m.lastLogin == null ? null : m.lastLogin } : null);
        let out = [];
        for (let playerName of Object.keys(this.playersMeta)) {
            let owner = this.playersMeta[playerName];
            for (let oldName of normalizeOldNames(owner.old_names)) {
                if (oldName === playerName) continue;
                let current = this.playersMeta[oldName];
                if (!current) continue;
                out.push({ name: oldName, owner: side(owner), current: side(current) });
            }
        }
        return out;
    }
    this.rebuildUUIDCacheFromFiles = function (overwriteConflict = false) {
        let changed = false;
        // 玩家元数据索引：避免列表/封禁/统计每次全量读取缓存文件
        this.playersMeta = Object.create(null);
        this.oldNameIndex = Object.create(null);
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
                            ip: data.ip,
                            old_names: normalizeOldNames(data['old_names'])
                        };
                        for (let oldName of this.playersMeta[playerName].old_names) {
                            let k = oldName.toLowerCase();
                            if (!this.oldNameIndex[k]) this.oldNameIndex[k] = [];
                            if (!this.oldNameIndex[k].includes(playerName)) this.oldNameIndex[k].push(playerName);
                        }
                        // 曾用名冲突在下方的"整表扫描"里统一检测（必须等 playersMeta 全部建好，
                        // 否则结果会依赖文件遍历顺序，漏报 owner 排在前面的一半）
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
        // 曾用名同时也是另一个在用档案的当前名（名字被回收后又被别人占用）。
        // 这是常见现象，只影响"曾用名追踪"的展示、不参与登录/改名判定，所以默认只按目录汇总一行，
        // 逐条明细交给 debug 或管理面板的「用户名冲突」页（调 aliasConflicts() 取同一份清单）。
        // 注意必须等 playersMeta 全部建好后再检测，否则结果会依赖文件遍历顺序、漏报一半。
        let conflicts = this.aliasConflicts();
        if (conflicts.length > 0 && !aliasConflictSummaryLogged.has(this.path)) {
            aliasConflictSummaryLogged.add(this.path);
            log(`[UUID_CACHE] Alias conflicts in ${this.path}: ${conflicts.length}（曾用名与在用档案同名，通常是名字被回收后又被占用；清单见管理面板"用户名冲突"页，逐条明细可设 debug: true）`);
        }
        if (conflicts.length > 0 && globleConfig.get("debug", false)) {
            for (let c of conflicts) {
                let key = this.path + '|' + c.name + '|' + c.owner.name;
                if (aliasConflictLogged.has(key)) continue;
                aliasConflictLogged.add(key);
                log(`[UUID_CACHE] Alias conflict: <${c.name}> is used as current name of <${c.name}> and as an old name of <${c.owner.name}>`);
            }
        }
        if (changed) {
            log(`[UUID_CACHE] Repaired UUID index for cache path ${this.path}`);
            this.persistUUIDCache();
        }
        return changed;
    }
    this.rebuildUUIDCache = function (overwriteConflict = false) {
        this.UUIDCache = newDict();
        this.rebuildUUIDCacheFromFiles(overwriteConflict);
        return Object.keys(this.UUIDCache).length;
    }
    // 读取档案文件；不存在/损坏返回 null
    this.readFile = function (player) {
        if (!checkName(player)) return null;
        let file = this.path + "/" + player + ".json";
        try {
            if (!fs.existsSync(file)) return null;
            return JSON.parse(fs.readFileSync(file));
        } catch (e) {
            console.error(e);
        }
        return null;
    }
    // 按 uuid 自愈定位档案：命中索引后仍回磁盘校验，删除指向不存在/不匹配文件的条目
    this.lookup_uuid_detail = function (uuid) {
        let target = normalizeUUID(uuid);
        if (target == null) return { name: undefined, repaired: false };
        let keys = getUUIDKeys(uuid);
        for (let key of keys) {
            let mapped = this.UUIDCache[key];
            if (mapped == undefined) continue;
            let data = this.readFile(mapped);
            if (data && normalizeUUID(data.uuid) === target) {
                return { name: mapped, repaired: false };
            }
            let reason = data ? "uuid_mismatch" : "missing_file";
            log(`[UUID_CACHE] Dropped stale index entry ${target} -> ${mapped} (${reason})`);
            // 只清理"目标 uuid 仍指向该名字"的键，避免误删该档案名下其它 uuid 的键
            this.removeUUIDKeysFor(target, mapped);
            this.persistUUIDCache();
        }
        let found = this.scanUUIDFromFiles(target);
        if (found) {
            this.cacheUUID(found, uuid);
            return { name: found, repaired: true };
        }
        return { name: undefined, repaired: false };
    }
    this.lookup_uuid = function (uuid) {
        return this.lookup_uuid_detail(uuid).name;
    }
    // 删除"某个 uuid 键指向该名字"的索引项（不动其它 uuid 的键）
    this.removeUUIDKeysFor = function (uuid, name) {
        for (let key of getUUIDKeys(uuid)) {
            if (this.UUIDCache[key] === name) delete this.UUIDCache[key];
        }
    }
    // 目录扫描：找到磁盘上 uuid 匹配的档案
    this.scanUUIDFromFiles = function (uuid) {
        let target = normalizeUUID(uuid);
        if (target == null) return null;
        try {
            let files = fs.readdirSync(this.path);
            for (let file of files) {
                if (!file.endsWith('.json') || file === 'a.ud.json') continue;
                let playerName = file.substring(0, file.length - 5);
                if (!checkName(playerName)) continue;
                try {
                    let data = JSON.parse(fs.readFileSync(this.path + "/" + file));
                    if (data && normalizeUUID(data.uuid) === target) return playerName;
                } catch (e) {
                    console.error(e);
                }
            }
        } catch (e) {
            console.error(e);
        }
        return null;
    }
    // 索引体检：报告（可选修复）幽灵条目、重复 uuid、缺失映射、曾用名冲突
    this.verifyUUIDCache = function ({ fix = false } = {}) {
        let stale = [];
        let duplicate = [];
        let missing = [];
        let uuidOwner = newDict();
        let files = [];
        try {
            files = fs.readdirSync(this.path);
        } catch (e) {
            console.error(e);
            return { stale, duplicate, missing, repaired: false, entries: 0 };
        }
        for (let file of files) {
            if (!file.endsWith('.json') || file === 'a.ud.json') continue;
            let playerName = file.substring(0, file.length - 5);
            if (!checkName(playerName)) continue;
            let data = null;
            try {
                data = JSON.parse(fs.readFileSync(this.path + "/" + file));
            } catch (e) {
                continue;
            }
            if (!data || typeof data !== 'object') continue;
            // 曾用名冲突只在最后统一算（aliasConflicts()，只读内存索引），这里不再逐个文件判定
            if (!data.uuid) continue;
            let target = normalizeUUID(data.uuid);
            if (uuidOwner[target] == undefined) {
                uuidOwner[target] = playerName;
            } else {
                duplicate.push({ uuid: target, names: [uuidOwner[target], playerName] });
            }
        }
        for (let key of Object.keys(this.UUIDCache)) {
            let name = this.UUIDCache[key];
            let data = null;
            try {
                data = this.readFile(name);
            } catch (e) {
                data = null;
            }
            if (!data) {
                stale.push({ key: key, name: name, reason: "missing_file" });
            } else if (normalizeUUID(data.uuid) !== normalizeUUID(key)) {
                stale.push({ key: key, name: name, reason: "uuid_mismatch", fileUUID: data.uuid == null ? null : data.uuid });
            }
        }
        for (let target of Object.keys(uuidOwner)) {
            let owner = uuidOwner[target];
            let mapped = this.UUIDCache[target];
            if (mapped == undefined) {
                missing.push({ uuid: target, name: owner });
            }
            // 索引指向非归属档案的情况已由 stale 报告（指向不存在/不匹配档案），这里只报告
            // 真正无法自动判定的冲突：多份档案宣称同一个 uuid（上面的 duplicate）
        }
        let repaired = false;
        if (fix) {
            for (let item of stale) {
                for (let key of getUUIDKeys(item.key)) {
                    if (this.UUIDCache[key] === item.name) {
                        delete this.UUIDCache[key];
                        repaired = true;
                    }
                }
            }
            // 多份档案共用同一 uuid：索引无法确定归属，清掉该 uuid 的所有键（登录侧会以 DUPLICATE_NAME 拒绝，提示人工处理）
            let conflicting = newDict();
            for (let item of duplicate) {
                if (!conflicting[item.uuid]) conflicting[item.uuid] = true;
            }
            for (let target of Object.keys(conflicting)) {
                for (let key of getUUIDKeys(target)) {
                    if (this.UUIDCache[key] !== undefined) {
                        delete this.UUIDCache[key];
                        repaired = true;
                    }
                }
            }
            for (let target of Object.keys(uuidOwner)) {
                if (conflicting[target]) continue;
                let owner = uuidOwner[target];
                for (let key of getUUIDKeys(target)) {
                    if (this.UUIDCache[key] !== owner) {
                        if (this.UUIDCache[key] !== undefined) repaired = true;
                        if (missing.some(m => m.uuid === target && m.name === owner)) repaired = true;
                        this.UUIDCache[key] = owner;
                    }
                }
            }
            if (repaired) {
                this.persistUUIDCache();
                log(`[UUID_CACHE] Repaired stale index for cache path ${this.path} (stale: ${stale.length}, missing: ${missing.length})`);
            }
        }
        return {
            stale,
            duplicate,
            missing,
            repaired,
            entries: Object.keys(this.UUIDCache).length
        };
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
            ip: data.ip,
            old_names: normalizeOldNames(data['old_names'])
        };
        this.reindexOldNames(player);
    }
    this.deleteMeta = function (player) {
        delete this.playersMeta[player];
        this.reindexOldNames(player);
    }
    // 重建某个档案的曾用名索引（改名/删除后必须同步，否则曾用名检索会失准）
    this.reindexOldNames = function (player) {
        let owner = String(player).toLowerCase();
        for (let key of Object.keys(this.oldNameIndex)) {
            let list = this.oldNameIndex[key];
            let i = list.findIndex(n => String(n).toLowerCase() === owner);
            if (i !== -1) list.splice(i, 1);
            if (list.length === 0) delete this.oldNameIndex[key];
        }
        let meta = this.playersMeta[player];
        if (!meta) return;
        for (let oldName of normalizeOldNames(meta.old_names)) {
            let k = oldName.toLowerCase();
            if (!this.oldNameIndex[k]) this.oldNameIndex[k] = [];
            if (!this.oldNameIndex[k].includes(player)) this.oldNameIndex[k].push(player);
        }
    }
    // 曾用名检索：返回曾用名匹配的档案名列表
    this.lookup_oldname = function (name) {
        if (name == null || name === '') return [];
        return (this.oldNameIndex[name.toLowerCase()] || []).slice();
    }
    // 档案的曾用名历史（最近的在前），含账号最初记录名
    this.name_history = function (player) {
        let meta = this.playersMeta[player];
        if (!meta) return null;
        let olds = normalizeOldNames(meta.old_names);
        let history = [];
        // old_names 按时间先后累积，展示时"最近的在前"，最后接当前名
        for (let i = olds.length - 1; i >= 0; i--) {
            history.push({ name: olds[i] });
        }
        history.push({ name: player, current: true });
        return {
            name: player,
            uuid: meta.uuid == null ? null : meta.uuid,
            from: meta.from == null ? null : meta.from,
            old_names: olds,
            oldest: olds.length > 0 ? olds[0] : player,
            history
        };
    }
    this.lookup = function (player) {
        if (!checkName(player)) return false;
        let data = this.readFile(player);
        return data ? data : false;

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
        fs.writeFileSync(this.path + "/" + player + ".json", JSON.stringify(data, null, 2));
        this.cacheUUID(player, data.uuid);
        this.setMeta(player, data);
        return true;
    }
    // 按 uuid 找"档案里真正记录了这个 uuid"的名字（索引命中后仍回磁盘校验）
    this.profileOwningUUID = function (uuid) {
        let target = normalizeUUID(uuid);
        if (target == null) return null;
        for (let key of getUUIDKeys(uuid)) {
            let mapped = this.UUIDCache[key];
            if (mapped == undefined) continue;
            let data = this.readFile(mapped);
            if (data && normalizeUUID(data.uuid) === target) return mapped;
        }
        return null;
    }
    // 上游查询结论归一化：存在(同名/新名) / 账号不存在 / 查询失败
    this.lookupHolder = async function (resolver, uuid) {
        if (!resolver || typeof resolver.nameForUuid !== 'function') {
            return { status: "unsupported" };
        }
        try {
            let r = await resolver.nameForUuid(uuid);
            if (r === undefined || r === null) return { status: "unsupported" };
            if (r && typeof r === 'object') {
                if (r.status === 'missing') return { status: "missing" };
                if (r.status === 'failed') return { status: "failed" };
                if (typeof r.name === 'string' && r.name !== '') return { status: "found", name: r.name };
                return { status: "missing" };
            }
            return { status: "found", name: String(r) };
        } catch (e) {
            console.error(e);
            return { status: "failed" };
        }
    }
    this.rejectConflict = function (holderName, holder, reason) {
        let existingFrom = holder && holder.from != null ? holder.from : null;
        let existingUUID = holder && holder.uuid != null ? normalizeUUID(holder.uuid) : null;
        let r = { error: "NAME_LOOKUP_FAILED", reason: reason || "lookup_failed", existingName: holderName, existingFrom: existingFrom };
        if (reason === "other_source") {
            return { error: "NAME_TAKEN", reason: reason, existingName: holderName, existingFrom: existingFrom, existingUUID: existingUUID };
        }
        if (reason === "unchanged") {
            return { error: "NAME_UNCHANGED", reason: reason, existingName: holderName, existingFrom: existingFrom, existingUUID: existingUUID };
        }
        if (reason === "no_resolver") {
            return { error: "NAME_TAKEN", reason: reason, existingName: holderName, existingFrom: existingFrom, existingUUID: existingUUID };
        }
        return r;
    }
    /*
     * 改名冲突处理（"这个新账号想用已被占用的名字"）
     *  - profileName/uuid 为上游 hasJoined 返回的权威身份，localName 是磁盘上已占用该名字的档案
     *  - 规则：
     *      1. localName 档案的来源与请求来源不同 → 直接拒绝，且不查询上游
     *      2. 在该档案自身的来源里查询它记录的 uuid 当前叫什么名字：
     *           查询失败              → NAME_LOOKUP_FAILED
     *           账号已不存在          → HOLDER_REMOVED（该档案是历史残留，让路）
     *           名字未变              → NAME_UNCHANGED（拒绝，名字仍被占用）
     *           名字已变              → HOLDER_RENAMED（先把旧档案改成新名字，再重试本次加入）
     *  - 递归防护：depth（级联上限）、visited（本轮已处理的 uuid 环检测）、
     *             resolver.available（同一轮只解析一次）
     */
    this.resolveNameConflict = async function (profileName, uuid, from, extra, localName, resolver, depth) {
        if (!checkName(profileName)) return { error: "INVALID_NAME" };
        let holder = this.lookup(localName);
        if (!holder) return { error: "PROFILE_NOT_FOUND", existingName: localName };
        let holderFrom = holder.from == null ? null : holder.from;
        let holderUuid = holder.uuid == null ? null : normalizeUUID(holder.uuid);
        // 1) 来源不同：不信任其它来源的档案，直接拒绝
        if (from != holderFrom) {
            log(`[RENAME] <${profileName}> conflicts with <${localName}> from <${holderFrom}>; source differs, rejecting without query.`);
            return this.rejectConflict(localName, holder, "other_source");
        }
        // 2) 无解析器 / 本轮已解析过：只回报冲突
        if (!resolver || typeof resolver.nameForUuid !== 'function' || resolver.available !== true) {
            return this.rejectConflict(localName, holder, "no_resolver");
        }
        // 3) 防递归闸门：级联深度上限
        if (depth >= MAX_RENAME_CHAIN) {
            log(`[RENAME] Chain limit reached while resolving <${localName}> vs <${profileName}>, rejecting.`);
            return this.rejectConflict(localName, holder, "chain_limit");
        }
        // 4) 防递归闸门：环检测
        if (holderUuid != null && resolver.visited && resolver.visited.indexOf(holderUuid) !== -1) {
            log(`[RENAME] Cycle detected for uuid ${holderUuid} while resolving <${localName}>, aborting.`);
            return this.rejectConflict(localName, holder, "cycle");
        }
        let probe = await this.lookupHolder(resolver, holder.uuid);
        if (probe.status === "failed") {
            return this.rejectConflict(localName, holder, "lookup_failed");
        }
        if (probe.status === "unsupported") {
            return this.rejectConflict(localName, holder, "no_resolver");
        }
        if (probe.status === "missing") {
            // 占位账号在来源里已不存在：档案是历史残留，直接让路
            log(`[RENAME] <${localName}> was not found in <${holderFrom}> anymore; releasing the name for <${profileName}>.`);
            if (holderUuid != null && resolver.visited) resolver.visited.push(holderUuid);
            let removed = this.delete(localName);
            if (!removed) return this.rejectConflict(localName, holder, "write_failed");
            return { error: "HOLDER_REMOVED", existingName: localName, existingFrom: holderFrom };
        }
        if (String(probe.name) === String(localName)) {
            // 名字没变过：该账号仍持有此名，不允许抢占
            return this.rejectConflict(localName, holder, "unchanged");
        }
        // 5) 占位账号确实改了名：把它改到新名字，让出当前名字
        if (!checkName(probe.name)) {
            return this.rejectConflict(localName, holder, "write_failed");
        }
        if (probe.name !== profileName && fs.existsSync(this.path + "/" + probe.name + ".json")) {
            // 让位目标也被占用：不冒险覆盖，交给人工处理
            return this.rejectConflict(localName, holder, "write_failed");
        }
        log(`[RENAME] <${localName}> (${holderUuid}) has been renamed to <${probe.name}> according to <${holderFrom}>; releasing <${localName}>.`);
        let renamed = this.player_changename(localName, probe.name, null);
        if (renamed !== true) {
            return this.rejectConflict(localName, holder, "write_failed");
        }
        if (holderUuid != null && resolver.visited) resolver.visited.push(holderUuid);
        // 6) 重试：让出名字后本次加入应能正常落库
        resolver.available = false;
        let retry;
        try {
            retry = await this.add(profileName, uuid, from, extra, resolver, depth + 1);
        } finally {
            resolver.available = true;
        }
        if (retry === true) {
            return {
                error: "HOLDER_RENAMED",
                existingName: localName,
                existingFrom: holderFrom,
                newName: probe.name
            };
        }
        return retry;
    }
    /*
     * 玩家落库。profileName/uuid 为上游 hasJoined 返回的权威身份，from 为来源 id。
     * 返回 true 表示成功；返回 { error, ... } 表示被拒绝（由上层翻译成玩家可见提示）。
     */
    this.add = async function (profileName, uuid, from, extra, resolver = null, depth = 0) {
        let indexName = this.lookup_uuid(uuid);
        if (indexName !== undefined && indexName !== profileName) {
            // 该 uuid 在索引里属于另一个名字：上游改名后 uuid 未变的形态，按改名落库
            return this.profileOwningUUID(uuid) === indexName
                ? this.player_changename_at(indexName, profileName, extra, uuid, resolver, depth)
                : this.resolveNameConflict(profileName, uuid, from, extra, indexName, resolver, depth);
        }
        if (indexName === profileName) {
            // 同名同 uuid：玩家已存在，只刷新登录信息
            if (extra && typeof extra === 'object' && extra.lastLogin != null) {
                return this.new_login(profileName, extra.lastLogin, extra.ip);
            }
            return true;
        }
        // 该 uuid 在索引里没有归属
        if (fs.existsSync(this.path + "/" + profileName + ".json")) {
            // 名字已被占用（另一个账号）：属于改名冲突，交由上层按来源规则处理
            return this.resolveNameConflict(profileName, uuid, from, extra, profileName, resolver, depth);
        }
        return this.add_raw(profileName, { "name": profileName, "uuid": uuid, "from": from }, extra);
    }
    // 自动改名落库（带级联上限），供 add 内部使用
    this.player_changename_at = function (originalName, newName, extra, uuid, resolver, depth) {
        depth = depth + 1;
        if (depth >= MAX_RENAME_CHAIN) {
            log(`[RENAME] Chain limit reached while renaming <${originalName}> -> <${newName}>, rejecting.`);
            return Promise.resolve(this.rejectConflict(originalName, this.lookup(originalName), "chain_limit"));
        }
        return Promise.resolve(this.player_changename(originalName, newName, extra));
    }
    this.player_changename = function (original_name, new_name, extra) {
        if (!checkName(original_name) || !checkName(new_name)) return { error: "INVALID_NAME" };
        if (original_name === new_name) return { error: "NAME_UNCHANGED" };
        let data = this.readFile(original_name);
        if (!data) return { error: "PROFILE_NOT_FOUND" };
        let old_names = normalizeOldNames(data['old_names']);
        if (old_names.indexOf(original_name) === -1) old_names.push(original_name);
        data['old_names'] = old_names;
        data['name'] = new_name;
        if (extra && typeof extra === 'object') {
            for (let key of Object.keys(extra)) {
                data[key] = extra[key];
            }
        }
        let uid = data['uuid'];
        // 先落盘新档案，成功后再删旧档案：避免中途失败留下"索引指向不存在文件"的幽灵
        try {
            fs.writeFileSync(this.path + "/" + new_name + ".json", JSON.stringify(data, null, 2));
        } catch (e) {
            console.error(e);
            return { error: "WRITE_FAILED" };
        }
        try {
            fs.rmSync(this.path + "/" + original_name + ".json");
        } catch (e) {
            console.error(e);
            try { fs.rmSync(this.path + "/" + new_name + ".json"); } catch (e2) { console.error(e2); }
            return { error: "WRITE_FAILED" };
        }
        // 释放旧名字：把仍指向旧名的 uuid 键重新指向新名（否则会留下幽灵条目）
        for (let key of Object.keys(this.UUIDCache)) {
            if (this.UUIDCache[key] !== original_name || key === normalizeUUID(uid)) continue;
            if (uid == null) {
                delete this.UUIDCache[key];
            } else {
                this.UUIDCache[key] = new_name;
            }
        }
        if (uid != null) this.cacheUUID(new_name, uid);
        this.deleteMeta(original_name);
        this.setMeta(new_name, data);
        return true;
    }
    this.new_login = function (player, time, ip = "Unknown", data = null) {
        if (!checkName(player)) return false;
        // 调用方已持有解析好的数据时直接复用，避免重复读文件
        let content = (data && typeof data === 'object') ? data : null;
        if (!content) {
            content = this.readFile(player);
            if (!content) return false;
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
            ip: m.ip,
            old_names: normalizeOldNames(m.old_names)
        }));
    }
    // 分页 + 搜索 + 排序列表（走内存索引）；pageSize <= 0 时返回全部
    this.list_players_page = function ({ page = 1, pageSize = 0, search = '', field = 'all', sort = 'name', dir = 1 } = {}) {
        let list = Object.values(this.playersMeta);
        let kw = String(search || '').toLowerCase();
        if (kw) {
            let matchOld = m => normalizeOldNames(m.old_names).some(n => n.toLowerCase().includes(kw));
            list = list.filter(m => {
                let name = String(m.name || '').toLowerCase();
                let uuid = String(m.uuid || '').toLowerCase();
                let from = String(m.from || '').toLowerCase();
                if (field === 'name') return name.includes(kw);
                if (field === 'uuid') return uuid.includes(kw);
                if (field === 'from') return from.includes(kw);
                if (field === 'oldname') return matchOld(m);
                return name.includes(kw) || uuid.includes(kw) || from.includes(kw) || matchOld(m);
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
                ip: m.ip,
                old_names: normalizeOldNames(m.old_names)
            })),
            total
        }
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
        let sources = Object.create(null);
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
            let data = this.readFile(player);
            if (!data) return false;
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
            try {
                this.UUIDCache = toDict(JSON.parse(fs.readFileSync(path + "/a.ud.json")));
            } catch (e) {
                console.error(e);
                this.UUIDCache = newDict();
            }
            if (!this.UUIDCache || typeof this.UUIDCache !== 'object' || Array.isArray(this.UUIDCache)) {
                this.UUIDCache = newDict();
            }
        } else {
            this.UUIDCache = newDict();
        }
        this.playersMeta = Object.create(null);
        // 先清掉指向不存在/不匹配档案的幽灵条目，再按磁盘补齐：顺序反了会把索引清空
        let pruned = this.pruneStaleUUIDEntries();
        this.rebuildUUIDCacheFromFiles(false);
        if (pruned.length > 0) {
            log(`[UUID_CACHE] Pruned ${pruned.length} stale uuid index entr${pruned.length > 1 ? 'ies' : 'y'} for cache path ${this.path}`);
            for (let item of pruned) {
                log(`[UUID_CACHE]   ${item.key} -> ${item.name} (${item.reason})`);
            }
            this.persistUUIDCache();
        }
    } catch (e) {
        console.error(e);
        this.UUIDCache = newDict();
        this.playersMeta = Object.create(null);
        this.rebuildUUIDCacheFromFiles(false);
    }
}
module.exports = {
    class_PlayerCache, checkName, log, MAX_RENAME_CHAIN, normalizeUUID, normalizeOldNames
}
