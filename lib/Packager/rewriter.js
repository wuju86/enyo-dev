'use strict';

var
	path = require('path');

var
	through = require('through2');

var
	logger = require('../logger');

module.exports = function (packager) {
	return function (filename) {
		if (path.extname(filename) != '.js') return through();

		var src;

		function write (buf, nil, next) {
			src = buf.toString();
			next();
		}

		// where the magic happens
		function end (done) {
			// it will only attempt to rewrite paths that are not relative and will still only
			// rewrite paths for exact matching references to known libs
			src = src.replace(/require\((['"])(?!\.)(.*)\1\)/g, function (match, sep, module) {
				var
					parts = module.split('/'),
					lib = parts[0], repl, rel;
				// if we know about this library then it is a rewritable library path
				if (packager.hasLib(lib)) {
					// we have to indicate to the packager that this particular library was actually
					// encountered so later it can be processed for packaging info
					packager.includeLib(lib);
					// @todo For our internally libraries this could work because we can ensure
					// that we use this path but this by no means is inclusive of other libs so
					// this will have to be reviewed
					if (parts.length > 1) parts.splice(1, 0, 'lib');
					repl = parts.join('/');
					rel = path.relative(path.dirname(filename), path.join(packager.package, packager.libPath));
					repl = path.join(rel, repl);
					if (repl.charAt(0) != '.') repl = './' + repl;
					
					logger.log('debug', 'mapping "%s" to "%s" in %s', module, repl, path.relative(packager.package, filename));
					
					return match.replace(module, repl);
				}
				return match;
			});

			this.push(new Buffer(src));

			done();
		}

		return through(write, end);
	};
};