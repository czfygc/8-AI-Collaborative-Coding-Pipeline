import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TITAN_ROOT = join(__dirname, '..');
const DISPATCH_ID = '66c0f00e';
const LAYER_A_DIR = join(TITAN_ROOT, 'reviews', DISPATCH_ID, 'layer-a');
const RAW_DIR = join(LAYER_A_DIR, 'raw');

// Extract reviewer names from dispatch-meta.json
const dispatchMeta = JSON.parse(fs.readFileSync(join(LAYER_A_DIR, 'dispatch-meta.json'), 'utf8'));

function extractScopeFromFinding(text) {
  const t = String(text || '');
  const m = t.match(/(?:位置|position)\s*[:：]\s*(.+)/i);
  if (m) {
    const firstSegment = m[1].trim().split(/\s*\/\s*/)[0];
    return firstSegment.slice(0, 120);
  }
  return '';
}

function splitFindings(text) {
  const blocks = text.split(/(?=ISSUE-ID:)/i);
  return blocks.map(b => b.trim()).filter(b => b.startsWith('ISSUE-ID:'));
}

function mapSeverity(s) {
  const up = String(s || '').toUpperCase();
  if (['HIGH', 'MEDIUM', 'LOW'].includes(up)) return up;
  if (up.includes('高')) return 'HIGH';
  if (up.includes('中')) return 'MEDIUM';
  if (up.includes('低')) return 'LOW';
  return null;
}

let counter = 1;
const issues = [];

for (const reviewer of dispatchMeta.reviewers) {
  const rawPath = join(RAW_DIR, reviewer.name + '.md');
  if (!fs.existsSync(rawPath)) {
    issues.push({
      canonicalIssueId: 'F-' + String(counter++).padStart(3, '0'),
      factualProposition: '',
      evidenceScope: '',
      occurrences: [{ reviewer: reviewer.name, issueId: 'NONE', severity: null }],
    });
    continue;
  }

  const rawText = fs.readFileSync(rawPath, 'utf8');
  const findings = splitFindings(rawText);

  if (findings.length === 0) {
    issues.push({
      canonicalIssueId: 'F-' + String(counter++).padStart(3, '0'),
      factualProposition: rawText.slice(0, 300),
      evidenceScope: '',
      occurrences: [{ reviewer: reviewer.name, issueId: 'NONE', severity: null }],
    });
    continue;
  }

  for (const f of findings) {
    issues.push({
      canonicalIssueId: 'F-' + String(counter++).padStart(3, '0'),
      factualProposition: f.slice(0, 500),
      evidenceScope: extractScopeFromFinding(f),
      occurrences: [{
        reviewer: reviewer.name,
        issueId: (f.match(/ISSUE-ID: ([A-Z]-\d+)/) || [])[1] || 'NONE',
        severity: mapSeverity((f.match(/严重程度[:：]\s*(\S+)/) || [])[1]),
      }],
    });
  }
}

fs.writeFileSync(join(LAYER_A_DIR, 'issues-normalized.json'), JSON.stringify(issues, null, 2), 'utf8');
console.log('Generated', issues.length, 'canonical issues');
console.log('Sample D-02:', issues.find(i => i.occurrences.some(o => o.issueId === 'D-02')));
console.log('Sample G-01:', issues.find(i => i.occurrences.some(o => o.issueId === 'G-01')));
