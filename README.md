# MC-Multi-Login Service

这是一个用于MC里多皮肤站+正版登录的后台API项目

## Features

1. 拒绝不同皮肤站的同名玩家进入，仅允许使用第一个使用该名字进入游戏的玩家所使用的皮肤站。
   如：玩家 `player` 使用 `original` 登录进入后，它以后若想要进入服务器必须使用 `original` 登录。
2. 封禁玩家登录。在控制台输入 `ban <玩家> <时长（毫秒）>` 即可封禁玩家，不允许他登录。
3. 玩家缓存。玩家信息会缓存到 `cache` 文件夹中。如果想删除某个名字的信息，请删除对应JSON即可，无需重启。此操作可以解决第一个feature中使用错误的方式登录导致后续无法登录的后果。
4. 强制部分玩家使用指定皮肤站登录。
5. 玩家改名跟踪。此特性未经测试，可能存在BUG。
6. `detail=true` 详细错误返回。当请求携带此参数时，登录失败会返回含具体原因的 JSON 错误体（HTTP 403）而非无内容的 204，并在玩家名冲突时附带可用的替代名（`availableId`）。便于配套 Mod 向玩家展示可读的错误提示。
7. 可配置错误文本。通过 `errorMessages` 配置项自定义 `detail=true` 时返回的各类错误信息，支持 `{from}`、`{name}` 等占位符。

## 如何使用

1. 下载 Node.JS（版本至少为`v21.0.0`）并且安装。
2. 下载本项目，并解压。
3. 按照下方的详解修改配置文件（`config/config.json`）。
4. **一键启动**（推荐）：
   - Windows：双击 `start.bat`
   - Linux / macOS：`./start.sh`
   
   脚本会自动完成依赖安装（首次）并启动服务。
   
   也可以手动启动：

```bash
npm install
npm run server
```

## 目录结构

```
├── src/                 # 服务端代码
│   ├── index.js         # 入口（登录 API + 管理 API + 管理面板）
│   ├── playercache.js   # 玩家缓存数据层
│   ├── utils.js         # 日志 / 全局配置
│   └── config_control.js# 配置文件加载器
├── config/              # 配置文件
│   ├── config.json      # 实际配置（含密钥，不提交到仓库）
│   └── config_example.json  # 配置示例
├── web/public/          # 管理面板页面（manage.html / login.html）
├── test/                # 测试脚本（node test/xxx.test.js，无框架依赖）
├── cache/               # 玩家缓存（运行时数据，按子配置分目录）
├── logs/                # 运行日志（运行时数据）
├── start.bat            # Windows 一键启动
└── start.sh             # Linux / macOS 一键启动
```

> 旧版本升级：若根目录下存在旧的 `config.json`，首次启动会自动复制迁移到 `config/config.json`（并输出 `[CONFIG] Migrated` 日志）。之后请以 `config/config.json` 为准。

> 测试：`node test/uuid-index.test.js`（UUID 索引 / 改名冲突）、`node test/manage-auth.test.js`（管理路由鉴权与登录路由可靠性，会在项目内建临时目录并启动真实服务）。

## 配套模组/插件
我们建议使用。它们可以为玩家提供更详细的错误信息而不是最简单的“无法验证用户名”。
- [对于 Fabric 1.21+](https://github.com/wifi-left/mc-multilogin-compat-mod)
- [对于 Velocity 3.0+](https://github.com/wifi-left/mc-multilogin-compat-velocity)

## 配置详解

请按照示例修改 `config/config.json`。示例在 [config/config_example.json](./config/config_example.json)
> 旧版本中错误的JSON文件在启动时会被清空，您可以通过更新最新的提交来解决这个问题。建议您另外备份一份配置文件，避免出现不可挽回的损失。旧版本（根目录 `config.json`）升级到新版本（`config/config.json`）时会自动迁移一次配置。

### 详细解释

- `port`: 如字面意思，端口
- `manage_port`: 管理服务器的端口。若设置此项，管理API（封禁、查询、修改、删除玩家缓存）和管理面板将运行在此独立端口上，与 Minecraft 登录 API 端口分离。**建议设置此项**，避免管理接口暴露到对外的 API 端口。若不设置，管理路由仍挂载在主端口上（向后兼容）。
- `manage_url`: 管理面板网页的访问路径，默认为 `/manage`。例如设置为 `/admin` 后，可通过 `http://域名:manage_port/admin` 访问管理界面。
- `manage_host`: 管理服务器监听的地址，代码默认 `127.0.0.1`（仅本机可访问，最安全）。若需要从外网直接访问管理面板，请显式设置为 `"0.0.0.0"`。
- `manage_rate_limit`: 管理接口限流（每 IP 每分钟允许的请求数，默认 `120`，`0` 关闭）。用于防止暴力猜解 `secret`。批量操作（批量删除/解封）也走该额度，请勿设置过小。
- `public_rate_limit`: 公开登录/皮肤接口（`hasJoined`、profile 查询、bulk 查询）限流（每 IP 每分钟默认 `60`，`0` 关闭）。防止被当作上游代理轰炸或反复触发缓存目录扫描。
- `body_limit_mb`: POST 请求体大小上限（MB，默认 `1`，超限返回 413）。防止超大请求体耗尽内存。
- `manage_trust_proxy`: 仅当管理端口部署在 nginx 等反向代理之后时设为 `true`，服务端将通过 `X-Forwarded-For` 获取真实客户端 IP 用于限流和日志。**直接对外暴露管理端口时请保持 `false`**，否则攻击者可伪造请求头绕过限流。
- `manage_https_cert` / `manage_https_key`: 可选。若不想使用反向代理，可让管理服务器直接启用 HTTPS，两项分别填写证书与私钥文件的路径（相对于项目根目录）。留空则使用 HTTP。**管理端口需要从公网访问时强烈建议启用 HTTPS 或置于 HTTPS 反向代理之后**，否则密钥会以明文在网络上传输。
- `manage_session_hours`: 管理面板登录会话有效时长（小时，默认 `12`）。勾选登录页"记住我"时为 7 天。
- `log_remaining_number`: 历史日志保留个数。如果不想保留请设置为 -1。
- `fetch_timeout`: 登录/皮肤验证时请求上游验证服务器的超时时间（毫秒，默认 `10000`）。防止上游服务器响应缓慢或无响应时阻塞登录请求。
- `skinDomains`: 就是皮肤站 `api/yggdrasil` 的 skinDomains，可以随便改，建议加上所有可能出现的皮肤域名。（比如`littleskin.cn`）。关闭皮肤贴图反代（`skin_proxy: false`）时，该列表也会作为管理面板 CSP `img-src` 的白名单
- `avatar_domains`: 额外的**图片域名白名单**（数组，默认空）。用于私有部署的贴图域名：**只写在 `config/config.json`（已被 `.gitignore` 忽略，不入库），不要写进 `config_example.json`**。每一项可以是纯域名（`cdn.example.com`）或完整 URL（`https://cdn.example.com/x`），支持逗号分隔的字符串写法
- `ban_api`: 是否启用**对外的封禁 API**（`{url}/ban/*`，默认 `false` 关闭）。该接口用请求体 `secret` 鉴权、可被外部脚本直接调用，因此默认不注册为可用；需要外部程序（游戏服插件/自建工具）封禁玩家时设为 `true`。管理面板的封禁功能不受此开关影响，它走登录会话鉴权的 `{url}/manage/ban/*`。
- `skin_proxy`: 是否启用**皮肤贴图反代**（默认 `true`）。启用后管理面板的皮肤/披风图片与 3D 预览都走同源接口 `{manage_url}/skin-proxy`，浏览器不再直连上游贴图域，因此无需把域名写进 CSP；关闭后平面贴图恢复直连（需要 `skinDomains` / `avatar_domains` 放行域名），3D 预览自动停用
- `apis`: API配置。详见[API子配置章节](#API子配置)
- `default`: 如果没有找到玩家数据，默认使用的皮肤站。如 `original` 会使用原版API（预置）。
- `method`: 支持 `authlib-injector` 的路径列表。详见[method子配置章节](#method子配置)
- `push`: 强制列表中的玩家使用指定方式登录。格式示例如下：

```json
{
    "handles": {
        "hypixel": "original",
        "Dream": "littleskin"
    }
}
```

上述示例会要求名叫 `hypixel` 的玩家必须从 `original` 进入，名叫 `Dream` 必须从 `littleskin` 进入。

- `errorMessages`: 自定义 `detail=true` 时返回的错误文本。详见 [errorMessages 子配置章节](#errorMessages-子配置)。此项为可选，不配置时使用内置中文默认文本。
  
### API子配置

- `id`: 此API接口唯一ID，用于保存以及 `method` 的配置。
- `name`: 此API名称，用于在控制台显示。
- `root`: 此API接口地址。建议删除URL末尾的 `/`，不删除可能会导致部分皮肤站出bug。

示例：

- LittleSkin

```json
{
    "id": "littleskin",
    "name": "LittleSkin",
    "root": "https://littleskin.cn/api/yggdrasil"
}
```

- 官方正版登录

```json
{
    "id": "original",
    "name": "Official"
}
```

### method子配置

- `url`: 用于监视的地址。比如使用 `/login` 后，authlib-injector所指向的地址就是 `http://域名:端口/login`
- `name`: 此登录方式的名称，用于缓存目录命名及管理面板显示。
- `secret`: 管理密钥。用于**登录管理面板**，以及对外的封禁机器接口（`{url}/ban/*`，在请求体中携带）。管理面板的 `/manage/*` 接口不使用该密钥，改为校验登录会话，详见下文"管理面板登录"。
- `handles`: 用于推测玩家来源的顺序。如果该玩家没有加入过服务器（也就是没有缓存文件），会按照此列表顺序进行推测。该项目为一个JSON数组，内容为API配置的ID（大小写敏感）。如：

```json
{
    "url": "/login",
    "name": "myserver",
    "secret": "your_secret_key_here",
    "handles": [
        "littleskin",
        "original"
    ]
}
```

该示例会先在littleskin找寻玩家信息，再从original找寻信息。

### 管理API

启用 `manage_port` 后，以下管理端点仅在管理端口可用。

**鉴权方式**（重要）：

- `{url}/manage/*`（面板自用接口）**必须已登录**：请求需携带登录时下发的会话 Cookie（`ml_admin_session`），未登录返回 `401`，会话所属子配置与接口不一致返回 `403`。因此这些接口**不需要**在请求体中携带 `secret`。
- 管理接口**只接受 POST**：用浏览器地址栏直接访问（GET）会返回 `405 Method Not Allowed`（带 `Allow: POST` 与提示），不会落到 404 兜底；未知路径返回真正的 HTTP `404`。
- `{url}/ban/*`（对外机器接口，供游戏服插件调用）使用**请求体中的 `secret`** 鉴权（常量时间比较），且**默认关闭**，需配置 `ban_api: true` 才可用。管理面板不使用该接口（面板的封禁走 `/manage/ban/*`）。
- 会话 Cookie 为 `HttpOnly; SameSite=Lax`；请求若带 `Origin` 头，必须与当前 Host 同源，跨站请求一律 `403`（CSRF 纵深防御）。

脚本调用 `/manage/*` 时需先登录拿 Cookie，例如：

```bash
# 1. 登录并保存 Cookie
curl -c cookie.txt -X POST 'http://127.0.0.1:25601/manage/login' \
     -H 'Content-Type: application/json' \
     -d '{"url":"/login/my","secret":"你的密钥"}'

# 2. 之后用 Cookie 调用管理接口（请求体里不需要 secret）
curl -b cookie.txt -X POST 'http://127.0.0.1:25601/login/my/manage/list' \
     -H 'Content-Type: application/json' -d '{"page":1,"pageSize":20}'
```

- `POST {url}/manage/query/{player}` — 查询玩家缓存（请求体可留空 `{}`）
- `POST {url}/manage/player-info/{query}` — **查询角色真实信息**（请求体：`{"from": "可选来源id"}`）。`query` 支持玩家名或 UUID（32 位，可带横线）。解析顺序为**本地缓存记录的来源 → 所选子配置的 `handles` 顺序**（可用 `from` 显式指定来源）。返回 `name`、`uuid`、`resolvedFrom`/`fromName`、`lookupChain`（各来源命中情况）、`textures`（`skin.url`/`skin.model`/`cape.url`，已把 http 贴图地址升级为 https）、`history`（曾用名链）、`cache`（本地档案）、`warnings`。结果缓存 60 秒，避免反复打上游。错误：`PLAYER_NOT_FOUND`（404）、`SOURCE_UNSUPPORTED`（400）
- `POST {url}/manage/names/{query}` — **曾用名反查（改名搜索追踪）**（请求体可留空）。返回 `matches`（以该名字作为曾用名的档案，含当前名、uuid、来源、`old_names`、`oldest` 最早记录名、`history`）与 `currentNameOwner`（该名字是否本身是个在用档案）
- `POST {url}/manage/avatar/{player}` — 返回本地档案解析出的贴图元信息与 `allowedImgSrc` / `allowedImgHosts`（当前图片白名单），便于面板排查图片加载失败（请求体可留空）
- `GET {manage_url}/skin-proxy?url={贴图地址}` — **皮肤贴图反代**（需携带有效管理会话 Cookie；不再支持 `?secret=` 查询串，避免密钥进入日志与浏览器历史）。仅接受 `https`、且主机必须在白名单内（`skinDomains` / `apis[].root` / `avatar_domains` / Mojang 官方贴图域），只回传图片（PNG/JPEG/GIF/WEBP，解压后 ≤4MB），响应头带 `Content-Security-Policy: sandbox`。可用 `skin_proxy: false` 整体关闭
- `POST {url}/manage/list` — 列出缓存玩家。**支持服务端分页/搜索/排序**：请求体可带 `page`（页码，默认 1）、`pageSize`（每页条数，不传或 0 时返回全部，向后兼容）、`search`（关键字）、`field`（`all`/`name`/`uuid`/`from`/`oldname`）、`sort`（`name`/`uuid`/`from`/`lastLogin`）、`dir`（1 升序 / -1 降序）。返回 `players`（当前页）、`total`（匹配总数）。列表走内存索引，不逐文件读取。`field=oldname` 仅在曾用名中搜索，`all` 时也会匹配曾用名
- `POST {url}/manage/stats` — 概览统计（请求体可留空）：返回 `total`、`banned`、`forever`、`temp`、`sourceCount`、`sources`（来源分布）、`recentLogins`、`recentBans`，全部基于内存索引计算
- `POST {url}/manage/export` — 导出全量玩家数据（请求体可留空，返回 `players: [{name, uuid, from, lastLogin}]`），仅在显式导出时使用
- `POST {url}/manage/bans` — 列出当前被封禁玩家及封禁信息（请求体可留空；返回 `name`、`banReason`、`banStart`、`banTime`）
- `POST {url}/manage/modify/{player}` — 修改玩家缓存（请求体：`{"playerData": {...}}`）
- `POST {url}/manage/delete/{player}` — 删除玩家缓存
- `POST {url}/manage/rebuild-uuid` — 按当前玩家缓存文件重建 UUID->玩家名索引表（请求体可留空），返回 `count`（重建后索引项）与 `dropped`（被丢弃的幽灵条目数）
- `POST {url}/manage/check-uuid` — **UUID 索引体检 / 修复**（请求体：`{"fix": false}`）。返回 `stale`（幽灵条目：索引指向不存在或不匹配的档案）、`duplicate`（多份档案宣称同一 uuid）、`missing`（有档案但索引缺失）、`nameConflicts`（曾用名同时是另一个账号的当前名）及各自计数。`fix: true` 时执行清理与重指向（会先把 `a.ud.json` 备份为 `a.ud.json.bak`）；重复 uuid 的条目会被清空索引，交由人工确认归属
- `POST {url}/manage/batch-delete` — 批量删除玩家缓存（请求体：`{"players": ["a", "b"]}`）
- `POST {url}/manage/batch-unban` — 批量解除封禁（请求体：`{"players": ["a", "b"]}`）
- `POST {url}/manage/ban/{target}/{time}` — **封禁 / 解封玩家**（管理面板封禁管理页使用，需登录）。`target` 为玩家名或 UUID（32 位可带横线，按形态自动识别，也可在请求体用 `type: "name"|"uuid"` 显式指定）；`time` 为 `0`（永久）/ `-1`（解封）/ 正整数（毫秒时长）。请求体可选 `{"reason": "..."}`。返回 `{success, player, time, desc}`；目标不在当前子配置缓存中时返回 `404`
- `GET /api/sources` — 管理面板用（**需登录**）：列出所有来源及各子配置可用的来源（用于"角色信息查询"的来源下拉）
- `POST {url}/ban/uuid/{uuid}/{time}` — 按UUID封禁（0=永久，-1=解封，正整数=毫秒时长）。请求体需带 `{"secret": "..."}`。**默认关闭**，需配置 `ban_api: true`；未启用时返回 `403`
- `POST {url}/ban/name/{name}/{time}` — 按名称封禁（同样在请求体中携带 `secret`，同样受 `ban_api` 开关控制）

### 管理面板：标签页与角色信息

管理面板的功能按标签页拆开，互不干扰：

- **🔍 缓存查询**：只读本地档案（`/manage/query`），**不会访问任何上游**；页面打开与切换都不会触发远程请求。
- **🌐 远程信息**：**必须手动点击"查询远程信息"** 才会向配置的来源发起请求。返回当前名称、UUID、解析/档案来源、皮肤模型（classic/slim）、披风、查询链、曾用名与最早记录名、最后登录、封禁状态、IP，并渲染皮肤与披风。
- **🕓 曾用名追踪**：用历史用户名反查档案（`/manage/names`）。结果分两部分并列展示，两部分可能同时出现：
  - **① 曾用名命中**：把所有以该名字作为曾用名的档案**全部列出**（可能多个）；
  - **② 当前正在使用该名字的账号**：该名字本身若也是个在用档案，同样列出。
  每张卡片都会画出**更名流程图**（按时间顺序 `最早记录名 → … → 当前名`，并给最早名、"查询名"、当前名分别打标），以及该档案的 UUID、来源、曾用名清单、最后登录。卡片按钮可直接跳转：「查询当前信息（本地缓存）」跳到缓存查询页读取本地档案（不访问上游）、「查看该档案完整信息」跳到远程信息页手动查询、「追踪该档案的曾用名」以该档案当前名继续反查。玩家列表的搜索框也支持"曾用名"维度。
- **♻ 检查/修复 UUID 表**（玩家列表与概览页按钮）：先体检并列出幽灵条目、重复 uuid、缺失映射，再按需一键修复。

关于皮肤/披风渲染：

- 默认走**同源反代**（`skin_proxy: true`）：贴图由服务端代理下发，管理页 CSP 的 `img-src` 保持 `'self' data: blob:`，浏览器不直连上游贴图域。
- 关闭反代（`skin_proxy: false`）后：平面贴图恢复浏览器直连，需要把该贴图域名加入 `skinDomains` 或 `avatar_domains`（管理页 CSP 会按白名单生成 `img-src`）；**3D 预览会自动停用**（WebGL 需要可跨站引用的贴图），面板会给出相应提示。
- `avatar_domains` 是私有配置项：**只写在 `config/config.json`**（该文件已被 `.gitignore` 忽略，不会提交到 git），示例配置里只保留一个空数组占位。
- 面板上的每个 3D 预览（皮肤 / 披风）互相独立：可拖拽旋转、滚轮缩放，工具栏提供「锁定正面 / 复位视角 / 暂停旋转」，皮肤预览另有动作下拉（站立 / 行走 / 奔跑 / 游泳 / 飞行 / 下蹲 / 受击 / 静止）。每次重新查询都会先释放上一批预览（含 WebGL 上下文），隐藏标签页里的预览会暂停渲染，不会空耗 GPU。
- 排查 3D 预览问题：浏览器控制台执行 `MCViewer.diagnose()`，会逐个列出预览的状态（`paused` 渲染循环是否暂停、`contextLost` 上下文是否丢失、`error` 贴图加载失败原因、`animation`/`locked`/`spin` 面板按钮是否作用到了预览上）；`MCViewer.liveCount()` 是当前存活的预览数量（正常应等于页面上显示的预览个数）。

### 3D 预览脚本（three.js + skinview3d）

3D 预览使用与 LittleSkin / Blessing Skin 相同的技术栈，产物是 `web/public/vendor/mcviewer.js`，**已随仓库提交**，因此部署时不需要构建、不依赖 CDN，也不需要 `npm install` 任何前端依赖。

- 产物 = `skinview3d` 官方自包含 UMD 包（`bundles/skinview3d.bundle.js`，已内置 three.js） + 本项目的适配层 `src/vendor/mcviewer.js`
- 重新生成：`node vendor/build.mjs`（本地没有 `vendor/skinview3d.bundle.js` 时会从 jsDelivr 下载固定版本并缓存到该路径，之后可离线构建）
- 供应链校验：构建脚本内联了固定版本的 SHA-256，包内容对不上会**中止构建**并打印实际哈希；升级版本时依次更新脚本里的 `PINNED_VERSION` 与 `PINNED_SHA256`（用 `node vendor/build.mjs --print-hash` 取新哈希），然后重新构建并在管理页确认预览正常
- 许可：`skinview3d` 与 `three.js` 均为 MIT，产物头部保留了来源与版本信息
- 改了 `src/vendor/mcviewer.js` 之后必须重新构建，否则面板加载的仍是旧产物


### 管理面板登录

管理面板网页位于 `http://域名:manage_port{manage_url}`（默认 `/manage`），只能通过配置的 `manage_url` 路径访问，根路径不提供跳转。

管理面板**必须先登录才能访问**：

- 未登录访问管理路径时，服务器只返回登录页；登录后才会返回管理主页面。
- 登录页选择子配置并输入对应 `secret`，通过校验后服务器下发 httpOnly 会话 Cookie（默认 12 小时有效，勾选"记住我"则 7 天；会话时长可通过 `manage_session_hours` 配置），随后跳转到管理主页面。
- **管理接口全部要求登录**：`{url}/manage/*` 一律校验会话 Cookie，未登录 `401`；会话还与登录时的子配置绑定，用 A 子配置的会话访问 B 子配置的接口返回 `403`。密钥只在登录（及"切换账号"）时使用，不再随每个请求发送。
- 会话 Cookie 为 `HttpOnly; SameSite=Lax`，且带 `Origin` 头的请求必须与当前 Host 同源（否则 `403`），避免跨站请求借用会话执行操作。
- **多账号**：登录页勾选"保存账号与密码"后，账号（子配置 + 密钥）会保存在浏览器本地（`localStorage`），登录页会列出已保存账号，可一键登录或删除；管理面板顶部的"切换账号"下拉可直接在多个已保存账号之间切换，无需重新输入密钥。"添加新账号"按钮可在面板内直接登录并切换新子配置，与"退出登录"相互独立。
- 点击"退出登录"会清除会话 Cookie 并返回登录页。服务器重启后会话签名密钥变化，已登录会话自动失效，需重新登录。
- 登录接口 `POST {manage_url}/login`（请求体 `{"url": "...", "secret": "...", "remember": true|false}`）与其它管理接口一样受 `manage_rate_limit` 限流保护，防止暴力猜解。
- 安全提示：保存的账号密钥以明文形式存储于本机浏览器，请勿在公共电脑上勾选"保存账号与密码"；管理端口请尽量通过 HTTPS 访问。

`{url}/manage/*` 需要有效登录会话（会话令牌由服务端密钥签名，重启即失效）；`{url}/ban/*` 需要请求体中的正确密钥，密钥比较使用常量时间算法；两类接口都受 `manage_rate_limit` 限流保护。未配置 `manage_port` 时管理路由会挂在对外登录端口上，服务启动时会打印 `[WARN]` 提示。

### 管理面板安全建议

- 管理端口若无需公网访问，请将 `manage_host` 设为 `127.0.0.1`（代码默认值）并配合 SSH 隧道访问。
- 若需要公网访问，强烈建议将管理端口置于 **HTTPS 反向代理**（如 nginx）之后，或启用 `manage_https_cert` / `manage_https_key` 原生 HTTPS，避免 `secret` 明文传输。
- **反向代理注意**：管理接口会做跨站校验（浏览器发来的 `Sec-Fetch-Site` 必须为 `same-origin`；老浏览器退回 `Origin` 与 `Host` 比对）。nginx 默认会在 `proxy_pass` 时把 `Host` 改写成上游地址，若使用老浏览器或代理链路上丢失了 `Sec-Fetch-Site`，请二选一：
  - 在代理里保留原始 Host：`proxy_set_header Host $host;`（推荐）
  - 或开启 `manage_trust_proxy: true`，让服务端也接受 `X-Forwarded-Host` 的比对（仅在管理端口确实位于可信代理之后时开启）
  被拒绝时服务端会打印 `[MANAGE] Rejected cross-site request ... (Origin: ... Host: ... Sec-Fetch-Site: ...)` 到日志，可按其中取值定位。
- 使用足够长且随机的 `secret`，不要使用示例中的 `your_secret_key_here`。
- 管理面板中，密钥默认仅保存在当前会话（`sessionStorage`），关闭页面即清除；勾选"记住密钥"后才会保存在本地存储中。请勿在公共电脑上勾选。
- 管理面板所有动态内容均经过转义处理，防止来自玩家数据的 XSS 注入；管理接口也均设置了防点击劫持（`X-Frame-Options`）、CSP（`frame-ancestors 'none'`）等安全响应头。

### detail 错误详情参数

在 `hasJoined` 请求中携带 `detail=true` 查询参数（由配套 Mod 发送），服务端会在登录失败时返回 **HTTP 403** 及 JSON 错误体，而非标准的 HTTP 204（无正文）。

**示例请求（Mod 侧）：**
```
GET /sessionserver/session/minecraft/hasJoined?username=Steve&serverId=xxx&detail=true
```

**错误响应格式：**
```json
{
    "error": "ForbiddenOperationException",
    "errorMessage": "该玩家名已被来自 \"littleskin\" 的账号占用，不允许其他皮肤站的同名玩家登录",
    "cause": "DUPLICATE_NAME",
    "availableId": "Steve_2"
}
```

| `cause` 值 | 含义 | 是否含 `availableId` |
|---|---|---|
| `DUPLICATE_NAME` | 玩家名已被其他皮肤站占用 | ✅ |
| `DUPLICATE_UUID` | UUID 与已有玩家冲突（历史原因保留，正常情况下不再出现） | ❌ |
| `NAME_TAKEN` | 目标玩家名已被同来源账号占用，且该账号当前仍使用此名称 | ❌ |
| `NAME_TAKEN_OTHER_SOURCE` | 目标玩家名被**其他来源**的账号占用，来源不同无法自动改名 | ❌ |
| `NAME_UNCHANGED` | 目标玩家名仍由原账号持有，无法为你让位 | ❌ |
| `NAME_LOOKUP_FAILED` | 无法确认名字持有者在来源侧的当前名称（查询失败/级联超限） | ❌ |
| `HOLDER_RENAMED` | 原持有者已改名，服务端已自动为其更新档案（登录成功） | ❌ |
| `HOLDER_REMOVED` | 原持有者账号已不存在，服务端已移除其历史档案（登录成功） | ❌ |
| `BANNED_FOREVER` | 玩家已被永久封禁 | ❌ |
| `BANNED` | 玩家已被临时封禁 | ❌ |
| `NOT_FOUND` | 未在任何皮肤站找到该玩家 | ❌ |
| `UNSUPPORTED_SKIN_SITE` | 玩家注册的皮肤站不在支持列表中 | ❌ |
| `FETCH_ERROR` | 连接上游验证服务器失败 | ❌ |

`availableId` 为服务端建议的可用替代玩家名（格式为 `原名_2`、`原名_3` 等），仅在 `DUPLICATE_NAME` 时出现。

### 改名与 UUID 索引的工作方式

- **磁盘档案是唯一权威**：`cache/<子配置>/*.json` 为玩家档案，`cache/<子配置>/a.ud.json` 只是 uuid → 玩家名的**派生索引**。
- 每次按 uuid 查找都会回磁盘校验：命中索引后确认对应档案存在、且档案里的 uuid 与查询 uuid 一致；不一致（幽灵条目）会立即丢弃并重新扫描目录。服务启动时也会对索引做一次全量清理，因此手工改名/删除档案不会再把玩家永久挡在门外。
- 玩家在上游改名（uuid 不变）时，登录会**自动改名**：档案改名为新名字，旧名字写入 `old_names`（曾用名，可被管理面板搜索与追踪），uuid 与封禁信息保持不变。
- 目标玩家名被他人占用时按来源判定：
  1. 占用者档案的来源与本次登录来源**不同** → 直接拒绝（`NAME_TAKEN_OTHER_SOURCE`），不查询上游；
  2. 来源相同 → 用**该来源**的接口查询占用者 uuid 当前的名字：
     - 查询不到该账号 → 视为已注销，移除其历史档案并让位（`HOLDER_REMOVED`）；
     - 仍是原名字 → 拒绝（`NAME_UNCHANGED`）；
     - 已改为新名字 → 先把占用者档案改成新名字，再让本次登录落库（`HOLDER_RENAMED`）。
- **防递归/防死循环**：以上改名级联最多 `MAX_RENAME_CHAIN = 3` 层；同一次登录中处理过的 uuid 会记录在案，再次出现立即终止；上游查询失败不重试、不递归。

### errorMessages 子配置

可在 `config/config.json` 中添加 `errorMessages` 字段，自定义 `detail=true` 时返回的错误文本。未配置的字段会使用默认中文文本。

支持以下占位符：
- `{from}` — 冲突来源皮肤站 ID
- `{name}` — 冲突玩家名（`DUPLICATE_UUID`、`NAME_TAKEN*`、`NAME_UNCHANGED`、`NAME_LOOKUP_FAILED`、`HOLDER_RENAMED`、`HOLDER_REMOVED`）
- `{newName}` — 原持有者改名后的新名字（仅 `HOLDER_RENAMED`）

```json
"errorMessages": {
    "DUPLICATE_NAME": "该玩家名已被来自 \"{from}\" 的账号占用，不允许其他皮肤站的同名玩家登录",
    "DUPLICATE_UUID": "该账号的 UUID 与已有玩家 \"{name}\"（来自 \"{from}\"）冲突",
    "NAME_TAKEN": "玩家名 \"{name}\" 已被来自 \"{from}\" 的账号占用，且该账号当前仍使用此名称",
    "NAME_TAKEN_OTHER_SOURCE": "玩家名 \"{name}\" 已被来自 \"{from}\" 的账号占用，来源不同无法自动改名",
    "NAME_UNCHANGED": "玩家名 \"{name}\" 仍由该账号（来自 \"{from}\"）持有，无法为你改名，请更换名称",
    "NAME_LOOKUP_FAILED": "无法确认玩家名 \"{name}\" 持有者的当前名称（来源 \"{from}\" 查询失败），请稍后再试或更换名称",
    "HOLDER_RENAMED": "玩家名 \"{name}\" 的原持有者已改名为 \"{newName}\"，已自动为其更新档案",
    "HOLDER_REMOVED": "玩家名 \"{name}\" 的原持有者账号已不存在，已移除其历史档案",
    "BANNED_FOREVER": "您已被永久封禁",
    "BANNED": "您已被封禁",
    "NOT_FOUND": "玩家未在任何已配置的皮肤站找到",
    "UNSUPPORTED_SKIN_SITE": "该玩家注册的皮肤站不在此服务器支持列表中",
    "FETCH_ERROR": "连接验证服务器失败"
}
```
