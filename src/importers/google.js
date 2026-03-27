/**
 * Google Workspace importer — Parse Google Takeout data and import into Twake
 *
 * Google Takeout export structure:
 *   takeout-dir/
 *     Takeout/
 *       Mail/
 *         All mail Including Spam and Trash.mbox  — Complete email archive
 *       Drive/
 *         My Drive/          — Google Drive files
 *           folder/
 *             file.docx
 *         Shared with me/    — Shared files
 *       Google Chat/
 *         Groups/
 *           <group-name>/
 *             messages.json  — Chat messages
 *         Users/
 *           <user>/
 *             messages.json  — DM messages
 *       Hangouts/
 *         Hangouts.json      — Legacy Hangouts data
 *
 * This importer handles three data types:
 *   1. Gmail (mbox) → Twake Mail via JMAP
 *   2. Google Drive files → Twake Drive via Cozy API
 *   3. Google Chat / Hangouts → Twake Chat via Matrix API
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename, relative, extname } from 'path';
import { MatrixClient } from '../exporters/matrix.js';
import { DriveClient, formatBytes } from '../exporters/drive.js';
import { JmapClient, parseMbox } from '../exporters/jmap.js';

/**
 * Main entry point for Google Workspace import.
 *
 * @param {string} takeoutDir - Path to extracted Google Takeout directory
 * @param {Object} opts       - Migration options (from CLI)
 */
export async function importGoogle(takeoutDir, opts) {
  // ── Validate takeout directory ──────────────────────────────────
  if (!existsSync(takeoutDir) || !statSync(takeoutDir).isDirectory()) {
    throw new Error(`Google Takeout directory not found: ${takeoutDir}`);
  }

  // Handle both "takeout-dir/" and "takeout-dir/Takeout/" structures
  const takeoutRoot = existsSync(join(takeoutDir, 'Takeout'))
    ? join(takeoutDir, 'Takeout')
    : takeoutDir;

  console.log('\n  twake-migrate: Google Workspace import');
  console.log('  ======================================\n');
  console.log(`  Source: ${takeoutDir}`);

  // ── Discover available data ─────────────────────────────────────
  const mailDir = findDir(takeoutRoot, ['Mail', 'Gmail']);
  const driveDir = findDir(takeoutRoot, ['Drive', 'Google Drive']);
  const chatDir = findDir(takeoutRoot, ['Google Chat', 'Chat']);
  const hangoutsDir = findDir(takeoutRoot, ['Hangouts']);

  const available = [];
  if (mailDir) available.push('Gmail');
  if (driveDir) available.push('Google Drive');
  if (chatDir) available.push('Google Chat');
  if (hangoutsDir) available.push('Hangouts');

  if (available.length === 0) {
    throw new Error(
      'No supported Google data found in takeout directory.\n' +
      '  Expected subdirectories: Mail/, Drive/, Google Chat/, or Hangouts/\n' +
      '  Make sure you extracted the Google Takeout ZIP file.'
    );
  }

  console.log(`  Available data: ${available.join(', ')}`);

  // ── Scan data sizes ─────────────────────────────────────────────
  const scanResults = {
    mail: mailDir ? scanMailDir(mailDir) : null,
    drive: driveDir ? scanDriveDir(driveDir) : null,
    chat: chatDir ? scanChatDir(chatDir) : null,
    hangouts: hangoutsDir ? scanHangoutsFile(hangoutsDir) : null,
  };

  if (scanResults.mail) {
    console.log(`  Gmail: ${scanResults.mail.mboxCount} mbox file(s), ~${scanResults.mail.emailEstimate.toLocaleString()} emails (${formatBytes(scanResults.mail.totalSize)})`);
  }
  if (scanResults.drive) {
    console.log(`  Drive: ${scanResults.drive.fileCount.toLocaleString()} files in ${scanResults.drive.folderCount} folders (${formatBytes(scanResults.drive.totalSize)})`);
  }
  if (scanResults.chat) {
    console.log(`  Chat: ${scanResults.chat.groupCount} groups, ${scanResults.chat.dmCount} DMs, ~${scanResults.chat.messageEstimate.toLocaleString()} messages`);
  }
  if (scanResults.hangouts) {
    console.log(`  Hangouts: ${scanResults.hangouts.conversationCount} conversations`);
  }

  // ── Dry run stops here ──────────────────────────────────────────
  if (opts.dryRun) {
    console.log('\n  --- DRY RUN SUMMARY ---');
    if (scanResults.mail && !opts.skipMail) {
      console.log(`  Would import ~${scanResults.mail.emailEstimate.toLocaleString()} emails into Twake Mail`);
    }
    if (scanResults.drive && !opts.skipDrive) {
      console.log(`  Would upload ${scanResults.drive.fileCount.toLocaleString()} files to Twake Drive (${formatBytes(scanResults.drive.totalSize)})`);
    }
    if ((scanResults.chat || scanResults.hangouts) && !opts.skipChat) {
      const totalConversations = (scanResults.chat?.groupCount || 0) + (scanResults.chat?.dmCount || 0) + (scanResults.hangouts?.conversationCount || 0);
      console.log(`  Would create ${totalConversations} Matrix rooms for chat history`);
    }
    console.log('');
    return;
  }

  // ── Initialize clients ──────────────────────────────────────────
  const matrix = new MatrixClient({
    homeserver: opts.homeserver,
    accessToken: opts.accessToken,
    domain: opts.domain,
  });

  let jmap = null;
  if (opts.jmapUrl && opts.jmapToken && !opts.skipMail) {
    jmap = new JmapClient({
      sessionUrl: opts.jmapUrl,
      bearerToken: opts.jmapToken,
    });
  }

  let drive = null;
  if (opts.driveUrl && opts.driveToken && !opts.skipDrive) {
    drive = new DriveClient({
      instanceUrl: opts.driveUrl,
      token: opts.driveToken,
    });
  }

  console.log(`\n  Target: ${opts.homeserver}`);
  if (jmap) console.log(`  Mail: ${opts.jmapUrl}`);
  if (drive) console.log(`  Drive: ${opts.driveUrl}`);
  console.log('');

  const startTime = Date.now();

  // ── Phase 1: Gmail import ───────────────────────────────────────
  if (mailDir && jmap && !opts.skipMail) {
    console.log('  Phase 1: Importing Gmail...');
    try {
      await importGmail(mailDir, jmap, opts);
    } catch (err) {
      console.error(`  Gmail import error: ${err.message}`);
      if (opts.verbose) console.error(err.stack);
    }
  } else if (mailDir && !opts.skipMail && !jmap) {
    console.log('  Phase 1: Skipping Gmail (no JMAP credentials provided)');
    console.log('    Use --jmap-url and --jmap-token to enable email import');
  } else {
    console.log('  Phase 1: Gmail import skipped');
  }

  // ── Phase 2: Google Drive import ────────────────────────────────
  if (driveDir && drive && !opts.skipDrive) {
    console.log('\n  Phase 2: Importing Google Drive...');
    try {
      await importDriveFiles(driveDir, drive, opts);
    } catch (err) {
      console.error(`  Drive import error: ${err.message}`);
      if (opts.verbose) console.error(err.stack);
    }
  } else if (driveDir && !opts.skipDrive && !drive) {
    console.log('\n  Phase 2: Skipping Drive (no Cozy credentials provided)');
    console.log('    Use --drive-url and --drive-token to enable file import');
  } else {
    console.log('\n  Phase 2: Google Drive import skipped');
  }

  // ── Phase 3: Google Chat / Hangouts import ──────────────────────
  if (!opts.skipChat) {
    if (chatDir || hangoutsDir) {
      console.log('\n  Phase 3: Importing chat history...');
    }

    if (chatDir) {
      try {
        await importGoogleChat(chatDir, matrix, opts);
      } catch (err) {
        console.error(`  Google Chat import error: ${err.message}`);
        if (opts.verbose) console.error(err.stack);
      }
    }

    if (hangoutsDir) {
      try {
        await importHangouts(hangoutsDir, matrix, opts);
      } catch (err) {
        console.error(`  Hangouts import error: ${err.message}`);
        if (opts.verbose) console.error(err.stack);
      }
    }
  } else {
    console.log('\n  Phase 3: Chat import skipped');
  }

  // ── Summary ─────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const matrixStats = matrix.getStats();
  const jmapStats = jmap ? jmap.getStats() : null;
  const driveStats = drive ? drive.getStats() : null;

  console.log('\n  ── Migration Complete ──────────────────────');
  console.log(`  Duration: ${elapsed}s`);

  if (jmapStats) {
    console.log(`  Emails imported: ${jmapStats.emailsImported.toLocaleString()}`);
    if (jmapStats.mailboxesCreated > 0) {
      console.log(`  Mailboxes created: ${jmapStats.mailboxesCreated}`);
    }
  }

  if (driveStats) {
    console.log(`  Files uploaded to Drive: ${driveStats.filesUploaded.toLocaleString()} (${formatBytes(driveStats.bytesUploaded)})`);
    if (driveStats.foldersCreated > 0) {
      console.log(`  Folders created: ${driveStats.foldersCreated}`);
    }
  }

  console.log(`  Chat rooms created: ${matrixStats.roomsCreated}`);
  console.log(`  Chat messages sent: ${matrixStats.messagesSent.toLocaleString()}`);

  const totalErrors = matrixStats.errors + (jmapStats?.errors || 0) + (driveStats?.errors || 0);
  if (totalErrors > 0) {
    console.log(`  Errors: ${totalErrors}`);
  }
  console.log('');
}

// ══════════════════════════════════════════════════════════════════
// ── Gmail Import ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

/**
 * Import Gmail mbox files into Twake Mail via JMAP.
 */
async function importGmail(mailDir, jmap, opts) {
  const mboxFiles = findFiles(mailDir, '.mbox');

  if (mboxFiles.length === 0) {
    console.log('    No mbox files found');
    return;
  }

  // Create an "Imported" mailbox for migrated emails
  const mailboxId = await jmap.ensureMailbox('Imported-Gmail');
  console.log(`    Target mailbox: Imported-Gmail`);

  for (const mboxFile of mboxFiles) {
    const fileName = basename(mboxFile);
    console.log(`    Processing ${fileName}...`);

    const mboxData = readFileSync(mboxFile);
    const emails = parseMbox(mboxData);

    console.log(`    Found ${emails.length} emails`);

    if (emails.length === 0) continue;

    const imported = await jmap.importBatch(
      emails,
      mailboxId,
      (done, total) => {
        if (opts.verbose && done % 50 === 0) {
          console.log(`      Progress: ${done}/${total}`);
        }
      }
    );

    console.log(`    Imported ${imported} emails from ${fileName}`);
  }
}

// ══════════════════════════════════════════════════════════════════
// ── Google Drive Import ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

/**
 * Import Google Drive files into Twake Drive via Cozy API.
 */
async function importDriveFiles(driveDir, drive, opts) {
  // Find the "My Drive" subdirectory
  const myDriveDir = findDir(driveDir, ['My Drive']);
  const sharedDir = findDir(driveDir, ['Shared with me', 'Shared drives']);
  const sourceDirs = [];

  if (myDriveDir) sourceDirs.push({ path: myDriveDir, prefix: 'Migrated/Google Drive/My Drive' });
  if (sharedDir) sourceDirs.push({ path: sharedDir, prefix: 'Migrated/Google Drive/Shared' });

  // Fallback: use the drive dir itself
  if (sourceDirs.length === 0) {
    sourceDirs.push({ path: driveDir, prefix: 'Migrated/Google Drive' });
  }

  let totalUploaded = 0;

  for (const { path: sourceDir, prefix } of sourceDirs) {
    console.log(`    Uploading from ${basename(sourceDir)}...`);
    totalUploaded += await uploadDirectoryRecursive(sourceDir, prefix, drive, opts);
  }

  console.log(`    Total files uploaded: ${totalUploaded}`);
}

/**
 * Recursively upload a local directory to Twake Drive.
 *
 * @param {string} localDir     - Local directory path
 * @param {string} remotePath   - Remote folder path in Cozy
 * @param {DriveClient} drive
 * @param {Object} opts
 * @returns {Promise<number>}   Number of files uploaded
 */
async function uploadDirectoryRecursive(localDir, remotePath, drive, opts) {
  if (!existsSync(localDir)) return 0;

  const folderId = await drive.ensureFolderPath(remotePath);
  const entries = readdirSync(localDir);
  let uploaded = 0;

  for (const entry of entries) {
    // Skip hidden files and Google-specific metadata
    if (entry.startsWith('.') || entry.endsWith('.metadata') || entry === 'desktop.ini') {
      continue;
    }

    const fullPath = join(localDir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Recurse into subdirectories
      uploaded += await uploadDirectoryRecursive(
        fullPath,
        `${remotePath}/${entry}`,
        drive,
        opts
      );
    } else if (stat.isFile()) {
      try {
        const fileData = readFileSync(fullPath);
        await drive.uploadFile(fileData, entry, folderId, {
          createdAt: stat.birthtime,
          updatedAt: stat.mtime,
        });
        uploaded++;

        if (opts.verbose) {
          console.log(`      Uploaded: ${entry} (${formatBytes(stat.size)})`);
        }
      } catch (err) {
        if (opts.verbose) {
          console.error(`      Warning: Failed to upload ${entry}: ${err.message}`);
        }
      }
    }
  }

  return uploaded;
}

// ══════════════════════════════════════════════════════════════════
// ── Google Chat Import ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

/**
 * Import Google Chat conversations into Matrix rooms.
 */
async function importGoogleChat(chatDir, matrix, opts) {
  // Import group conversations
  const groupsDir = join(chatDir, 'Groups');
  if (existsSync(groupsDir)) {
    const groups = readdirSync(groupsDir).filter(
      d => statSync(join(groupsDir, d)).isDirectory()
    );

    console.log(`    Found ${groups.length} group conversations`);

    for (const group of groups) {
      const messagesFile = join(groupsDir, group, 'messages.json');
      if (!existsSync(messagesFile)) continue;

      try {
        const messages = parseGoogleChatMessages(messagesFile);
        if (messages.length === 0) continue;

        const roomName = sanitizeRoomName(group);
        const roomId = await matrix.createRoom({
          name: `gchat-${roomName}`,
          topic: `Imported from Google Chat group: ${group}`,
          alias: `gchat-${roomName}`,
        });

        const sent = await matrix.sendMessageBatch(roomId, messages, 100);
        console.log(`    Group "${group}": ${sent} messages imported`);
      } catch (err) {
        console.error(`    Warning: Failed to import group "${group}": ${err.message}`);
      }
    }
  }

  // Import DM conversations
  const usersDir = join(chatDir, 'Users');
  if (existsSync(usersDir)) {
    const dms = readdirSync(usersDir).filter(
      d => statSync(join(usersDir, d)).isDirectory()
    );

    console.log(`    Found ${dms.length} DM conversations`);

    for (const dm of dms) {
      const messagesFile = join(usersDir, dm, 'messages.json');
      if (!existsSync(messagesFile)) continue;

      try {
        const messages = parseGoogleChatMessages(messagesFile);
        if (messages.length === 0) continue;

        const roomName = sanitizeRoomName(dm);
        const roomId = await matrix.createRoom({
          name: `dm-${roomName}`,
          topic: `Imported DM from Google Chat: ${dm}`,
          alias: `gchat-dm-${roomName}`,
          isPrivate: true,
        });

        const sent = await matrix.sendMessageBatch(roomId, messages, 100);
        if (opts.verbose) {
          console.log(`    DM "${dm}": ${sent} messages imported`);
        }
      } catch (err) {
        if (opts.verbose) {
          console.error(`    Warning: Failed to import DM "${dm}": ${err.message}`);
        }
      }
    }
  }
}

/**
 * Parse a Google Chat messages.json file.
 *
 * Google Chat export format:
 *   { messages: [{ creator: {name, email}, created_date, text, ... }] }
 *
 * @param {string} filePath
 * @returns {Array<{text: string, sender: string, timestamp: number}>}
 */
function parseGoogleChatMessages(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    const rawMessages = data.messages || data;

    if (!Array.isArray(rawMessages)) return [];

    return rawMessages
      .filter(msg => msg.text && msg.text.trim())
      .map(msg => ({
        text: msg.text,
        sender: msg.creator?.name || msg.creator?.email || 'unknown',
        timestamp: msg.created_date
          ? new Date(msg.created_date).getTime()
          : Date.now(),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
// ── Hangouts Import ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

/**
 * Import Google Hangouts data into Matrix rooms.
 *
 * Hangouts.json structure:
 *   { conversations: [{ conversation: {id, ...}, events: [{...}] }] }
 */
async function importHangouts(hangoutsDir, matrix, opts) {
  const hangoutsFile = join(hangoutsDir, 'Hangouts.json');
  if (!existsSync(hangoutsFile)) {
    // Try the Takeout-style path
    const altFile = findFiles(hangoutsDir, '.json')[0];
    if (!altFile) {
      console.log('    No Hangouts data found');
      return;
    }
  }

  const targetFile = existsSync(hangoutsFile)
    ? hangoutsFile
    : findFiles(hangoutsDir, '.json')[0];

  if (!targetFile) return;

  let data;
  try {
    data = JSON.parse(readFileSync(targetFile, 'utf-8'));
  } catch (err) {
    console.error(`    Failed to parse Hangouts data: ${err.message}`);
    return;
  }

  const conversations = data.conversations || data.conversation_state || [];
  console.log(`    Found ${conversations.length} Hangouts conversations`);

  let imported = 0;

  for (const conv of conversations) {
    const convData = conv.conversation || conv.conversation_state?.conversation || {};
    const events = conv.events || conv.conversation_state?.event || [];
    const convId = convData.id?.id || convData.conversation_id?.id || `hangout-${imported}`;

    // Extract participant names
    const participants = (convData.participant_data || [])
      .map(p => p.fallback_name || p.id?.chat_id || 'unknown')
      .filter(Boolean);

    const convName = convData.name || participants.slice(0, 3).join(', ') || convId;

    // Parse events into messages
    const messages = events
      .filter(e => {
        const segments = e.chat_message?.message_content?.segment;
        return segments && segments.some(s => s.text);
      })
      .map(e => {
        const segments = e.chat_message.message_content.segment;
        const text = segments.map(s => s.text || '').join('');
        const senderId = e.sender_id?.chat_id || 'unknown';
        const sender = (convData.participant_data || [])
          .find(p => p.id?.chat_id === senderId)?.fallback_name || senderId;
        const timestamp = parseInt(e.timestamp, 10) / 1000; // microseconds to ms

        return { text, sender, timestamp };
      })
      .filter(m => m.text.trim())
      .sort((a, b) => a.timestamp - b.timestamp);

    if (messages.length === 0) continue;

    try {
      const roomAlias = `hangouts-${sanitizeRoomName(convId).slice(0, 50)}`;
      const roomId = await matrix.createRoom({
        name: `Hangouts: ${convName.slice(0, 100)}`,
        topic: `Imported from Google Hangouts (${participants.length} participants)`,
        alias: roomAlias,
        isPrivate: true,
      });

      const sent = await matrix.sendMessageBatch(roomId, messages, 100);
      imported++;

      if (opts.verbose) {
        console.log(`    "${convName}": ${sent} messages imported`);
      }
    } catch (err) {
      if (opts.verbose) {
        console.error(`    Warning: Failed to import "${convName}": ${err.message}`);
      }
    }
  }

  console.log(`    Imported ${imported} Hangouts conversations`);
}

// ══════════════════════════════════════════════════════════════════
// ── Scan/Discovery Helpers ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

/**
 * Find the first matching subdirectory by name variants.
 */
function findDir(parentDir, nameVariants) {
  for (const name of nameVariants) {
    const dir = join(parentDir, name);
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      return dir;
    }
  }
  return null;
}

/**
 * Recursively find files with a specific extension.
 */
function findFiles(dir, extension) {
  const results = [];

  if (!existsSync(dir)) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isFile() && entry.endsWith(extension)) {
      results.push(fullPath);
    } else if (stat.isDirectory() && !entry.startsWith('.')) {
      results.push(...findFiles(fullPath, extension));
    }
  }

  return results;
}

/**
 * Scan Gmail directory for mbox files and estimate email count.
 */
function scanMailDir(mailDir) {
  const mboxFiles = findFiles(mailDir, '.mbox');
  let totalSize = 0;

  for (const f of mboxFiles) {
    totalSize += statSync(f).size;
  }

  // Rough estimate: ~5KB per email on average
  const emailEstimate = Math.round(totalSize / 5120);

  return { mboxCount: mboxFiles.length, totalSize, emailEstimate };
}

/**
 * Scan Google Drive directory for files and folders.
 */
function scanDriveDir(driveDir) {
  let fileCount = 0;
  let folderCount = 0;
  let totalSize = 0;

  function walk(dir) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        folderCount++;
        walk(fullPath);
      } else if (stat.isFile()) {
        fileCount++;
        totalSize += stat.size;
      }
    }
  }

  walk(driveDir);
  return { fileCount, folderCount, totalSize };
}

/**
 * Scan Google Chat directory for conversations.
 */
function scanChatDir(chatDir) {
  let groupCount = 0;
  let dmCount = 0;
  let messageEstimate = 0;

  const groupsDir = join(chatDir, 'Groups');
  if (existsSync(groupsDir)) {
    const groups = readdirSync(groupsDir).filter(
      d => existsSync(join(groupsDir, d)) && statSync(join(groupsDir, d)).isDirectory()
    );
    groupCount = groups.length;

    for (const group of groups) {
      const msgFile = join(groupsDir, group, 'messages.json');
      if (existsSync(msgFile)) {
        try {
          const data = JSON.parse(readFileSync(msgFile, 'utf-8'));
          messageEstimate += (data.messages || data || []).length;
        } catch { /* skip */ }
      }
    }
  }

  const usersDir = join(chatDir, 'Users');
  if (existsSync(usersDir)) {
    const dms = readdirSync(usersDir).filter(
      d => existsSync(join(usersDir, d)) && statSync(join(usersDir, d)).isDirectory()
    );
    dmCount = dms.length;
  }

  return { groupCount, dmCount, messageEstimate };
}

/**
 * Scan Hangouts.json for conversation count.
 */
function scanHangoutsFile(hangoutsDir) {
  const hangoutsFile = join(hangoutsDir, 'Hangouts.json');
  const targetFile = existsSync(hangoutsFile) ? hangoutsFile : findFiles(hangoutsDir, '.json')[0];

  if (!targetFile) return { conversationCount: 0 };

  try {
    const data = JSON.parse(readFileSync(targetFile, 'utf-8'));
    const conversations = data.conversations || data.conversation_state || [];
    return { conversationCount: conversations.length };
  } catch {
    return { conversationCount: 0 };
  }
}

/**
 * Sanitize a string for use as a Matrix room alias.
 */
function sanitizeRoomName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
}
