#!/usr/bin/env node

var fs = require("fs"),
    path = require("path"),
    jsop = require("jsop"),
    columnify = require('columnify'),
    colors = require('colors'),
    path = require('path'),
    recursive = require('recursive-readdir'),
    request = require("request"),
    cheerio = require("cheerio"),
    readline = require('readline'),
    compareVersion = require('compare-version'),
    config = jsop(".gradver"),
    dps = 0,
    files = [],
    logs = {};

if (process.argv.length > 2 && process.argv[2] == 'init')
    init();
else
    run();

function ignoreFunc(file, stats) {
    var name = path.basename(file);
    var exclude = ["out", "src", "build", ".idea", ".gradle"];
    var isDirectory = fs.lstatSync(file).isDirectory();
    return isDirectory && exclude.indexOf(name) >= 0 || !isDirectory && (name.split(".")[1] != "gradle" || name == "settings.gradle");
}

function init() {

    console.log("\n Gradver v. 1.1 - Configuration".yellow.bold);

    askInit("find build.gradle ? (Y/n)", function(res) {
        if (!res || res == "Y" || res == "y")
            findBuilds(function() {
                continueAsk();
            });
        else
            continueAsk();
    });
}

function continueAsk() {
    askInit("show already updated dependencies ? (Y/n) ", function(res) {
        config.showupdated = !res || res == "Y" || res == "y";
        askInit("VersionEye Api Key ? ", function(res) {
            config.versioneye_api_key = res;
            console.log("\n   " + "config file generated".green.bold);
        });

    });
}

function findBuilds(cb) {
    recursive(process.cwd(), [ignoreFunc], function(err, files) {
        config.files = files;
        cb();
    });
}

function askInit(ask, cb) {

    var rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    rl.question("\n + " + ask + " ", function(answer) {
        rl.close();
        cb(answer);
    });

}

function run() {

    files = config.files;

    if (files == undefined) {
        console.log("\n " + "> run 'gradver init' to configure your project!".bgRed.white.bold);
        return;
    }

    dps = files.length;

    for (var i in files)
        getDependencies(files[i], function() {
            update(0);
        });
}

function getDependencies(file, cb) {

    try {
        build = fs.readFileSync(file, {
            enconding: "utf-8"
        });
    } catch (ignored) {
        dps--;
        return;
    }

    var dependencies = [],
        match = /dependencies\s*{([\S\s]*)}/g.exec(build);

    if (match && match.length > 0) {

        match = match[1].split("\r\n");

        match = match.filter(function(n) {
            return /compile\s*\(?'.*'\)?/.test(n);
        });

        var size = match.length;

        if (size == 0)
            dps--;

        for (var j in match) {
            maven(file, parse(match[j]), function() {
                if (--size <= 0) {
                    print(file);
                    if (--dps <= 0)
                        cb();
                }
            });
        }
    } else
        dps--;

}

// extract info about dependencie
function parse(item) {
    var matches = /'(.*):(.*):([^@\n]*)@?(.*)'/.exec(item);
    return {
        package: matches[1],
        name: matches[2],
        version: matches[3],
        original: matches[1] + ":" + matches[2],
        item: item
    };
}

/*
 *    VERIFY VERSION
 */

// maven
function maven(file, dep, cb) {
    var url = "http://mvnrepository.com/artifact/" + encodeURIComponent(dep.package) + "/" + encodeURIComponent(dep.name) + "/" + dep.version;;
    request(url, function(err, res, body) {
        if (!err && res.statusCode == 200) {
            var $ = cheerio.load(body);
            var newVersion = $("th:contains('New Version')").first();
            notify(file, dep, newVersion != undefined ? newVersion.next().text() : null);
            cb();
        } else
            github(file, dep, cb);
    });
}

// github
function github(file, dep, cb) {

    var match = /github\.([^.:]*)(?:\.|:)([^:]*).*:([\d\.]+)/.exec(dep.item);

    if (dep.package.indexOf("github") >= 0 && match && match.length > 2) {

        dep.package = "com.github." + match[1];
        dep.name = match[2];
        dep.version = match[3];

        options = {
            url: "https://api.github.com/repos/" + match[1] + "/" + match[2] + "/releases/latest",
            headers: {
                "User-Agent": "Awesome-Octocat-App"
            }
        };

        request(options, function(err, res, body) {
            if (!err && res.statusCode == 200) {
                var json = JSON.parse(body);
                notify(file, dep, json.tag_name);
            }
            cb();
        });

    } else
        versioneye(file, dep, cb);
}

function versioneye(file, dep, cb) {
    if (config.versioneye_api_key != "")
        request("https://www.versioneye.com/api/v2/products/search/" + dep.name + "?lang=java&api_key=" + config.versioneye_api_key, function(err, res, body) {
            if (!err && res.statusCode == 200) {
                var json = JSON.parse(body);

                var items = json.results;
                var lastRelease = null;

                for (var i = 0; i < items.length; i++)
                    if (items[i].prod_key == (dep.package + "/" + dep.name)) {
                        lastRelease = items[i].version;
                        break;
                    }

                notify(file, dep, lastRelease);
            }
            cb();
        });
    else
        cb();
}

function notify(file, dep, last) {

    if (logs[file] == undefined)
        logs[file] = [];

    dep.last = last;
    dep.updated = !last || compareVersion(dep.version, last) >= 0;

    if (config.showupdated || !dep.updated)
        logs[file].push(dep);

}

function shouldBeUpdated(i) {
    var list = logs[files[i]];
    for (var i = 0; i < list.length; i++)
        if (!list[i].updated)
            return true;
    return false;
}

function clear(file) {
    return file.replace(process.cwd(), "");
}

function update(i) {

    var list = logs[files[i]];

    if (list && list.length > 0 && shouldBeUpdated(i)) {

        var rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log("");

        for (var j = 0; j < process.stdout.columns / 2; j++)
            process.stdout.write("--");

        rl.question("\n + Want to update dependencies ? " + clear(files[i]).green + " (Y/n) ", function(answer) {

            if (!answer || answer == "y" || answer == "Y") {
                replace(files[i]);
                console.log("\n   " + "updated".bgGreen);
            } else
                console.log("\n   " + "not updated".bgRed);

            rl.close();

            if (++i < files.length)
                update(i);

        });

    } else if (++i < files.length)
        update(i);
}

function replace(file) {

    var list = logs[file];

    list = list.filter(function(n) {
        return !n.updated;
    });

    var content = fs.readFileSync(file, {
        enconding: "utf-8"
    }).toString();

    for (var i = 0; i < list.length; i++) {

        var item = list[i],
            original = item.package + ":" + item.name,
            updated = original + ":" + item.last;

        content = content.replace(original + ":" + item.version, updated);

    }

    fs.writeFileSync(file, content, {
        enconding: "utf-8"
    });

}

function print(file) {

    var list = logs[file];

    if (list && list.length > 0) {

        list.sort(function(first, second) {
            return first.updated === second.updated ? 0 : first.updated ? 1 : -1;
        });

        console.log(("\n + " + clear(file)).yellow.bold + "\n");

        var data = {};

        for (var i = 0; i < list.length; i++) {
            var dep = list[i];
            var key = (dep.updated ? " + ".green.bold : " - ".red.bold) + dep.original;
            data[key] = dep.updated ? dep.version.green.bold : dep.version.red.bold + "   " + dep.last.yellow.bold;
        }

        console.log(columnify(data, {
            columnSplitter: '  ',
            showHeaders: false
        }));

    }
}
