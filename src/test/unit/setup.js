/**
 * Mocha setup file for pure Node.js unit tests.
 * Registers a mock 'vscode' module so source code can be imported without the VSCode host.
 */
const path = require('path');
const Module = require('module');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
    if (request === 'vscode') {
        return path.join(__dirname, 'vscode.mock.js');
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
};
