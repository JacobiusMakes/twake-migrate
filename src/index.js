#!/usr/bin/env node

/**
 * twake-migrate — Workspace migration tool for Twake Workplace
 *
 * Imports data from Slack and Google Workspace into Linagora's
 * open-source collaboration stack:
 *   - Twake Chat (Matrix) — channels, messages, threads
 *   - Twake Mail (JMAP/TMail) — email archives
 *   - Twake Drive (Cozy) — files, documents, attachments
 *
 * License: AGPL-3.0 (matching Linagora's licensing)
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { importSlack } from './importers/slack.js';
import { importGoogle } from './importers/google.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const program = new Command();

program
  .name('twake-migrate')
  .description('Migrate from Slack and Google Workspace to Twake Workplace')
  .version(pkg.version);

// ── Slack Import ────────────────────────────────────────────────────
program
  .command('slack')
  .description('Import a Slack workspace export into Twake')
  .argument('<export-dir>', 'Path to extracted Slack export directory')
  .requiredOption('--homeserver <url>', 'Matrix homeserver URL (e.g. https://matrix.twake.app)')
  .requiredOption('--token <token>', 'Matrix admin access token')
  .option('--domain <domain>', 'Matrix domain for user IDs (default: server hostname)')
  .option('--drive-url <url>', 'Cozy instance URL for file uploads')
  .option('--drive-token <token>', 'Cozy bearer token for file uploads')
  .option('--batch-size <n>', 'Messages per batch', '100')
  .option('--skip-files', 'Skip file attachment uploads', false)
  .option('--skip-archived', 'Skip archived channels', false)
  .option('--channel <name>', 'Import only a specific channel')
  .option('--verbose', 'Show detailed progress', false)
  .action(async (exportDir, opts) => {
    try {
      await importSlack(exportDir, {
        homeserver: opts.homeserver,
        accessToken: opts.token,
        domain: opts.domain || new URL(opts.homeserver).hostname,
        driveUrl: opts.driveUrl,
        driveToken: opts.driveToken,
        batchSize: parseInt(opts.batchSize, 10),
        skipFiles: opts.skipFiles,
        skipArchived: opts.skipArchived,
        channelFilter: opts.channel,
        verbose: opts.verbose,
        dryRun: false,
      });
    } catch (err) {
      console.error(`\n  Migration failed: ${err.message}`);
      if (opts.verbose) console.error(err.stack);
      process.exit(1);
    }
  });

// ── Google Workspace Import ─────────────────────────────────────────
program
  .command('google')
  .description('Import Google Takeout data into Twake')
  .argument('<takeout-dir>', 'Path to extracted Google Takeout directory')
  .requiredOption('--homeserver <url>', 'Matrix homeserver URL')
  .requiredOption('--token <token>', 'Matrix admin access token')
  .option('--domain <domain>', 'Matrix domain for user IDs')
  .option('--jmap-url <url>', 'JMAP session URL for email import')
  .option('--jmap-token <token>', 'JMAP bearer token')
  .option('--drive-url <url>', 'Cozy instance URL for Drive file uploads')
  .option('--drive-token <token>', 'Cozy bearer token')
  .option('--skip-mail', 'Skip Gmail import', false)
  .option('--skip-drive', 'Skip Google Drive import', false)
  .option('--skip-chat', 'Skip Google Chat/Hangouts import', false)
  .option('--verbose', 'Show detailed progress', false)
  .action(async (takeoutDir, opts) => {
    try {
      await importGoogle(takeoutDir, {
        homeserver: opts.homeserver,
        accessToken: opts.token,
        domain: opts.domain || new URL(opts.homeserver).hostname,
        jmapUrl: opts.jmapUrl,
        jmapToken: opts.jmapToken,
        driveUrl: opts.driveUrl,
        driveToken: opts.driveToken,
        skipMail: opts.skipMail,
        skipDrive: opts.skipDrive,
        skipChat: opts.skipChat,
        verbose: opts.verbose,
        dryRun: false,
      });
    } catch (err) {
      console.error(`\n  Migration failed: ${err.message}`);
      if (opts.verbose) console.error(err.stack);
      process.exit(1);
    }
  });

// ── Dry Run (Preview) ──────────────────────────────────────────────
program
  .command('dry-run')
  .description('Preview what would be imported without making changes')
  .argument('<source>', 'Source type: "slack" or "google"')
  .argument('<dir>', 'Path to export/takeout directory')
  .option('--verbose', 'Show detailed item listing', false)
  .action(async (source, dir, opts) => {
    try {
      const dryRunOpts = {
        dryRun: true,
        verbose: opts.verbose,
        // Dummy credentials — dry run never contacts APIs
        homeserver: 'https://dry-run.localhost',
        accessToken: 'dry-run-token',
        domain: 'dry-run.localhost',
      };

      if (source === 'slack') {
        await importSlack(dir, dryRunOpts);
      } else if (source === 'google') {
        await importGoogle(dir, dryRunOpts);
      } else {
        console.error(`Unknown source "${source}". Use "slack" or "google".`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`\n  Dry run failed: ${err.message}`);
      if (opts.verbose) console.error(err.stack);
      process.exit(1);
    }
  });

// ── Global Error Handling ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error(`\nFatal error: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error(`\nUnhandled error: ${err?.message || String(err)}`);
  process.exit(1);
});

program.parse();
