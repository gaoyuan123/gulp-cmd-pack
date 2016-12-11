'use strict';
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

function createFile(base,filepath,deps,option){
	//读取异步依赖文件
	let depsContent = deps.map((dep)=> {
		return getParseModuleContent(dep, option);
	});
	//创建异步依赖文件
	let file = new File({
		base: base,
		path: path.join(option.base, filepath + '.js'),
		contents: new Buffer(depsContent.join('\n'))
	});
	
	let jsFilePath = base + path.sep + filepath;
	jsFilePath = path.normalize(jsFilePath);
	gutil.log(PLUGIN_NAME + ':', '✔ Module [' + gutil.colors.green(jsFilePath) + '] combo success.');
	
	return file;
}

function getId(filePath, option) {
	return filePath.replace(option.base, '').replace(sepReg, '/').replace(/\.js$/, '');
}

function parseDependencies(mod, option) {
	if (depsMap[mod]) {
		return depsMap[mod];
	}
	let ret = []
	let code = getModuleContent(mod, option);
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

function parseAsyncDependencies(mod, option) {
	if (asyncDepsMap[mod]) {
		return asyncDepsMap[mod];
	}
	let ret = [];
	let code = getModuleContent(mod, option);
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


function getModuleContent(mod, option) {
	let ret = moduleContentMap[mod];
	if (ret) {
		return ret;
	}
	var modPath = getModulePath(mod, option);
	if (fs.existsSync(modPath)) {//本地不存在的文件返回空，可能是cdn文件
		ret = fs.readFileSync(modPath, 'utf8');
	} else {
		ret = '';
	}

	moduleContentMap[mod] = ret;
	return ret;
}

function getModulePath(mod, option) {
	if (mod.indexOf('.js') == -1) {
		mod += '.js';
	}
	return path.join(option.base, mod);
}

function getDependence(mod, extraModule, option) {
	let deps = parseDependencies(mod, option);
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
		childDeps = childDeps.concat(getDependence(deps[i],null, option));
	});

	deps = deps.concat(childDeps);

	return option.ignore(unique(deps));
}

function getAsyncDependence(mod, extraModule, option) {
	let mods = [mod];
	let deps = [];
	let childDeps = [];
	let childAsyncDeps = [];

	if (extraModule && Array.isArray(extraModule)) {
		mods = mods.concat(extraModule);
	}
	//解析异步依赖
	mods.forEach(function (dep) {
		let asyncDeps = parseAsyncDependencies(dep, option);
		deps = deps.concat(asyncDeps);
	});
	return option.ignore(unique(deps));
}

function getParseModuleContent(mod, option) {
	let cacheName = mod;
	if (option.minify) {
		cacheName += '-min';
	}

	if (modcache[cacheName]) {
		return modcache[cacheName];
	}
	//console.log(cacheName)
	let source = getModuleContent(mod, option);
	let deps = parseDependencies(mod, option);

	if (deps.length) {
		deps = '"' + deps.join('","') + '"';
	}
	else {
		deps = '';
	}

	source = source.replace('define(', 'define("' + mod + '", [' + deps + '], ');
	if (option.minify) {
		source = min(source, option.minify);
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

module.exports = {
	getDependence : getDependence,
	getAsyncDependence : getAsyncDependence,
	getParseModuleContent : getParseModuleContent,
	createFile : createFile,
	getId : getId
}