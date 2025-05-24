# MC-Multi-Login Service
这是一个用于MC里多皮肤站+正版登录的后台API项目

# Features
1. 拒绝不同皮肤站的同名玩家进入，仅允许使用第一个使用该名字进入游戏的玩家所使用的皮肤站。
   如：玩家 `player` 使用 `original` 登录进入后，它以后若想要进入服务器必须使用 `original` 登录。
2. 封禁玩家登录。在控制台输入 `ban <玩家> <时长（毫秒）>` 即可封禁玩家，不允许他登录。
3. 玩家缓存。玩家信息会缓存到 `cache` 文件夹中。如果想删除某个名字的信息，请删除对应JSON即可，无需重启。此操作可以解决第一个feature中使用错误的方式登录导致后续无法登录的后果。
4. 强制部分玩家使用指定皮肤站登录。
5. 玩家改名跟踪。此特性未经测试，可能存在BUG。
 
# 如何使用
1. 下载 Node.JS 并且安装。
2. 下载本项目，并解压。
3. 按照下方的详解修改配置文件。
4. 进入项目目录，使用 `npm run login-server` 或者 `node login.js` 启动web服务。

# 配置详解
请按照示例修改 `config.json`。示例在 [config_example.json](./config_example.json)
> 错误的JSON文件在启动时会被清空，可使用config_example.json作为备份。

## 详细解释
- `port`: 如字面意思，端口
- `log_remaining_number`: 历史日志保留个数。如果不想保留请设置为 -1。
-  `skinDomains`: 就是皮肤站 `api/yggdrasil` 的 skinDomains，可以随便改，建议加上所有可能出现的皮肤域名。（比如`littleskin.cn`）
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
  
## API子配置
- `id`: 此API接口唯一ID，用于保存以及 `method` 的配置。
- `name`: 此API名称，用于在控制台显示。
- `root`: 此API接口地址。建议删除URL末尾的 `/`，不删除可能会导致部分皮肤站出bug。

示例：
1. LittleSkin
```json
{
    "id": "littleskin",
    "name": "LittleSkin",
    "root": "https://littleskin.cn/api/yggdrasil"
}
```
2. 官方正版登录
```json
{
    "id": "original",
    "name": "Official"
}
```

## method子配置
- `url`: 用于监视的地址。比如使用 `/login` 后，authlib-injector所指向的地址就是 `http://域名:端口/login`
- `handles`: 用于推测玩家来源的顺序。如果该玩家没有加入过服务器（也就是没有缓存文件），会按照此列表顺序进行推测。该项目为一个JSON数组，内容为API配置的ID大小写敏感）。如：
```json
{
    "url": "/login",
    "handles": [
        "littleskin",
        "original"
    ]
}
```
该示例会先在littleskin找寻玩家信息，再从original找寻信息。
