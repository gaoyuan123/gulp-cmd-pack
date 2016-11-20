var through = require('through2');
var path = require('path');
var fs = require('fs');
var gutil = require('gulp-util');
var uglify = require('uglify-js');
var File = gutil.File;

var PLUGIN_NAME = 'gulp-cmd-pack';


var REQUIRE_RE = /"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\/\*[\S\s]*?\*\/|\/(?:\\\/|[^\/\r\n])+\/(?=[^\/])|\/\/.*|\.\s*require|(?:^|[^$])\brequire\s*\(\s*(["'])(.+?)\1\s*\)/g
var ASYNC_REQUIRE_RE = /"(?:\\"|[ ^"])*"|'(?:\\'|[^'])*'|\/\*[\S\s]*?\*\/|\/(?:\\\/|[^\/\r\n])+\/(?=[^\/])|\/\/.*|\.\s*require|(?:^|[^$])\brequire\.async\s*\(\s*((["'])(.+?)\2)\s*(?:\)|,)|(?:^|[^$])\brequire\.async\s*\(\s*(\[(\s*(["'])(.+?)\6\s*,?\s*)+\])\s*(?:\)|,)/g
var SLASH_RE = /\\\\/g

var sepReg = /\\/g;

var modcache = {};

var depsMap = {};

var asyncDepsMap = {};

var moduleContentMap = {};

module.exports = function (option) {

    option = option || {};
    option.alias = option.alias || {};
    option.ignore = option.ignore || [];
    option.encoding = option.encoding || 'UTF-8';
    option.cache = {};

    if (option.base) {
        option.base = path.normalize(path.resolve(option.base, '.') + path.sep);
    }

    return through.obj(function (file, encoding, cb) {
		var _self = this;
        if (file.isNull()) {
            return cb();
        }

        if (!option.base) {
            gutil.log(gutil.colors.red(PLUGIN_NAME + ' error: `option.base` is required!'));
            return cb();
        }

        if (file.isBuffer()) {
            var main = getId(file.path, option);
            //处理同步依赖
            var deps = getDependence(main);
            deps.unshift(main);
            var depsContent = deps.map(function (dep) {
				//处理异步依赖
				var asyncDeps = getAsyncDependence(dep);
				//排除同步依赖中已引入的模块
				asyncDeps = asyncDeps.filter(function (dep) {
					return deps.indexOf(dep) === -1;
				})
				
				asyncDeps.forEach(function (dep) {
					var childDeps = getDependence(dep);
					//排除同步依赖中已引入的模块
					childDeps = childDeps.filter(function (childDep) {
						return deps.indexOf(childDep) === -1 && asyncDeps.indexOf(dep) === -1;
					});
					childDeps.unshift(dep);
					
					//读取异步依赖文件
					var asyncDepsContent = childDeps.map(function (dep) {
						return getParseModuleContent(dep, option.min);
					});
					
					//创建异步依赖文件
					var asyncFile = new File({
						path: path.join(option.base, dep + '.js'),
						contents: new Buffer(asyncDepsContent.join('\n'))
					});
					
					_self.push(asyncFile);
					
				});
				
                return getParseModuleContent(dep, option.min);
            })
            file.contents = new Buffer(depsContent.join('\n'));
            this.push(file);
           
            var jsFilePath = file.base + path.sep + main;
            jsFilePath = path.normalize(jsFilePath);
            gutil.log(PLUGIN_NAME + ':', '✔ Module [' + jsFilePath + '] combo success.');
        }
        return cb();
    });

    function getId(filePath, option) {
        return filePath.replace(option.base, '').replace(sepReg, '/').replace(/\.js$/, '');
    }

    function parseDependencies(mod) {
        if (depsMap[mod]) {
            return depsMap[mod];
        }
        var ret = []
        var code = getModuleContent(mod);
        code.replace(SLASH_RE, "")
            .replace(REQUIRE_RE, function (m, m1, m2) {
                if (m2) {
                    ret.push(m2)
                }
                return m;
            })
        depsMap[mod] = ret;
        return ret
    }

    function parseAsyncDependencies(mod) {
        if (asyncDepsMap[mod]) {
            return asyncDepsMap[mod];
        }
        var ret = [];
        var code = getModuleContent(mod);
        code.replace(SLASH_RE)
            .replace(ASYNC_REQUIRE_RE, function () {
                var args = Array.prototype.slice.call(arguments);
                var singleModule = args[3];
                var multiModules = args[4];
                if (singleModule) {
                    ret.push(singleModule);
                } else if (multiModules) {
                    try {
                        multiModules = multiModules.replace(/'/g, "\"");
                        multiModules = JSON.parse(multiModules);
                        if (Array.isArray(multiModules)) {
                            ret = ret.concat(multiModules);
                        }
                    } catch (error) {
                        console.log("parse multipart modules error: ", error)
                    }
                } else {
                }
                return args[0];
            });
        asyncDepsMap[mod] = ret;
        return ret;
    }

    function unique(arr) {
        var hash = {}, result = [];
        var item;
        for (var i = 0, l = arr.length; i < l; ++i) {
            item = arr[i];
            if (item.indexOf('.js') != -1) {
                //item.replace('.js', '');
                item = item.replace('.js', '');
            }

            if (!hash.hasOwnProperty(item)) {
                hash[item] = true;
                result.push(item);
            }
        }
        return result;
    }


    function getModuleContent(mod) {
        var ret = moduleContentMap[mod];
        if (ret) {
            return ret;
        }

        if (fs.existsSync(getModulePath(mod))) {//本地不存在的文件返回空，可能是cdn文件
            ret = fs.readFileSync(getModulePath(mod), 'utf8');
        } else {
            ret = '';
        }

        moduleContentMap[mod] = ret;
        return ret;
    }

    function getModulePath(mod) {
        if (mod.indexOf('.js') == -1) {
            mod += '.js';
        }
        return path.join(option.base, mod);
    }

    function getDependence(mod, extraModule) {
        var deps = parseDependencies(mod);
        var childDeps = [];
        if (extraModule && Array.isArray(extraModule)) {
            deps = deps.concat(extraModule);
        }

        deps = unique(deps);
        deps.forEach(function (dep, i) {
            if (deps[i] && -1 != deps[i].indexOf("./")) {
                var pa = path.join(mod + "/../", deps[i]);
                deps[i] = pa.replace(/\\/g, "/");
            }
            childDeps = childDeps.concat(getDependence(deps[i]));
        });

        deps = deps.concat(childDeps);

        return unique(deps);
    }

    function getAsyncDependence(mod, extraModule) {
        var mods = [mod];
        var deps = [];
        var childDeps = [];
        var childAsyncDeps = [];

        if (extraModule && Array.isArray(extraModule)) {
            mods = mods.concat(extraModule);
        }
        //解析异步依赖
        mods.forEach(function (dep) {
            var asyncDeps = parseAsyncDependencies(dep);
            deps = deps.concat(asyncDeps);
        });
		return unique(deps);
    }
	
    function getParseModuleContent(mod, minimized) {
        var cacheName = mod;
        if (minimized) {
            cacheName += '-min';
        }

        if (modcache[cacheName]) {
            return modcache[cacheName];
        }
        //console.log(cacheName)
        var source = getModuleContent(mod);
        var deps = parseDependencies(mod);

        if (deps.length) {
            deps = '"' + deps.join('","') + '"';
        }
        else {
            deps = '';
        }

        source = source.replace('define(', 'define("' + mod + '", [' + deps + '], ');
        if (minimized) {
            source = min(source, minimized);
        }

        /* if (asyncName) {
            //console.log(asyncName)
            source = wrapAsync(asyncName, source);
        } */
        modcache[cacheName] = source;
        return source;
    };
    /**
     * 压缩js脚本
     */
    function min(source, minimized) {
        minimized = minimized === true ? {} : minimized;
        minimized.fromString = true;
        var res = uglify.minify(source, minimized);
        return res.code;
    }

    function wrapAsync(asyncName, content) {
        var reg = /\b(\w)\.async\s*\(\s*/;
        var start = content.search(reg);
        if (start === -1) {
            return content;
        }
        var mixName = RegExp.$1;
        //console.log(mod + ':' + content.substring(start, start + 40))
        var leftPos = rightPos = content.indexOf('(', start);
        do {
            leftPos = content.indexOf('(', leftPos + 1);
            rightPos = content.indexOf(')', rightPos + 1);
        } while (leftPos !== -1 && leftPos < rightPos);

        var leftStr = content.substring(0, start);
        var middleStr = content.substring(start, rightPos + 1);
        var rightStr = content.substring(rightPos + 1);
        return leftStr + mixName + '.async("' + asyncName + '",function(){' + middleStr + '})' + wrapAsync(asyncName, rightStr);
    }
};