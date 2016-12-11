'use strict';
const through = require('through2');
const path = require('path');
const gutil = require('gulp-util');
const File = gutil.File;
const cmdUtil = require('./lib/cmdUtil');
const PLUGIN_NAME = 'gulp-cmd-pack';

function pack(option) {
	option = getOptions(option);
	
    return through.obj(function (file, encoding, cb) {
        if (file.isNull() || !file.isBuffer()) {
            return cb();
        }

		let main = cmdUtil.getId(file.path, option);
		//处理同步依赖
		let deps = cmdUtil.getDependence(main,null,option);
		deps.unshift(main);
		let depsContent = deps.map((dep)=>{
			return cmdUtil.getParseModuleContent(dep, option);
		})
		
		file.main = main;
		file.deps = deps;
		file.contents = new Buffer(depsContent.join('\n'));
		this.push(file);
	   
		let jsFilePath = file.base + path.sep + main;
		jsFilePath = path.normalize(jsFilePath);
		gutil.log(PLUGIN_NAME + ':', '✔ Module [' + gutil.colors.blue(jsFilePath) + '] combo success.');
        
        return cb();
    });
}

function packAsync(option) {
	option = getOptions(option);

	let asyncFiles = [];
    
    return through.obj(function (file, encoding, cb) {
        if (file.isNull() || !file.main) {
			this.push(file);
            return cb();
        }
		file.depsAsync = [];
		
		let main = file.main;
		let depsMain = file.deps;
		
		//处理异步依赖
		let depsAsync = cmdUtil.getAsyncDependence(main,null,option)
		//排除同步依赖中已引入的模块
		.filter((dep)=> {
			return depsMain.indexOf(dep) === -1 && file.depsAsync.push(dep) && asyncFiles.indexOf(dep) === -1;
		});
		
		depsAsync.forEach((dep)=> {
			let depsChild = cmdUtil.getDependence(dep,null,option)
			//排除同步依赖中已引入的模块
			.filter((dep)=> {
				return depsMain.indexOf(dep) === -1 && depsAsync.indexOf(dep) === -1;
			});
			depsChild.unshift(dep);
			
			let asyncFile = cmdUtil.createFile(file.base,dep,depsChild,option)
			this.push(asyncFile);
			asyncFiles.push(dep);
		});
		
		this.push(file);
        return cb();
    });
}

function mergeAsync(option) {
	option = getOptions(option);

	let asyncFiles = [];
	let asyncDeps = [];
    return through.obj(function (file, encoding, cb) {
        if (file.isNull() || !file.isBuffer()) {
            return cb();
        }
		
		if(!file.main){//过滤异步文件
			asyncFiles.push(file);
			return cb();
		}
		
		let main = file.main;
		let depsMain = file.deps;
		let depsAsync = file.depsAsync;
		
		if(depsAsync && depsAsync.length && option.merge(main)){
			let depsAll = cmdUtil.getDependence(depsAsync[0],depsAsync,option)
			//排除同步依赖中已引入的模块
			.filter((dep)=> {
				return depsMain.indexOf(dep) === -1;
			});
			let asyncFile = cmdUtil.createFile(file.base,main + '_async',depsAll,option);
			this.push(asyncFile);
			file.depsAsync = [main + '_async'];
		}
		
		if(file.depsAsync){
			asyncDeps = asyncDeps.concat(file.depsAsync);
		}
		
		this.push(file);
        return cb();
    },function(cb){
		
		asyncFiles.forEach((file)=>{
			let id = cmdUtil.getId(file.path,option);
			if(asyncDeps.indexOf(id)!==-1){
				this.push(file);
			}
		})
		return cb();
	});
}

function manifest(option) {

	let manifest = {};
    
    return through.obj(function (file, encoding, cb) {
        if (file.depsAsync && file.depsAsync.length) {
			let main = file.main;
			let depsAsync = file.depsAsync;
			manifest[main] = depsAsync;
		}
        return cb();
    },function(cb){
		let manifestFile = new File({
			path: 'async_manifest.json',
			contents: new Buffer(JSON.stringify(manifest,null,2))
		});
		gutil.log(PLUGIN_NAME + ':', '生成异步依赖配置文件' + manifestFile.path);
		this.push(manifestFile);
		
		cb();
	});
}


function getOptions(option){
	option = option || {};
	if (!option.base) {
		throw new gutil.PluginError(PLUGIN_NAME, 'error: `option.base` is required!');
    }
	
	option.base = path.normalize(path.resolve(option.base, '.') + path.sep);
	option.ignore = option.ignore || function(deps){
		return deps;
	}
	let ignore = option.ignore;
	if(ignore instanceof Array){
		option.ignore = function(deps){
			return deps.filter(function(dep){
				return ignore.indexOf(dep) === -1;
			})
		}
	}
	let merge = option.merge;
	if(merge instanceof Array){
		option.merge = function(main){
			return merge.indexOf(main) !== -1;
		}
	}else if(typeof merge !== 'function'){
		option.merge = function(){
			return !!merge;
		}
	}
	
	
	return option;
}

module.exports = {
	pack : pack,
	packAsync : packAsync,
	mergeAsync : mergeAsync,
	manifest : manifest
}
