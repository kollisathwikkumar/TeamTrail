import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const deploymentDir = new URL('../deploy/free-30-days/', import.meta.url);
const read = name => readFileSync(new URL(name, deploymentDir), 'utf8');

test('30-day stack includes the app, static UI, and private persistent data services', () => {
  const compose = read('compose.yaml');
  for (const service of ['api:', 'web:', 'caddy:', 'postgres:', 'falkordb:']) {
    assert.ok(compose.includes(`\n  ${service}`), `missing compose service ${service}`);
  }
  assert.match(compose, /\nvolumes:\s*\n  pgdata:\s*\n  falkordbdata:/);
  assert.match(compose, /BRAIN_AUTH_TOKEN:\s*\$\{BRAIN_AUTH_TOKEN:\?/);
  assert.match(compose, /TEAMTRAIL_MCP_TOKEN:\s*\$\{TEAMTRAIL_MCP_TOKEN:\?/);
  const service = name => compose.split(`\n  ${name}:`)[1]?.split(/\n  [a-z-]+:\n/)[0] || '';
  assert.ok(!/\n    ports:/.test(service('postgres')), 'Postgres must not publish a host port');
  assert.ok(!/\n    ports:/.test(service('falkordb')), 'FalkorDB must not publish a host port');
  assert.match(service('caddy'), /127\.0\.0\.1:\$\{TEAMTRAIL_PORT/);
});

test('HTTPS router sends MCP and API requests to backend and browser routes to the UI', () => {
  const caddy = read('Caddyfile');
  assert.match(caddy, /path \/api\/\* \/sources\/\* \/mcp \/mcp\/\*/);
  assert.match(caddy, /reverse_proxy @backend api:3333/);
  assert.match(caddy, /reverse_proxy web:80/);
});

test('frontend image builds the Vite workspace and supports client-side routing', () => {
  assert.ok(existsSync(new URL('web.Dockerfile', deploymentDir)));
  assert.match(read('web.Dockerfile'), /npm run build -w @company-brain\/teamtrail-web/);
  assert.match(read('nginx.conf'), /try_files \$uri \$uri\/ \/index.html/);
});

test('deployment guide documents trial billing, 30-day exit, integrations, and data export', () => {
  const guide = read('README.md');
  for (const term of ['30-day', 'Google Cloud Free Trial', 'Nango', 'FalkorDB', 'backup', 'MCP']) {
    assert.ok(guide.toLowerCase().includes(term.toLowerCase()), `guide missing ${term}`);
  }
});
