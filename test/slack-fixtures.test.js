import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures', 'slack-export');

/**
 * Tests for Slack export parsing logic.
 *
 * Uses a minimal mock Slack export directory with:
 *   users.json    — 2 users (alice, bob)
 *   channels.json — 1 channel (#general)
 *   general/2024-01-15.json — 3 messages
 */

describe('Slack Export — fixture integrity', () => {
  it('users.json contains expected users', () => {
    const users = JSON.parse(readFileSync(join(FIXTURES, 'users.json'), 'utf-8'));
    assert.equal(users.length, 2);
    assert.equal(users[0].name, 'alice');
    assert.equal(users[1].name, 'bob');
    assert.ok(users[0].profile.email);
  });

  it('channels.json contains expected channel', () => {
    const channels = JSON.parse(readFileSync(join(FIXTURES, 'channels.json'), 'utf-8'));
    assert.equal(channels.length, 1);
    assert.equal(channels[0].name, 'general');
    assert.ok(channels[0].members.includes('U001'));
  });

  it('message file exists with correct format', () => {
    const msgs = JSON.parse(readFileSync(join(FIXTURES, 'general', '2024-01-15.json'), 'utf-8'));
    assert.equal(msgs.length, 3);
    assert.equal(msgs[0].type, 'message');
    assert.ok(msgs[0].ts);
    assert.ok(msgs[0].user);
    assert.ok(msgs[0].text);
  });
});

describe('Slack Export — user ID mapping', () => {
  it('Slack user IDs are U-prefixed strings', () => {
    const users = JSON.parse(readFileSync(join(FIXTURES, 'users.json'), 'utf-8'));
    for (const u of users) {
      assert.match(u.id, /^U\d+$/, `user ID should be U-prefixed: ${u.id}`);
    }
  });

  it('can build Matrix ID from Slack username + domain', () => {
    const users = JSON.parse(readFileSync(join(FIXTURES, 'users.json'), 'utf-8'));
    const domain = 'twake.app';
    const mapping = {};
    for (const u of users) {
      mapping[u.id] = `@${u.name}:${domain}`;
    }
    assert.equal(mapping['U001'], '@alice:twake.app');
    assert.equal(mapping['U002'], '@bob:twake.app');
  });
});

describe('Slack Export — message parsing', () => {
  let messages;

  it('loads messages from daily files', () => {
    messages = JSON.parse(readFileSync(join(FIXTURES, 'general', '2024-01-15.json'), 'utf-8'));
    assert.equal(messages.length, 3);
  });

  it('timestamps are Slack epoch strings', () => {
    for (const msg of messages) {
      assert.match(msg.ts, /^\d+\.\d+$/, 'Slack ts format is "epoch.sequence"');
    }
  });

  it('messages are chronologically ordered', () => {
    const times = messages.map(m => parseFloat(m.ts));
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] > times[i - 1], `message ${i} should be after message ${i - 1}`);
    }
  });

  it('detects user mentions in Slack markup (<@U001>)', () => {
    const mentionMsg = messages.find(m => m.text.includes('<@'));
    assert.ok(mentionMsg, 'should have a message with a user mention');
    assert.match(mentionMsg.text, /<@U\d+>/);
  });

  it('detects links in Slack markup (<url|label>)', () => {
    const linkMsg = messages.find(m => m.text.includes('<http'));
    assert.ok(linkMsg, 'should have a message with a link');
    assert.match(linkMsg.text, /<https?:\/\/[^|]+\|[^>]+>/);
  });
});

describe('Slack Export — importSlack validation', () => {
  it('rejects non-existent export directory', async () => {
    const { importSlack } = await import('../src/importers/slack.js');
    await assert.rejects(
      () => importSlack('/nonexistent/path', {}),
      /not found/
    );
  });

  it('rejects directory without channels.json', async () => {
    const { importSlack } = await import('../src/importers/slack.js');
    await assert.rejects(
      () => importSlack('/tmp', {}),
      /channels\.json not found/
    );
  });
});
