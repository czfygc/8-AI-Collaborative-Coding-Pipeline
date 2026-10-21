// 本地验证：reviewers.yaml 解析后 enabled 状态
const fs = require('fs');
const path = require('path').join(__dirname, 'reviewers.yaml');
const text = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
const lines = text.split('\n');
const reviewers = [];
let inReviewers = false;
let current = null;
let blockKey = null;
let blockIndent = -1;
const unquote = (raw) => {
  const s = raw.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).replace(/\\\\/g, '\\');
  }
  return s;
};
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.trim() === '' || line.trim().startsWith('#')) continue;
  const indent = line.length - line.replace(/^\s*/, '').length;
  if (indent === 0) {
    blockKey = null;
    const topKey = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*$/);
    inReviewers = !!(topKey && topKey[1] === 'reviewers');
    current = null;
    continue;
  }
  if (!inReviewers || indent < 1) continue;
  if (blockKey && indent > blockIndent && current) {
    current[blockKey] = (current[blockKey] || '') + (current[blockKey] ? '\n' : '') + line.replace(/^\s+/, '');
    continue;
  }
  blockKey = null;
  const itemMatch = line.match(/^\s*-\s+name:\s*(\S+)/);
  if (itemMatch) {
    current = { name: itemMatch[1] };
    reviewers.push(current);
    continue;
  }
  if (!current) continue;
  const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
  if (!kv) continue;
  const key = kv[1];
  const val = kv[2];
  if (val.trim() === '|') {
    blockKey = key;
    blockIndent = indent;
    current[key] = '';
  } else if (val.trim() === 'null' || val.trim() === '~') {
    current[key] = null;
  } else {
    current[key] = unquote(val);
  }
}
const enabled = reviewers.filter(r => r.enabled === true || r.enabled === 'true');
console.log('parsed reviewers:', reviewers.map(r => r.name + '=' + JSON.stringify(r.enabled) + '(' + typeof r.enabled + ')').join(', '));
console.log('enabled:', enabled.map(r => r.name).join(','));
