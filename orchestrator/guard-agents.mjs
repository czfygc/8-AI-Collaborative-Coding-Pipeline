#!/usr/bin/env node
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const REPO_ROOT = 'D:\\TITAN_ARCHAEOLOGY';
const WATCH_FILES = [
  'AGENTS.md',
  'opencode.json',
  'ISSUE_REGISTRY.json'
];
const POLL_INTERVAL_MS = 5000;
const HISTORY_DEPTH = 500;

let headBlobs = new Map();
let historyBlobs = new Map();
let alertCount = 0;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function normalizeLF(input) {
  const str = Buffer.isBuffer(input) ? input.toString('utf8') : input;
  return str.replace(/\r\n/g, '\n');
}

function getHeadBlob(path) {
  try {
    const out = execSync(`git show HEAD:${path}`, { cwd: REPO_ROOT, encoding: 'buffer', stdio: ['pipe', 'pipe', 'ignore'] });
    return sha256(out);
  } catch {
    return null;
  }
}

function buildHistoryCache() {
  for (const f of WATCH_FILES) {
    const set = new Set();
    try {
      const commitsOut = execSync(`git log -${HISTORY_DEPTH} --format=%H -- ${f}`, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const commits = commitsOut.trim().split('\n').filter(Boolean);
      log(`CACHE: ${f} found ${commits.length} commits`);
      for (const c of commits) {
        try {
          const blobOut = normalizeLF(execSync(`git show ${c}:${f}`, { cwd: REPO_ROOT, encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'] }));
          set.add(sha256(blobOut));
        } catch (e) {
          log(`CACHE ERR: ${f}@${c.slice(0,8)} ${e.message}`);
        }
      }
    } catch (e) {
      log(`CACHE ERR: ${f} log failed: ${e.message}`);
    }
    historyBlobs.set(f, set);
    log(`CACHE: ${f} ${set.size} historical blobs`);
  }
}

function restoreFromHead(path) {
  try {
    execSync(`git restore --source=HEAD --worktree -- ${path}`, { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const line = `[${ts}] ${msg}`;
  console.log(line);
  writeFileSync(`${REPO_ROOT}/orchestrator/guard-agents.log`, line + '\n', { flag: 'a' });
}

function alert(msg) {
  alertCount++;
  log(`🚨 ALERT #${alertCount}: ${msg}`);
}

function checkFile(relPath) {
  const abs = `${REPO_ROOT}\\${relPath}`;
  if (!existsSync(abs)) {
    log(`MISSING: ${relPath}`);
    return;
  }
  const currentBuf = normalizeLF(readFileSync(abs));
  const currentHash = sha256(currentBuf);
  const headHash = headBlobs.get(relPath);

  if (currentHash === headHash) {
    return;
  }

  alert(`MISMATCH: ${relPath} != HEAD (current=${currentHash.slice(0,16)} head=${headHash.slice(0,16)})`);

  const knownHist = historyBlobs.get(relPath) || new Set();
  if (knownHist.has(currentHash)) {
    alert(`ROLLBACK DETECTED: ${relPath} matches a historical commit`);
    if (restoreFromHead(relPath)) {
      alert(`AUTO-RESTORED: ${relPath} from HEAD`);
    } else {
      alert(`AUTO-RESTORE FAILED: ${relPath}`);
    }
  } else {
    alert(`UNKNOWN CHANGE: ${relPath} not in history — MANUAL REVIEW REQUIRED`);
  }
}

function init() {
  log('=== guard-agents starting ===');
  for (const f of WATCH_FILES) {
    const h = getHeadBlob(f);
    if (h) {
      headBlobs.set(f, h);
      log(`WATCH: ${f} HEAD=${h.slice(0,16)}`);
    } else {
      log(`WARN: ${f} not in HEAD`);
    }
  }
  buildHistoryCache();
  log(`Polling every ${POLL_INTERVAL_MS}ms, history depth ${HISTORY_DEPTH}`);
}

function main() {
  init();
  setInterval(() => {
    for (const f of WATCH_FILES) checkFile(f);
  }, POLL_INTERVAL_MS);
}

main();