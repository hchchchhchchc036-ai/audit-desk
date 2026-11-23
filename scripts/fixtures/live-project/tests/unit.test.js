import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { canRead } from '../src/auth.js';
test('record owner may read; another user and missing identity cannot',()=>{
  assert.equal(canRead({id:1},{ownerId:1}),true);
  assert.equal(canRead({id:2},{ownerId:1}),false);
  assert.equal(canRead(null,{ownerId:1}),false);
});
