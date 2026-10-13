import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const connectHandler = app.match(/const connect = async \(provider: string\) => \{([\s\S]*?)\n  const disconnect/);
assert.ok(connectHandler, 'provider connect handler exists');

test('opens Nango Connect UI synchronously before requesting its session token', () => {
  const body = connectHandler[1];
  const openUi = body.indexOf('nango.openConnectUI(');
  const openFrame = body.indexOf('ui.open()');
  const fetchSession = body.indexOf('await request<{ token: string; providerConfigKey: string }');
  assert.ok(openUi >= 0 && openFrame >= 0 && fetchSession >= 0, 'connect flow has UI open and session request');
  assert.ok(openUi < openFrame && openFrame < fetchSession, 'Connect UI must open before the asynchronous session request');
  assert.match(body.slice(fetchSession), /ui\.setSessionToken\(session\.token\)/, 'session token is set on the opened UI');
});
