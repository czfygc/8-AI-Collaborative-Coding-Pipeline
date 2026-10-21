// T-166: intent 落盘回归 —— 枚举校验 / 构造与脱敏 / 落盘与读取 / 与 schema 形状一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { INTENT_ENUM, MODE_TO_INTENT, validateIntent, buildIntent, writeIntentFile, readIntentFile, listIntentFiles } from '../lib/intent.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(REPO_ROOT, 'design-specs', 'intent.schema.json'), 'utf8'));

function tmpReviews() {
  return mkdtempSync(join(tmpdir(), 't166-intent-'));
}

test('枚举与 schema 一致（代码与 schema 不得漂移）', () => {
  const schemaEnum = SCHEMA.properties.intent.enum;
  assert.deepEqual([...schemaEnum].sort(), [...INTENT_ENUM].sort(), 'schema enum 与代码枚举不一致');
  assert.equal(SCHEMA.title, 'titan-gateway-intent');
  for (const f of ['intent', 'target', 'constraints', 'replyChannel']) {
    assert.ok(SCHEMA.required.includes(f), 'schema 必填字段缺 ' + f);
  }
});

test('机器人三档模式 → intent 映射齐（consult/fix/implement）', () => {
  assert.equal(MODE_TO_INTENT.consult, 'consult');
  assert.equal(MODE_TO_INTENT.execute, 'fix');
  assert.equal(MODE_TO_INTENT.codegen, 'implement');
  for (const v of Object.values(MODE_TO_INTENT)) assert.ok(INTENT_ENUM.includes(v), v + ' 不在枚举内');
});

test('validateIntent：合法过、非法抛错', () => {
  assert.equal(validateIntent('fix').ok, true);
  assert.equal(validateIntent('nope').ok, false);
  assert.throws(() => buildIntent({ intent: 'nope' }), /intent 非法/);
});

test('构造：字段名与 schema 一致；长文本截断；疑似密钥打码', () => {
  const obj = buildIntent({
    intent: 'fix',
    target: 'a'.repeat(900),
    constraints: 'key=sk-abcdefghijklmnop',
    replyChannel: '123456',
    runId: 'run-x',
  });
  assert.equal(obj.intent, 'fix');
  assert.equal(obj.replyChannel, '123456');
  assert.equal(obj.runId, 'run-x');
  assert.ok(obj.target.length <= 520, 'target 未截断: ' + obj.target.length);
  assert.match(obj.constraints, /redacted/);
  for (const f of Object.keys(SCHEMA.properties)) {
    assert.ok(f in obj, '缺字段 ' + f);
  }
});

test('落盘与读取：文件名带 epoch ms；内容可回读；列表倒序', () => {
  const reviews = tmpReviews();
  try {
    const a = buildIntent({ intent: 'consult', target: 'x', replyChannel: '42' });
    const f1 = writeIntentFile(a, { reviewsRoot: reviews });
    assert.ok(/intent-\d+\.json$/.test(f1), f1);
    assert.ok(existsSync(f1));
    const back = readIntentFile(f1);
    assert.equal(back.intent, 'consult');
    assert.equal(back.replyChannel, '42');
    const b = buildIntent({ intent: 'implement', target: 'y', replyChannel: '43' });
    const f2 = writeIntentFile(b, { reviewsRoot: reviews });
    const list = listIntentFiles({ reviewsRoot: reviews });
    assert.equal(list.length, 2);
    assert.ok(list[0] >= list[1], '应按时间倒序');
    assert.ok(f1 !== f2);
  } finally {
    rmSync(reviews, { recursive: true, force: true });
  }
});

test('读取不存在/坏文件不炸（返回 null）', () => {
  assert.equal(readIntentFile(join(tmpdir(), 'no-such-intent.json')), null);
});
