const fs = require('fs');

function ConfigControl(filename) {
    this.filename = filename ? filename : "config.json";
    this.config = {};
    this.reload = function() {
        return this.load();
    }
    this.load = function () {
        try {
            this.config = JSON.parse(fs.readFileSync(filename));
        } catch (e) {
            // config = {}
            try {
                fs.writeFileSync(filename, JSON.stringify(this.config));
            } catch (e) {
                console.error(e);
                return false;
            }
        }
        return true;
    }
    this.get = function (key, fallbackstr) {
        if (this.config[key] != undefined) {
            return this.config[key];
        } else {
            return fallbackstr;
        }
    }
    this.set = function (key, value) {
        this.config[key] = value;
        return this.save();
    }
    this.save = function () {
        try {
            fs.writeFileSync("./config/" + filename, JSON.stringify(this.config));
        } catch (e) {
            // config = {}
            return false;
        }
        return true;
    }
    this.load();
}

module.exports = {
    ConfigControl
}