'use strict';

const fs = require('fs');
const path = require('path');
const loaderUtils = require('loader-utils');
const SourceMap = require('source-map');

const { applyPlaceholders, stat } = require('./lib/util');

const HAS_COMMONJS = /(\s+require\s*\()|(module\.exports)/;

module.exports = function(source, sourceMap) {
	this.cacheable(true);
	const callback = this.async();

	const query = loaderUtils.getOptions(this);

	// /foo/bar/file.js
	const srcFilepath = this.resourcePath;
	// /foo/bar/file.js -> file
	const srcFilename = path.basename(srcFilepath, path.extname(srcFilepath));
	// /foo/bar/file.js -> /foo/bar
	const srcDirpath = path.dirname(srcFilepath);
	// /foo/bar -> bar
	const srcDirname = srcDirpath.split(path.sep).pop();

	const sourceString = source.toString('utf8');

	const hasCommonJS = HAS_COMMONJS.test(sourceString);

	Promise.all(Object.keys(query)
		.map(fileQuery => {

			const {
				loaders,
				varName: varNameFromQuery,
			} = query[fileQuery] || {};

			const varName = applyPlaceholders(varNameFromQuery, srcDirname, srcFilename);
			const filePath = applyPlaceholders(fileQuery, srcDirname, srcFilename);
			const fullPath = path.resolve(srcDirpath, filePath);

			const loadersForFile = !loaders ? '' : loaders.replace(/\*/g, '!') + '!';

			// @todo support mandatory/optional requires via config

			// check if absoluted from srcDirpath + baggageFile path exists
			return stat(fullPath)
				.then(stats => {
					if (!stats.isFile()) {
						return;
					}

					if (hasCommonJS) {
						let inject = '';
						if (varName) {
							inject = 'const ' + varName + ' = ';
						}

						return inject + 'require(\'' + loadersForFile + './' + filePath + '\');\n';
					}

					let inject = 'import ';
					if (varName) {
						inject = varName + ' from ';
					}

					return inject + '\'' + loadersForFile + './' + filePath + '\';\n';
				})
				// eslint-disable-next-line
				.catch((e) => {
					// log a warning/error?
				});
		}))
		.then(async results => {

            const injections = results.filter(x => typeof x === 'string' && !~sourceString.indexOf(x));

			if (injections.length) {
				const srcInjection = injections.join('\n');
                let code = srcInjection + sourceString;
                let map = void 0;

				// support existing SourceMap
				// https://github.com/mozilla/source-map#sourcenode
				// https://github.com/webpack/imports-loader/blob/master/index.js#L34-L44
				// https://webpack.github.io/docs/loaders.html#writing-a-loader
				if (sourceMap) {
					const currentRequest = loaderUtils.getCurrentRequest(this);
					const SourceNode = SourceMap.SourceNode;
					const SourceMapConsumer = SourceMap.SourceMapConsumer;
					const sourceMapConsumer = new SourceMapConsumer(sourceMap);
					const node = SourceNode.fromStringWithSourceMap(sourceString, sourceMapConsumer);

					node.prepend(srcInjection);

					const result = node.toStringWithSourceMap({
						file: currentRequest
                    });

                    code = result.code;
                    map = result.map.toJSON();
                }

                if (process.env.STORE_BAGGAGE_LOADER_CHANGES) {
                    await fs.promises.writeFile(srcFilepath, code);
                }

				// prepend collected inject at the top of file
				callback(null, code, map);
				return;
			}

			// return the originals
			callback(null, source, sourceMap);
		});
};
