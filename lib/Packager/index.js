'use strict';

var
	path = require('path'),
	fs = require('fs');

var
	browserify = require('browserify'),
	gulp = require('gulp'),
	buffer = require('vinyl-buffer'),
	source = require('vinyl-source-stream'),
	maps = require('gulp-sourcemaps'),
	parse5 = require('parse5'),
	through = require('through2'),
	glob = require('glob'),
	less = require('less');

var
	rewriter = require('./rewriter'),
	packageSpy = require('./package-spy'),
	utils = require('../utils'),
	logger = require('../logger'),
	defaults = require('./defaults');

var
	Parser = parse5.Parser,
	Serializer = parse5.Serializer,
	File = require('vinyl');

var
	validJsonKeys = Object.keys(defaults);

validJsonKeys.push('main');
validJsonKeys.push('style');
validJsonKeys.push('assets');
validJsonKeys.push('title');

module.exports = Packager;


/**
* Unify the flow of packaging the application source alongside its dependencies. Various tools
* are required to manage these dependencies and this tool facilities their interactions.
*/
function Packager (opts) {
	if (!this instanceof Packager) return new Packager(opts);
	
	// @todo clean, complete sanity checks
	this.package = path.resolve(opts.package);
	delete opts.package;
	
	logger.setLogLevel(opts.logLevel);
	logger.log('info', 'beginning execution of package "%s"', this.package);
	
	// we process the package json first so that if any options were explicitly set they will
	// override the json defined values
	this.processPackageJson();
	// runtime options have the priority over defaults (if added to the prototype) or even
	// package.json specified
	Object.keys(opts).forEach(function (key) {
		if (validJsonKeys.indexOf(key) > -1) {
			if (this[key] != null) {
				// if it is already set by the json options lets make sure the value being passed
				// in isn't the default value unintentionally overwriting our set value
				
				// if there isn't a default value or the new value is not the default value
				if (defaults[key].default == null || (defaults[key].default !== opts[key])) {
					this[key] = opts[key];
				}
			} else this[key] = opts[key];
		}
	}, this);
	
	// ordered array of libs as they are encountered whether explicitly or implicitly
	this.knownLibs = [];
	this.includeLibs = this.includeLibs || [];
	
	if (this.includeLibs) this.includeLibs.forEach(function (lib) { this.addLib(lib); }, this);
	this.processLibraryPath();
	
	// ordered array of packages as they were encountered for expos facto processing
	this.packages = {order: []};
	
	// prepare the output template
	this.processTemplate();
	
	if (this.devMode) this.development();
	else this.production();
}

/**
* Prepares the AST of the given (or default) index HTML template. If no index was provided it falls-
* back to using the provided one (bare). This is used to rebuild the output source later with all
* of the other features having been fully resolved.
*/
Packager.prototype.processTemplate = function () {
	var
		tpl = this.templateIndex;
	
	if (tpl) {
		
		logger.log('debug', 'using the provided template index file "%s"', tpl);
		
		try {
			this.templateIndex = fs.readFileSync(path.resolve(tpl), 'utf8');
		} catch (e) {
			throw 'Error: Could not find requested template index file "' + tpl + '"';
		}
	} else {
		
		logger.log('debug', 'no template index file was provided, using the default');
		
		this.templateIndex = fs.readFileSync(path.resolve(__dirname, './template-index.html'), 'utf8');
	}
	
	this.ast = new Parser().parse(this.templateIndex);
	
	// if there is a title request we will go ahead and set that now
	if (this.title) {
		logger.log('debug', 'setting the #document title to "%s"', this.title);
		utils.setDocumentTitle(this.ast, this.title);
	}
};

/**
* Prepares the package's _package.json_ file so certain properties can be explored for configuration
* options at runtime. This also maps the package's `main` property to be a local property of the
* Packager instance.
*/
Packager.prototype.processPackageJson = function () {
	var json;
	
	try {
		// we store a reference to the original values for debugging purposes mostly
		json = this.packageJson = require(path.join(this.package, './package.json'));
	} catch (e) {
		throw 'Error: Could not find a package.json file in the package "' + this.package + '"';
	}
	
	if (!json.main) {
		
		logger.log('debug', 'no "main" in package.json, using default "index.js" as entry point');
		
		json.main = path.resolve(this.package, 'index.js');
	}
	else {
		logger.log('debug', 'using provided "main" value "%s" as entry point', json.main);
		
		json.main = path.resolve(this.package, json.main);
	}
	
	Object.keys(json).forEach(function (key) {
		if (validJsonKeys.indexOf(key) > -1) {
			this[key] = json[key];
		}
	}, this);
};

/**
* We need to do a quick scan of the available libraries to know which ones to magically map when
* enountered by the re-writer. For now this is happening on an exact match basis - if the library
* was found in the provided library directory then encountered in a require statement it will be
* mapped to the correct library.
*/
Packager.prototype.processLibraryPath = function () {
	
	var libPath = path.resolve(this.package, this.libPath);
	
	try {
		var files = fs.readdirSync(libPath);
		
		files.forEach(function (file) {
			var filePath, stat;
			
			filePath = path.join(libPath, file);
			try {
				stat = fs.statSync(filePath);
				if (stat.isDirectory()) this.addLib(file);
			} catch (e) {
				throw 'Error: Could not stat library "' + file + '"';
			}
		}, this);
		
	} catch (e) {
		throw 'Error: Could not read the provided library path "' + this.libPath + '"';
	}
	
};

/**
* If the internal `devMode` option is set to `true` it will be used to provide source-maps in the
* final output. It will also _not_ minify the JS/CSS output.
*/
Packager.prototype.development = function () {
	
	logger.log('info', 'beginning development build');
	
	var
		bundle = browserify({debug: true}),
		transform = rewriter(this),
		plugin = packageSpy(this);
	bundle
		.transform(transform)
		.plugin(plugin)
		.add(this.main)
		.bundle()
		.pipe(source(this.outJsFile || 'insert.js'))
		.pipe(buffer())
		.pipe(maps.init({loadMaps: true}))
		.pipe(maps.write())
		.pipe(this.acceptJsFile());
};

Packager.prototype.production = function () {
	logger.log('error', 'production builds not currently available');
};

/**
* While it will be advised that developers explicitly require their libs, in-order, we still have
* to track them implicitly just in case and so we don't need to make them do the require if they
* don't need it.
*/
Packager.prototype.addLib = function (lib) {
	if (!this.hasLib(lib)) {
		this.knownLibs.push(lib);
		logger.log('debug', 'adding library "%s" as a known library', lib);
	}
};

/**
* Convenience method.
*/
Packager.prototype.hasLib = function (lib) {
	return this.knownLibs.indexOf(lib) >= 0;
};

/**
* During processing of the JavaScript we report the libraries that were actually encountered not
* just ones we found so that we know which ones to include. If the library was already mentioned
* explicitly by a setting then we don't re-order based on the fact we found it, otherwise we do
* to preserve the natural ordering.
*/
Packager.prototype.includeLib = function (lib) {
	if (this.includeLibs.indexOf(lib) === -1) {
		this.includeLibs.push(lib);
		logger.log('debug', 'adding library "%s" as an implicit include', lib);
	}
};

/**
* Discovery of packages happens during JavaScript analysis but we don't process them until later.
* This is the interface where they are added and stored, in-order, so we can do the style and
* asset processing later.
*/
Packager.prototype.addPackage = function (pkg, unshift) {
	if (this.packages.order.indexOf(pkg.__dirname) === -1) {
		if (!unshift) this.packages.order.push(pkg.__dirname);
		else this.packages.order.unshift(pkg.__dirname);
		this.packages[pkg.__dirname] = pkg;
		logger.log('debug', 'added package from "%s"', pkg.__dirname);
	}
};

/**
* Once the file is completed we will have enough information to continue processing packages for
* style and asset management. This function returns the stream that accepts the Browserify output
* file and stores it while it kicks off processing the other paths.
*/
Packager.prototype.acceptJsFile = function () {
	
	var packager = this;
	
	return through.obj(function (file, nil, next) {
		logger.log('info', 'sourcecode analysis and compilation complete');
		if (packager.outJsFile) {
			file.path = path.join(packager.outdir, packager.outJsFile);
			file.base = packager.outdir;
		}
		packager.outputJsFile = file;
		packager.processProjectDependencies();
	});
	
};

/**
* Once the JavaScript has been completely evaluated and compiled we move on to processing the
* libraries and coalescing their minor-module-packages.
*/
Packager.prototype.processProjectDependencies = function () {
	
	logger.log('info', 'handling project non-JavaScript dependencies');

	// // the first thing to do is process the known libraries, determine which ones have packages
	// // and order them for the next step of package explosion
	// this.processIncludedLibraries();
	this.processPackages();
};

/**
* Check to see if the included libraries include a package.json object for us to include in our
* package analysis in the next step.
*/
Packager.prototype.processIncludedLibraries = function () {
	
	// reverse so their respective package files will be added in the correct order
	this.includeLibs.reverse();
	
	logger.log('info', 'processing included libraries for additional package dependencies');
	logger.log('debug', this.includeLibs);
	
	// we need to reverse the order of the libraries so we can inject them into the packages
	// correctly - this is based on the assumption that if a library includes base style that it
	// should be included before any of its own modules
	this.includeLibs.forEach(function (lib) {
		
		// determine if the library has a package then add it
		var
			libPath = path.resolve(this.libPath, lib),
			packagePath = path.join(libPath, 'package.json'),
			pkg;
		
		try {
			// reads in the JSON and parses it automatically
			pkg = require(packagePath);
			// consistent with the package objects defined by browserify
			pkg.__dirname = path.relative(this.package, libPath);
		} catch (e) {
			// we don't actually care about the fact it wasn't there but will notify anyway
			// this is not a critical error
			logger.log('warn', 'library "%s" did not have a package.json package file, attempted ' +
				'to find "%s", if the library has any dependencies they will not be included',
				path.relative(this.package, path.join(this.libPath, lib)),
				path.relative(this.package, packagePath)
			);
		}
		
		if (pkg) this.addPackage(pkg, true);
		
	}, this);
	
};

/**
* The final packages will have their order reversed for correctness and explored for supported
* properties (e.g. "style" or "assets"). Then these will be properly collected and then handled
* separately by specific handlers.
*/
Packager.prototype.processPackages = function () {
	
	// reverse them because our evaluation is the reverse in which we built them
	this.reorderPackages();
	this.processIncludedLibraries();
	
	logger.log('info', 'processing the required packages');
	logger.log('debug', this.packages.order);
	
	var
		// globbed style entries in-order, de-duped
		styles = this.styles = [],
		// globbed asset entries (not order dependent but de-duped)
		assets = this.assets = [];
	
	// for keeping track of the files and de-duping
	styles.files = [];
	assets.files = [];
	
	this.packages.order.forEach(function (nom) {
		var
			pkg = this.packages[nom],
			pkgEntry = {path: pkg.__dirname, package: pkg};
		
		if (pkg.style && Array.isArray(pkg.style) && pkg.style.length) {
			pkg.style.forEach(function (entry) {
				// we have to ensure that the glob is relative to the original package
				entry = path.join(pkg.__dirname, entry);
				if (styles.files.indexOf(entry) === -1) {
					styles.files.push(entry);
					styles.push({glob: entry, package: pkg.__dirname});
				}
			});
		}
		
		if (pkg.assets && Array.isArray(pkg.assets) && pkg.assets.length) {
			pkg.assets.forEach(function (entry) {
				// same as with the style globs have to be relative to package
				entry =  path.join(pkg.__dirname, entry);
				if (assets.files.indexOf(entry) === -1) {
					assets.files.push(entry);
					assets.push({glob: entry, package: pkg.__dirname});
				}
			});
		}
		
	}, this);
	
	this.processStyle();
};

Packager.prototype.reorderPackages = function () {
	
	var
		packages = this.packages.order,
		ordered = [],
		hadpkg = false,
		modules = this.sorted.map(function (row) {
			return path.relative(this.package, path.dirname(row.file));
		}, this);

	ordered = packages.filter(function (pkg) {
		if (pkg == './') {
			hadpkg = true;
			return false;
		}
		return true;
	}).sort(function (a, b) {
		var
			idx1 = modules.indexOf(a),
			idx2 = modules.indexOf(b);
		
		if (idx1 === -1 && idx2 === -1) return 1;
		else if (idx1 === idx2) return 0;
		else if (idx1 > idx2) return 1;
		else return -1;
	});
	
	if (hadpkg) ordered.push('./');
	
	this.packages.order = ordered;
};

/**
* Here we concatenate all of the style for the project and produce the final output as a file
* ready to be written (even if later only the content is used). We use a glob library for
* synchronous globbing operations for convenience in this scenario.
*/
Packager.prototype.processStyle = function () {
	
	logger.log('info', 'processing the final style');
	
	var
		styles = this.styles,
		output = '';
	
	// to determine the correct base path from which to rewrite relative to we need to
	// figure out if we're outputting our css to a file or if it is inlined in the index
	// if it is inlined in the index that is the easy case as we can simply pre-pend the
	// already relative paths with the output directory for assets if it is a file
	// we just need to figure out what the relative path from the file to the asset
	// directory is and then do the same
	var
		base;
	
	if (this.outCssFile) {
		base = path.relative(
			path.join(this.outdir, path.dirname(this.outCssFile)),
			path.join(this.outdir, this.outAssetDir)
		);
	}
	
	// if we don't have a base at this point it is safe to simply use the asset directory
	if (!base) base = this.outAssetDir;
	
	styles.forEach(function (entry) {
		
		// on a per-entry basis we may wind up finding lots of files or only one but for any
		// given entry it is not a guarantee of the number of files it will return
		var
			files = glob.sync(entry.glob);
		
		files.forEach(function (file) {
			var src;
			
			try {
				src = fs.readFileSync(file, 'utf8');
			} catch (e) {
				throw 'Error: Could not read requested file "' + file + '"';
			}
			
			if (src) {
				logger.log('debug', '--- processing "%s"', file);
				// we have to rewrite imports now before we concat because this is our last chance
				// to know the path from which the content came
				src = utils.translateImportPaths(src, path.dirname(file));
				// we have to rewrite urls before we can concat because they have to be resolved
				// relative to the file they were in and the package that file came from
				src = utils.translateUrlPaths(src, base, path.dirname(file), entry.package);
				output += src + '\n';
				logger.log('debug', '--- done processing "%s"', file);
			}
		}, this);
			
	}, this);
	
	// now that the pre-processing paths has been completed we can finally continue with the
	// less compilation
	logger.log('info', 'compiling less from style sources');

	less
		.render(output)
		.then(function (compiled) {
			this.outputCssFile = new File({contents: new Buffer(compiled.css)});
			logger.log('debug', 'less compilation complete');
			this.processAssets();
		}.bind(this), function (err) {
			logger.log('error', err);
			throw 'Error: Failed to compile less "' + err + '"';
		});
};

/**
* Prepare the output files for any assets that will be copied to the final package state.
*/
Packager.prototype.processAssets = function () {
	
	logger.log('info', 'processing project assets');
	
	var
		entries = this.assets,
		assets = this.assets = [];
	
	entries.forEach(function (entry) {
		var
			files = glob.sync(entry.glob);
		
		logger.log('debug', entry.package, entry.glob, files);
		
		files.forEach(function (file) {
			var asset;
			try {
				asset = new File({
					path: path.join(this.outdir, this.outAssetDir, path.relative(entry.package, file)),
					base: this.outdir,
					contents: fs.readFileSync(file)
				});
				
				assets.push(asset);
				logger.log('debug', 'created asset "%s" from "%s"', asset.path, file);
			} catch (e) {
				throw 'Error: Could not read asset file "' + file + '"';
			}
			
		}, this);
	}, this);
	
	this.processIndex();
};

/**
*
*/
Packager.prototype.processIndex = function () {
	
	logger.log('info', 'processing the HTML output');
	
	var
		ast = this.ast,
		head = utils.getDocumentHead(ast),
		index = this.index = new File({path: path.join(this.outdir, this.outfile), base: this.outdir}),
		serializer = new Serializer(),
		node, html;
	
	utils.scrubDocumentHead(head);
	
	// are we outputting a separate css file or inline it
	if (this.outCssFile) {
		this.outputCssFile.path = path.join(this.outdir, this.outCssFile);
		this.outputCssFile.base = this.outdir;
		logger.log('info', 'exporting CSS file "%s"', this.outputCssFile.path);
		node = utils.createStylesheetNode(head, path.relative(this.outdir, this.outputCssFile.path));
	} else {
		logger.log('info', 'embedding CSS in HTML output');
		node = utils.createStyleNode(head, this.outputCssFile.contents.toString());
	}
	
	// ensure the node is a part of the head's childNodes
	head.childNodes.push(node);
	
	if (this.outJsFile) {
		logger.log('info', 'exporting JavaScript file "%s"', this.outputJsFile.path);
		node = utils.createScriptNode(head, path.relative(this.outdir, this.outputJsFile.path), true);
	} else {
		logger.log('info', 'embedding JavaScript in HTML output');
		node = utils.createScriptNode(head, this.outputJsFile.contents.toString());
	}
	
	// ensure the node is a part of the head's childNodes
	head.childNodes.push(node);
	
	logger.log('info', 'rendering final HTML');
	html = serializer.serialize(ast);
	index.contents = new Buffer(html);
	
	this.completeBuild();
};

/**
*
*/
Packager.prototype.completeBuild = function () {
	
	var
		output = through.obj();
	
	// we pipe the output of our stream to gulps writing utility
	output.pipe(gulp.dest(this.outdir));
	
	logger.log('info', 'writing final HTML index file "%s"', this.index.path);
	output.write(this.index);
	
	if (this.assets && this.assets.length) {
		logger.log('info', 'writing final assets to "%s"', path.join(this.outdir, this.outAssetDir));
		this.assets.forEach(function (asset) {
			logger.log('debug', 'writing "%s"', asset.path);
			output.write(asset);
		});
	}
	
	if (this.outCssFile) {
		logger.log('info', 'writing final CSS file "%s"', this.outputCssFile.path);
		output.write(this.outputCssFile);
	}
	
	if (this.outJsFile) {
		logger.log('info', 'writing final JavaScript file "%s"', this.outputJsFile.path);
		output.write(this.outputJsFile);
	}
	
	logger.log('info', '%s build complete', this.devMode ? 'development' : 'production');
	
	output.end();
};