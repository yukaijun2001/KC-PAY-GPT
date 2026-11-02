'use strict';

const path = require('path');

// Runtime state remains at the project root even when source modules move.
const PROJECT_ROOT = path.resolve(__dirname, '..');

function projectPath(...parts) {
    return path.join(PROJECT_ROOT, ...parts);
}

module.exports = { PROJECT_ROOT, projectPath };
