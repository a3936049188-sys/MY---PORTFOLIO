const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter(Boolean);

scripts.forEach((code) => new Function(code));
console.log('inline scripts syntax passed');
