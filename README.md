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
3. 按照下方的详解修改配置文件。
4. 进入项目目录，运行：

```bash
npm install
```

安装成功后，使用 `npm run server` 或者 `node index.js` 启动web服务。

## 配套模组/插件
我们建议使用。它们可以为玩家提供更详细的错误信息而不是最简单的“无法验证用户名”。
- [对于 Fabric 1.21+](https://github.com/wifi-left/mc-multilogin-compat-mod)
- [对于 Velocity 3.0+](https://github.com/wifi-left/mc-multilogin-compat-velocity)

## 配置详解

请按照示例修改 `config.json`。示例在 [config_example.json](./config_example.json)
> 旧版本中错误的JSON文件在启动时会被清空，您可以通过更新最新的提交来解决这个问题。建议您另外备份一份配置文件，避免出现不可挽回的损失。

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
- `skinDomains`: 就是皮肤站 `api/yggdrasil` 的 skinDomains，可以随便改，建议加上所有可能出现的皮肤域名。（比如`littleskin.cn`）
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
- `secret`: 管理API的密钥。调用封禁、查询、修改等管理接口时需要在请求体中携带此密钥。
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

启用 `manage_port` 后，以下管理端点仅在管理端口可用：

- `POST {url}/manage/query/{player}` — 查询玩家缓存（请求体：`{"secret": "..."}`）
- `POST {url}/manage/list` — 列出缓存玩家。**支持服务端分页/搜索/排序**：请求体可带 `page`（页码，默认 1）、`pageSize`（每页条数，不传或 0 时返回全部，向后兼容）、`search`（关键字）、`field`（`all`/`name`/`uuid`/`from`）、`sort`（`name`/`uuid`/`from`/`lastLogin`）、`dir`（1 升序 / -1 降序）。返回 `players`（当前页）、`total`（匹配总数）。列表走内存索引，不逐文件读取
- `POST {url}/manage/stats` — 概览统计（请求体：`{"secret": "..."}`）：返回 `total`、`banned`、`forever`、`temp`、`sourceCount`、`sources`（来源分布）、`recentLogins`、`recentBans`，全部基于内存索引计算
- `POST {url}/manage/export` — 导出全量玩家数据（请求体：`{"secret": "..."}`，返回 `players: [{name, uuid, from, lastLogin}]`），仅在显式导出时使用
- `POST {url}/manage/bans` — 列出当前被封禁玩家及封禁信息（请求体：`{"secret": "..."}`；返回 `name`、`banReason`、`banStart`、`banTime`）
- `POST {url}/manage/modify/{player}` — 修改玩家缓存（请求体：`{"secret": "...", "playerData": {...}}`）
- `POST {url}/manage/delete/{player}` — 删除玩家缓存
- `POST {url}/manage/rebuild-uuid` — 一键按当前玩家缓存文件重建 UUID->玩家名索引表（请求体：`{"secret": "..."}`）
- `POST {url}/manage/batch-delete` — 批量删除玩家缓存（请求体：`{"secret": "...", "players": ["a", "b"]}`）
- `POST {url}/manage/batch-unban` — 批量解除封禁（请求体：`{"secret": "...", "players": ["a", "b"]}`）
- `POST {url}/ban/uuid/{uuid}/{time}` — 按UUID封禁（0=永久，-1=解封，正整数=毫秒时长）
- `POST {url}/ban/name/{name}/{time}` — 按名称封禁

### 管理面板登录

管理面板网页位于 `http://域名:manage_port{manage_url}`（默认 `/manage`），只能通过配置的 `manage_url` 路径访问，根路径不提供跳转。

管理面板**必须先登录才能访问**：

- 未登录访问管理路径时，服务器只返回登录页。
- 登录页选择子配置并输入对应 `secret`，通过校验后服务器下发 httpOnly 会话 Cookie（默认 12 小时有效，勾选"记住我"则 7 天；会话时长可通过 `manage_session_hours` 配置），随后跳转到管理主页面。
- 主页面所有管理接口仍按原有约定在请求体中携带 `secret`（由登录页保存在浏览器当前会话中，关闭浏览器即清除）。
- **多账号**：登录页勾选"保存账号与密码"后，账号（子配置 + 密钥）会保存在浏览器本地（`localStorage`），登录页会列出已保存账号，可一键登录或删除；管理面板顶部的"切换账号"下拉可直接在多个已保存账号之间切换，无需重新输入密钥。"添加新账号"按钮可在面板内直接登录并切换新子配置，与"退出登录"相互独立。
- 点击"退出登录"会清除会话 Cookie 并返回登录页。服务器重启后会话签名密钥变化，已登录会话自动失效，需重新登录。
- 登录接口 `POST {manage_url}/login`（请求体 `{"url": "...", "secret": "...", "remember": true|false}`）与其它管理接口一样受 `manage_rate_limit` 限流保护，防止暴力猜解。
- 安全提示：保存的账号密钥以明文形式存储于本机浏览器，请勿在公共电脑上勾选"保存账号与密码"；管理端口请尽量通过 HTTPS 访问。

所有管理接口都需要在请求体中携带正确密钥 `secret`，密钥比较使用常量时间算法，且每个来源 IP 受 `manage_rate_limit` 限流保护。

### 管理面板安全建议

- 管理端口若无需公网访问，请将 `manage_host` 设为 `127.0.0.1`（代码默认值）并配合 SSH 隧道访问。
- 若需要公网访问，强烈建议将管理端口置于 **HTTPS 反向代理**（如 nginx）之后，或启用 `manage_https_cert` / `manage_https_key` 原生 HTTPS，避免 `secret` 明文传输。
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
| `DUPLICATE_UUID` | UUID 与已有玩家冲突 | ❌ |
| `BANNED_FOREVER` | 玩家已被永久封禁 | ❌ |
| `BANNED` | 玩家已被临时封禁 | ❌ |
| `NOT_FOUND` | 未在任何皮肤站找到该玩家 | ❌ |
| `UNSUPPORTED_SKIN_SITE` | 玩家注册的皮肤站不在支持列表中 | ❌ |
| `FETCH_ERROR` | 连接上游验证服务器失败 | ❌ |

`availableId` 为服务端建议的可用替代玩家名（格式为 `原名_2`、`原名_3` 等），仅在 `DUPLICATE_NAME` 时出现。

### errorMessages 子配置

可在 `config.json` 中添加 `errorMessages` 字段，自定义 `detail=true` 时返回的错误文本。未配置的字段会使用默认中文文本。

支持以下占位符：
- `{from}` — 冲突来源皮肤站 ID
- `{name}` — 冲突玩家名（仅 `DUPLICATE_UUID`）

```json
"errorMessages": {
    "DUPLICATE_NAME": "该玩家名已被来自 \"{from}\" 的账号占用，不允许其他皮肤站的同名玩家登录",
    "DUPLICATE_UUID": "该账号的 UUID 与已有玩家 \"{name}\"（来自 \"{from}\"）冲突",
    "BANNED_FOREVER": "您已被永久封禁",
    "BANNED": "您已被封禁",
    "NOT_FOUND": "玩家未在任何已配置的皮肤站找到",
    "UNSUPPORTED_SKIN_SITE": "该玩家注册的皮肤站不在此服务器支持列表中",
    "FETCH_ERROR": "连接验证服务器失败"
}
```
