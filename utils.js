const ConfigControl = require("./config_control.js").ConfigControl;
const fs = require('fs');
const path = require('path');
const LOG_FILE_NAME = "./logs/latest.log";
if (!fs.existsSync("./logs")) {
    fs.mkdirSync("./logs");
}
const globleConfig = new ConfigControl("config.json");
const logNums = parseInt(globleConfig.get("log_remaining_number", 5))
var log_file_stream = null;

try {
    if (logNums > 0 && !isNaN(logNums)) {
        var folders = fs.readdirSync("./logs");
        let deleteCount = 0;
        while ((folders.length - deleteCount) > logNums && (folders.length - deleteCount) > 0) {
            let pathName = "./logs/" + folders[deleteCount];
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
            fs.renameSync(LOG_FILE_NAME, `logs/${year}-${month}-${day}_${hour}-${minute}-${second}.log`);
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