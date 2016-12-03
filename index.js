'use strict';
const through = require('through2');
const path = require('path');
const fs = require('fs');
const gutil = require('gulp-util');
const uglify = require('uglify-js');
const File = gutil.File;

const PLUGIN_NAME = 'gulp-cmd-pack';


const REQUIRE_RE = /"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|\/\*[\S\s]*?\*\/|\/(?:\\\/|[^\/\r\n])+\/(?=[^\/])|\/\/.*|\.\s*require|(?:^|[^$])\brequire\s*\(\s*(["'])(.+?)\1\s*\)/g
const ASYNC_REQUIRE_RE = /"(?:\\"|[ ^"])*"|'(?:\\'|[^'])*'|\/\*[\S\s]*?\*\/|\/(?:\\\/|[^\/\r\n])+\/(?=[^\/])|\/\/.*|\.\s*require|(?:^|[^$])\brequire\.async\s*\(\s*((["'])(.+?)\2)\s*(?:\)|,)|(?:^|[^$])\brequire\.async\s*\(\s*(\[(\s*(["'])(.+?)\6\s*,?\s*)+\])\s*(?:\)|,)/g
const SLASH_RE = /\\\\/g

const sepReg = /\\/g;

const modcache = {};

const depsMap = {};

const asyncDepsMap = {};

const moduleContentMap = {};

module.exports = function (option) {
	let manifest = {};
	let asyncFiles = [];
    option = option || {};
    option.alias = option.alias || {};
    option.ignore = option.ignore || [];
    option.encoding = option.encoding || 'UTF-8';
    option.cache = {};

    if (option.base) {
        option.base = path.normalize(path.resolve(option.base, '.') + path.sep);
    }

    return through.obj(function (file, encoding, cb) {
        if (file.isNull()) {
            return cb();
        }

        if (!option.base) {
            gutil.log(gutil.colors.red(PLUGIN_NAME + ' error: `option.base` is required!'));
            return cb();
        }

        if (file.isBuffer()) {
            let main = getId(file.path, option);
			manifest[main] = [];
            //处理同步依赖
            let deps = getDependence(main);
            deps.unshift(main);
            let depsContent = deps.map((dep)=>{
				//处理异步依赖
				let asyncDeps = getAsyncDependence(dep);
				//排除同步依赖中已引入的模块
				asyncDeps = asyncDeps.filter((dep)=> {
					return deps.indexOf(dep) === -1 && manifest[main].push(dep + '.js') && asyncFiles.indexOf(dep) === -1;
				})
				
				asyncDeps.forEach((dep)=> {
					let childDeps = getDependence(dep);
					//排除同步依赖中已引入的模块
					childDeps = childDeps.filter((dep)=> {
						return deps.indexOf(dep) === -1 && asyncDeps.indexOf(dep) === -1;
					});
					childDeps.unshift(dep);
					
					//读取异步依赖文件
					let asyncDepsContent = childDeps.map((dep)=> {
						return getParseModuleContent(dep, option.min);
					});
					
					//创建异步依赖文件
					let asyncFile = new File({
						base:file.base,
						path: path.join(option.base, dep + '.js'),
						contents: new Buffer(asyncDepsContent.join('\n'))
					});
					asyncFiles.push(dep);
					this.push(asyncFile);
					
				});
				
                return getParseModuleContent(dep, option.min);
            })
            file.contents = new Buffer(depsContent.join('\n'));
            this.push(file);
           
            let jsFilePath = file.base + path.sep + main;
            jsFilePath = path.normalize(jsFilePath);
            gutil.log(PLUGIN_NAME + ':', '✔ Module [' + jsFilePath + '] combo success.');
        }
        return cb();
    },function(cb){
		if(option.manifest){
			let manifestFile = new File({
				path: option.manifest,
				contents: new Buffer(JSON.stringify(manifest,null,2))
			});
			gutil.log(PLUGIN_NAME + ':', '生成异步依赖配置文件' + manifestFile.path);
			this.push(manifestFile);
		}
		cb();
	});

    function getId(filePath, option) {
        return filePath.replace(option.base, '').replace(sepReg, '/').replace(/\.js$/, '');
    }

    function parseDependencies(mod) {
        if (depsMap[mod]) {
            return depsMap[mod];
        }
        let ret = []
        let code = getModuleContent(mod);
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
        let ret = [];
        let code = getModuleContent(mod);
        code.replace(SLASH_RE)
            .replace(ASYNC_REQUIRE_RE, function () {
                let args = Array.prototype.slice.call(arguments);
                let singleModule = args[3];
                let multiModules = args[4];
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
        let hash = {}, result = [];
        let item;
        for (let i = 0, l = arr.length; i < l; ++i) {
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
        let ret = moduleContentMap[mod];
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
        let deps = parseDependencies(mod);
        let childDeps = [];
        if (extraModule && Array.isArray(extraModule)) {
            deps = deps.concat(extraModule);
        }

        deps = unique(deps);
        deps.forEach(function (dep, i) {
            if (deps[i] && -1 != deps[i].indexOf("./")) {
                let pa = path.join(mod + "/../", deps[i]);
                deps[i] = pa.replace(/\\/g, "/");
            }
            childDeps = childDeps.concat(getDependence(deps[i]));
        });

        deps = deps.concat(childDeps);

        return ignore(unique(deps));
    }

    function getAsyncDependence(mod, extraModule) {
        let mods = [mod];
        let deps = [];
        let childDeps = [];
        let childAsyncDeps = [];

        if (extraModule && Array.isArray(extraModule)) {
            mods = mods.concat(extraModule);
        }
        //解析异步依赖
        mods.forEach(function (dep) {
            let asyncDeps = parseAsyncDependencies(dep);
            deps = deps.concat(asyncDeps);
        });
		return ignore(unique(deps));
    }
	
    function getParseModuleContent(mod, minimized) {
        let cacheName = mod;
        if (minimized) {
            cacheName += '-min';
        }

        if (modcache[cacheName]) {
            return modcache[cacheName];
        }
        //console.log(cacheName)
        let source = getModuleContent(mod);
        let deps = parseDependencies(mod);

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
        let res = uglify.minify(source, minimized);
        return res.code;
    }

	function ignore(deps){
		if(!option.ignore.length){
			return deps;
		}
		return deps.filter(function(dep){
			return option.ignore.indexOf(dep) === -1;
		})
	}
	
    function wrapAsync(asyncName, content) {
        let reg = /\b(\w)\.async\s*\(\s*/;
        let start = content.search(reg);
        if (start === -1) {
            return content;
        }
        let mixName = RegExp.$1;
        //console.log(mod + ':' + content.substring(start, start + 40))
        let leftPos = rightPos = content.indexOf('(', start);
        do {
            leftPos = content.indexOf('(', leftPos + 1);
            rightPos = content.indexOf(')', rightPos + 1);
        } while (leftPos !== -1 && leftPos < rightPos);

        let leftStr = content.substring(0, start);
        let middleStr = content.substring(start, rightPos + 1);
        let rightStr = content.substring(rightPos + 1);
        return leftStr + mixName + '.async("' + asyncName + '",function(){' + middleStr + '})' + wrapAsync(asyncName, rightStr);
    }
};