const ConfigControl = require("./config_control.js").ConfigControl;
const fs = require('fs');
const path = require('path');

// 项目根目录（src/ 的上一级），所有运行时路径以根目录为锚，与启动目录无关
const ROOT_DIR = path.join(__dirname, '..');
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE_NAME = path.join(LOGS_DIR, 'latest.log');
const CONFIG_DIR = path.join(ROOT_DIR, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LEGACY_CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR);
}
// 旧版本配置迁移：根目录 config.json → config/config.json（仅当新位置不存在时复制一次）
if (!fs.existsSync(CONFIG_FILE) && fs.existsSync(LEGACY_CONFIG_FILE)) {
    try {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
        fs.copyFileSync(LEGACY_CONFIG_FILE, CONFIG_FILE);
        console.log("[CONFIG] Migrated legacy ./config.json to config/config.json");
    } catch (e) {
        console.error("[CONFIG] Failed to migrate config: " + e.message);
    }
}
if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
const globleConfig = new ConfigControl(CONFIG_FILE);
const logNums = parseInt(globleConfig.get("log_remaining_number", 5))
var log_file_stream = null;

try {
    if (logNums > 0 && !isNaN(logNums)) {
        var folders = fs.readdirSync(LOGS_DIR);
        let deleteCount = 0;
        while ((folders.length - deleteCount) > logNums && (folders.length - deleteCount) > 0) {
            let pathName = path.join(LOGS_DIR, folders[deleteCount]);
            let stat = fs.lstatSync(pathName);
            if (stat.isFile(pathName)) {
                if (path.extname(pathName) == ".log"){
                    console.log(`[!] Deleting superfluous log: ${pathName}`)
                    fs.rmSync(pathName);
                }
            }
            deleteCount++;
        }
        if (fs.existsSync(LOG_FILE_NAME)) {
            let date = new Date();
            let year = date.getFullYear().toString().padStart(4, "0");
            let month = (date.getMonth() + 1).toString().padStart(2, "0");
            let day = date.getDate().toString().padStart(2, "0");
            let hour = date.getHours().toString().padStart(2, "0");
            let minute = date.getMinutes().toString().padStart(2, "0");
            let second = date.getSeconds().toString().padStart(2, "0");
            fs.renameSync(LOG_FILE_NAME, path.join(LOGS_DIR, `${year}-${month}-${day}_${hour}-${minute}-${second}.log`));
        }
        log_file_stream = fs.createWriteStream(LOG_FILE_NAME, {
            flags: 'w', // 写流不能用r，会报错.可以用'a'表示追加
            encoding: 'utf8', // 不写默认是utf8
        });
    }

} catch (e) {
    log_file_stream = null;
    console.error(e);
}
function log(...info) {
    const date = new Date();
    const year = date.getFullYear().toString().padStart(4, "0");
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const hour = date.getHours().toString().padStart(2, "0");
    const minute = date.getMinutes().toString().padStart(2, "0");
    const second = date.getSeconds().toString().padStart(2, "0");

    for (let i = 0; i < info.length; i++) {
        let msg = `${month}-${day} ${hour}:${minute}:${second} - ${info[i]}`;
        console.log(msg);
        try {
            if (log_file_stream != null)
                log_file_stream.write(msg + "\r\n");
        } catch (e) {
            console.error(e);
        }

    }
}
process.on('exit', (code) => {
    if (log_file_stream != null) {
        console.log(`Closing log stream...`);
        log_file_stream.close();
    }
    console.log(`Exit!`);
});
module.exports = {
    log, LOG_FILE_NAME, globleConfig
}