import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { staticCssomErrors } from '../build-support/static-cssom-errors.mjs';

test('CSS parser errors work without dynamic evaluation in an isolated realm', async () => {
  const source = await fs.readFile('node_modules/@acemir/cssom/lib/errorUtils.js', 'utf8');
  const context = { exports: {}, TypeError, RangeError, Error, DOMException,
    eval: () => assert.fail('Dynamic evaluation must not run') };
  vm.runInNewContext(staticCssomErrors(source), context);
  const errors = context.exports.errorUtils;
  assert(errors.createError({}, 'TypeError', 'bad value') instanceof TypeError);
  assert(errors.createError({}, 'RangeError', 'out of bounds') instanceof RangeError);
  const dom = errors.createError({}, 'DOMException', 'bad rule', 'SyntaxError');
  assert(dom instanceof DOMException); assert.equal(dom.name, 'SyntaxError');
  assert(errors.createError({}, 'unrecognized', 'fallback') instanceof Error);
  assert.throws(() => staticCssomErrors('upstream code changed'), /changed/);
  const bundle = await fs.readFile('dist/wechat-history-archive/main.js', 'utf8');
  assert(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(bundle), 'Bundle must not contain dynamic evaluation');
});
