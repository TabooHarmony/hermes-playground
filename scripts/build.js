const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'src', 'index.js');
const distDir = path.join(root, 'dist');
const dist = path.join(distDir, 'index.js');

const code = fs.readFileSync(src, 'utf8');
new vm.Script(code, { filename: src });
fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(dist, code);
console.log(`built ${path.relative(root, dist)}`);
