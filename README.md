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

1. 下载 Node.JS 并且安装。
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
- `log_remaining_number`: 历史日志保留个数。如果不想保留请设置为 -1。
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
- `POST {url}/manage/list` — 列出所有缓存玩家
- `POST {url}/manage/bans` — 列出当前被封禁玩家及封禁信息（请求体：`{"secret": "..."}`；返回 `name`、`banReason`、`banStart`、`banTime`）
- `POST {url}/manage/modify/{player}` — 修改玩家缓存（请求体：`{"secret": "...", "playerData": {...}}`）
- `POST {url}/manage/delete/{player}` — 删除玩家缓存
- `POST {url}/manage/rebuild-uuid` — 一键按当前玩家缓存文件重建 UUID->玩家名索引表（请求体：`{"secret": "..."}`）
- `POST {url}/ban/uuid/{uuid}/{time}` — 按UUID封禁（0=永久，-1=解封，正整数=毫秒时长）
- `POST {url}/ban/name/{name}/{time}` — 按名称封禁

管理面板网页：`http://域名:manage_port{manage_url}`（默认 `/manage`）

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
