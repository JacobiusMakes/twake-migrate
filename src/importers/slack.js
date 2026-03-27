/**
 * Slack importer — Parse Slack workspace exports and import into Twake
 *
 * Slack export format (standard export):
 *   export-dir/
 *     channels.json       — Channel metadata (name, topic, members, archived)
 *     users.json          — User profiles (id, name, real_name, email)
 *     integration_logs.json
 *     <channel-name>/     — One directory per channel
 *       2024-01-15.json   — Messages for that date (chronological)
 *       2024-01-16.json
 *       ...
 *
 * Each message JSON file contains an array of message objects:
 *   { type, user, text, ts, reactions, files, thread_ts, reply_count, ... }
 *
 * This importer:
 *   1. Reads channels.json to discover all channels
 *   2. Reads users.json to build a username → Matrix ID mapping
 *   3. Creates corresponding Matrix rooms via the MatrixClient
 *   4. Imports messages in chronological order, preserving sender attribution
 *   5. Uploads file attachments to Matrix (and optionally Twake Drive)
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { MatrixClient } from '../exporters/matrix.js';
import { DriveClient, formatBytes } from '../exporters/drive.js';

/**
 * Main entry point for Slack import.
 *
 * @param {string} exportDir - Path to extracted Slack export directory
 * @param {Object} opts      - Migration options (from CLI)
 */
export async function importSlack(exportDir, opts) {
  // ── Validate export directory ───────────────────────────────────
  if (!existsSync(exportDir) || !statSync(exportDir).isDirectory()) {
    throw new Error(`Slack export directory not found: ${exportDir}`);
  }

  const channelsFile = join(exportDir, 'channels.json');
  if (!existsSync(channelsFile)) {
    throw new Error(
      `Invalid Slack export: channels.json not found in ${exportDir}\n` +
      '  Make sure you extracted the Slack export ZIP file.'
    );
  }

  console.log('\n  twake-migrate: Slack workspace import');
  console.log('  =====================================\n');

  // ── Parse export data ───────────────────────────────────────────
  const channels = JSON.parse(readFileSync(channelsFile, 'utf-8'));
  const usersFile = join(exportDir, 'users.json');
  const users = existsSync(usersFile)
    ? JSON.parse(readFileSync(usersFile, 'utf-8'))
    : [];

  console.log(`  Source: ${exportDir}`);
  console.log(`  Channels found: ${channels.length}`);
  console.log(`  Users found: ${users.length}`);

  // ── Build user mapping ──────────────────────────────────────────
  const userMap = buildUserMap(users, opts.domain);
  if (opts.verbose) {
    console.log('\n  User mapping:');
    for (const [slackId, info] of userMap) {
      console.log(`    ${info.displayName.padEnd(25)} → ${info.matrixId}`);
    }
  }

  // ── Filter channels ─────────────────────────────────────────────
  let targetChannels = channels;

  if (opts.channelFilter) {
    targetChannels = channels.filter(c => c.name === opts.channelFilter);
    if (targetChannels.length === 0) {
      throw new Error(`Channel "${opts.channelFilter}" not found in export`);
    }
  }

  if (opts.skipArchived) {
    const before = targetChannels.length;
    targetChannels = targetChannels.filter(c => !c.is_archived);
    if (opts.verbose && before !== targetChannels.length) {
      console.log(`  Skipping ${before - targetChannels.length} archived channels`);
    }
  }

  console.log(`  Channels to import: ${targetChannels.length}`);

  // ── Scan messages ───────────────────────────────────────────────
  const channelStats = [];
  let totalMessages = 0;
  let totalFiles = 0;

  for (const channel of targetChannels) {
    const channelDir = join(exportDir, channel.name);
    const { messageCount, fileCount, dateRange } = scanChannelDir(channelDir);
    totalMessages += messageCount;
    totalFiles += fileCount;
    channelStats.push({
      name: channel.name,
      messages: messageCount,
      files: fileCount,
      dateRange,
      topic: channel.topic?.value || '',
      isArchived: channel.is_archived || false,
      isPrivate: channel.is_private || false,
      members: channel.members || [],
    });
  }

  console.log(`  Total messages: ${totalMessages.toLocaleString()}`);
  console.log(`  Total file references: ${totalFiles.toLocaleString()}`);

  if (opts.verbose) {
    console.log('\n  Channel breakdown:');
    for (const cs of channelStats) {
      const flags = [
        cs.isArchived ? 'archived' : '',
        cs.isPrivate ? 'private' : 'public',
      ].filter(Boolean).join(', ');
      console.log(
        `    #${cs.name.padEnd(25)} ${String(cs.messages).padStart(6)} msgs  ${String(cs.files).padStart(4)} files  (${flags})`
      );
      if (cs.dateRange) {
        console.log(`      ${' '.repeat(25)} ${cs.dateRange}`);
      }
    }
  }

  // ── Dry run stops here ──────────────────────────────────────────
  if (opts.dryRun) {
    console.log('\n  --- DRY RUN SUMMARY ---');
    console.log(`  Would create ${targetChannels.length} Matrix rooms`);
    console.log(`  Would import ${totalMessages.toLocaleString()} messages`);
    console.log(`  Would upload ${totalFiles.toLocaleString()} file attachments`);
    console.log(`  Would map ${users.length} Slack users to Matrix IDs\n`);
    return;
  }

  // ── Initialize clients ──────────────────────────────────────────
  const matrix = new MatrixClient({
    homeserver: opts.homeserver,
    accessToken: opts.accessToken,
    domain: opts.domain,
  });

  let drive = null;
  if (opts.driveUrl && opts.driveToken && !opts.skipFiles) {
    drive = new DriveClient({
      instanceUrl: opts.driveUrl,
      token: opts.driveToken,
    });
  }

  console.log(`\n  Target: ${opts.homeserver}`);
  console.log(`  Domain: ${opts.domain}`);
  if (drive) console.log(`  Drive: ${opts.driveUrl}`);
  console.log('');

  // ── Import channels one by one ──────────────────────────────────
  let channelsDone = 0;
  const startTime = Date.now();

  for (const cs of channelStats) {
    channelsDone++;
    const progress = `[${channelsDone}/${channelStats.length}]`;
    console.log(`  ${progress} #${cs.name} (${cs.messages} messages, ${cs.files} files)`);

    // Step 1: Create Matrix room
    try {
      const roomId = await matrix.createRoom({
        name: cs.name,
        topic: cs.topic || `Imported from Slack #${cs.name}`,
        alias: `slack-${cs.name}`,
        isPrivate: cs.isPrivate,
      });

      if (opts.verbose) {
        console.log(`    Room created: ${roomId}`);
      }

      // Step 2: Import messages
      const messages = loadChannelMessages(join(exportDir, cs.name), userMap);

      if (messages.length > 0) {
        const sent = await matrix.sendMessageBatch(
          roomId,
          messages,
          opts.batchSize,
          (done, total) => {
            if (opts.verbose && done % 100 === 0) {
              console.log(`    Messages: ${done}/${total}`);
            }
          }
        );
        console.log(`    Imported ${sent} messages`);
      }

      // Step 3: Upload file attachments
      if (!opts.skipFiles && cs.files > 0) {
        const files = extractFileReferences(join(exportDir, cs.name));
        let filesUploaded = 0;

        // Upload to Matrix content repo
        for (const file of files) {
          const filePath = join(exportDir, file.urlPrivate || file.name);
          if (existsSync(filePath)) {
            try {
              const fileData = readFileSync(filePath);
              await matrix.sendFileMessage(
                roomId,
                fileData,
                file.name,
                file.mimetype || 'application/octet-stream',
                { sender: file.sender }
              );
              filesUploaded++;
            } catch (err) {
              if (opts.verbose) {
                console.error(`    Warning: Failed to upload ${file.name}: ${err.message}`);
              }
            }
          }
        }

        // Also upload to Twake Drive if configured
        if (drive && files.length > 0) {
          try {
            const folderId = await drive.ensureFolderPath(`Migrated/Slack/${cs.name}`);
            for (const file of files) {
              const filePath = join(exportDir, file.urlPrivate || file.name);
              if (existsSync(filePath)) {
                const fileData = readFileSync(filePath);
                await drive.uploadFile(fileData, file.name, folderId, {
                  contentType: file.mimetype,
                });
              }
            }
          } catch (err) {
            if (opts.verbose) {
              console.error(`    Warning: Drive upload failed: ${err.message}`);
            }
          }
        }

        if (filesUploaded > 0) {
          console.log(`    Uploaded ${filesUploaded} files`);
        }
      }
    } catch (err) {
      console.error(`    Error importing #${cs.name}: ${err.message}`);
      if (opts.verbose) console.error(err.stack);
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const matrixStats = matrix.getStats();
  const driveStats = drive ? drive.getStats() : null;

  console.log('\n  ── Migration Complete ──────────────────────');
  console.log(`  Duration: ${elapsed}s`);
  console.log(`  Rooms created: ${matrixStats.roomsCreated}`);
  console.log(`  Messages sent: ${matrixStats.messagesSent.toLocaleString()}`);
  console.log(`  Files uploaded (Matrix): ${matrixStats.filesUploaded}`);
  if (driveStats) {
    console.log(`  Files uploaded (Drive): ${driveStats.filesUploaded} (${formatBytes(driveStats.bytesUploaded)})`);
  }
  if (matrixStats.errors > 0) {
    console.log(`  Errors: ${matrixStats.errors}`);
  }
  console.log('');
}

// ── Helper Functions ──────────────────────────────────────────────

/**
 * Build a mapping from Slack user IDs to Matrix user info.
 *
 * @param {Array} users  - Slack users.json array
 * @param {string} domain - Matrix domain
 * @returns {Map<string, {matrixId: string, displayName: string, email: string}>}
 */
function buildUserMap(users, domain) {
  const map = new Map();

  for (const user of users) {
    if (user.deleted || user.is_bot) continue;

    const displayName = user.real_name || user.profile?.real_name || user.name;
    const localpart = user.name
      .toLowerCase()
      .replace(/[\s.]+/g, '_')
      .replace(/[^a-z0-9_\-]/g, '');

    map.set(user.id, {
      matrixId: `@${localpart}:${domain}`,
      displayName,
      email: user.profile?.email || '',
      slackName: user.name,
    });
  }

  // Add a fallback for unknown users
  map.set('USLACKBOT', {
    matrixId: `@slackbot:${domain}`,
    displayName: 'Slackbot',
    email: '',
    slackName: 'slackbot',
  });

  return map;
}

/**
 * Scan a channel directory to count messages and files without loading everything.
 *
 * @param {string} channelDir
 * @returns {{messageCount: number, fileCount: number, dateRange: string|null}}
 */
function scanChannelDir(channelDir) {
  if (!existsSync(channelDir) || !statSync(channelDir).isDirectory()) {
    return { messageCount: 0, fileCount: 0, dateRange: null };
  }

  const files = readdirSync(channelDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  let messageCount = 0;
  let fileCount = 0;

  for (const file of files) {
    try {
      const messages = JSON.parse(readFileSync(join(channelDir, file), 'utf-8'));
      if (Array.isArray(messages)) {
        messageCount += messages.length;
        for (const msg of messages) {
          if (msg.files && Array.isArray(msg.files)) {
            fileCount += msg.files.length;
          }
        }
      }
    } catch {
      // Skip malformed JSON files
    }
  }

  const dateRange = files.length > 0
    ? `${files[0].replace('.json', '')} to ${files[files.length - 1].replace('.json', '')}`
    : null;

  return { messageCount, fileCount, dateRange };
}

/**
 * Load all messages from a channel directory in chronological order.
 *
 * Converts Slack message format to a flat array suitable for MatrixClient.sendMessageBatch().
 *
 * @param {string} channelDir
 * @param {Map} userMap
 * @returns {Array<{text: string, sender: string, timestamp: number}>}
 */
function loadChannelMessages(channelDir, userMap) {
  if (!existsSync(channelDir)) return [];

  const files = readdirSync(channelDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const allMessages = [];

  for (const file of files) {
    try {
      const messages = JSON.parse(readFileSync(join(channelDir, file), 'utf-8'));
      if (!Array.isArray(messages)) continue;

      for (const msg of messages) {
        // Skip non-message entries (channel_join, channel_leave, etc.)
        if (msg.subtype && !['bot_message', 'file_share', 'me_message'].includes(msg.subtype)) {
          continue;
        }

        const text = convertSlackMarkup(msg.text || '', userMap);
        if (!text.trim()) continue;

        const userInfo = userMap.get(msg.user);
        const sender = userInfo?.displayName || msg.username || msg.user || 'unknown';
        const timestamp = msg.ts ? parseFloat(msg.ts) * 1000 : Date.now();

        allMessages.push({ text, sender, timestamp });
      }
    } catch {
      // Skip malformed files
    }
  }

  // Sort by timestamp (should already be sorted, but be safe)
  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  return allMessages;
}

/**
 * Convert Slack-specific markup to plain text.
 *
 * Slack uses a custom markup format:
 *   <@U12345>      → @username (user mention)
 *   <#C12345|name> → #name (channel mention)
 *   <url|label>    → label (link)
 *   *bold*         → bold (same as Markdown)
 *   _italic_       → italic
 *   ~strike~       → strikethrough
 *   ```code```     → code block
 *
 * @param {string} text    - Slack message text
 * @param {Map}    userMap - Slack user ID → info mapping
 * @returns {string} Converted text
 */
function convertSlackMarkup(text, userMap) {
  let converted = text;

  // User mentions: <@U12345> → @displayName
  converted = converted.replace(/<@(U[A-Z0-9]+)>/g, (_, userId) => {
    const user = userMap.get(userId);
    return user ? `@${user.displayName}` : `@${userId}`;
  });

  // Channel mentions: <#C12345|channel-name> → #channel-name
  converted = converted.replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1');

  // Links: <url|label> → label (url)
  converted = converted.replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)');

  // Bare links: <url> → url
  converted = converted.replace(/<(https?:\/\/[^>]+)>/g, '$1');

  // Special tokens
  converted = converted.replace(/<!here>/g, '@here');
  converted = converted.replace(/<!channel>/g, '@channel');
  converted = converted.replace(/<!everyone>/g, '@everyone');

  // HTML entities
  converted = converted.replace(/&amp;/g, '&');
  converted = converted.replace(/&lt;/g, '<');
  converted = converted.replace(/&gt;/g, '>');

  return converted;
}

/**
 * Extract file attachment references from a channel's messages.
 *
 * @param {string} channelDir
 * @returns {Array<{name: string, mimetype: string, urlPrivate: string, sender: string}>}
 */
function extractFileReferences(channelDir) {
  if (!existsSync(channelDir)) return [];

  const files = readdirSync(channelDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  const attachments = [];

  for (const file of files) {
    try {
      const messages = JSON.parse(readFileSync(join(channelDir, file), 'utf-8'));
      if (!Array.isArray(messages)) continue;

      for (const msg of messages) {
        if (msg.files && Array.isArray(msg.files)) {
          for (const f of msg.files) {
            attachments.push({
              name: f.name || f.title || 'unnamed',
              mimetype: f.mimetype || 'application/octet-stream',
              urlPrivate: f.url_private_download || f.url_private || '',
              sender: msg.user || 'unknown',
              size: f.size || 0,
            });
          }
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  return attachments;
}
