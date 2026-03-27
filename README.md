# twake-migrate

Workspace migration tool for [Twake Workplace](https://twake.app) — import data from Slack and Google Workspace into Linagora's open-source collaboration stack.

## Why This Exists

Enterprises moving to open-source collaboration face a critical barrier: **data migration**. Years of messages, files, and emails are locked inside proprietary platforms. Without a migration path, teams lose institutional knowledge and adoption stalls.

twake-migrate solves this by providing automated, auditable imports from:

- **Slack** — channels, messages, threads, and file attachments
- **Google Workspace** — Gmail, Google Drive, Google Chat, and Hangouts

Data flows into Twake's three core services:

| Source | Target | Protocol |
|--------|--------|----------|
| Slack channels / Google Chat | **Twake Chat** | Matrix Client-Server API |
| Gmail mbox archives | **Twake Mail** | JMAP (RFC 8621) via TMail |
| Slack files / Google Drive | **Twake Drive** | Cozy Files API |

## Installation

```bash
# Clone and install
git clone https://github.com/JacobiusMakes/twake-migrate.git
cd twake-migrate
npm install

# Or install globally
npm install -g .
```

Requires **Node.js 18+** (uses native `fetch`).

## Quick Start

### Preview what would be imported (dry run)

```bash
# Slack
twake-migrate dry-run slack ./slack-export-2024/

# Google Takeout
twake-migrate dry-run google ./takeout-20240115/
```

### Import Slack workspace

```bash
twake-migrate slack ./slack-export/ \
  --homeserver https://matrix.twake.app \
  --token syt_admin_xxxx \
  --domain twake.app \
  --drive-url https://drive.twake.app \
  --drive-token eyJhbG... \
  --verbose
```

### Import Google Workspace

```bash
twake-migrate google ./takeout/ \
  --homeserver https://matrix.twake.app \
  --token syt_admin_xxxx \
  --domain twake.app \
  --jmap-url https://mail.twake.app/jmap \
  --jmap-token eyJhbG... \
  --drive-url https://drive.twake.app \
  --drive-token eyJhbG... \
  --verbose
```

## Commands

### `twake-migrate slack <export-dir>`

Import a Slack workspace export into Twake.

| Option | Description |
|--------|-------------|
| `--homeserver <url>` | Matrix homeserver URL (required) |
| `--token <token>` | Matrix admin access token (required) |
| `--domain <domain>` | Matrix domain for user IDs |
| `--drive-url <url>` | Cozy instance URL for file uploads |
| `--drive-token <token>` | Cozy bearer token |
| `--batch-size <n>` | Messages per batch (default: 100) |
| `--skip-files` | Skip file attachment uploads |
| `--skip-archived` | Skip archived channels |
| `--channel <name>` | Import only a specific channel |
| `--verbose` | Show detailed progress |

### `twake-migrate google <takeout-dir>`

Import Google Takeout data into Twake.

| Option | Description |
|--------|-------------|
| `--homeserver <url>` | Matrix homeserver URL (required) |
| `--token <token>` | Matrix admin access token (required) |
| `--jmap-url <url>` | JMAP session URL for email import |
| `--jmap-token <token>` | JMAP bearer token |
| `--drive-url <url>` | Cozy instance URL for file uploads |
| `--drive-token <token>` | Cozy bearer token |
| `--skip-mail` | Skip Gmail import |
| `--skip-drive` | Skip Google Drive import |
| `--skip-chat` | Skip Google Chat/Hangouts import |
| `--verbose` | Show detailed progress |

### `twake-migrate dry-run <source> <dir>`

Preview what would be imported without contacting any APIs.

## Supported Export Formats

### Slack Export

Use Slack's built-in export feature (Workspace Settings > Import/Export Data). Extract the ZIP file and point twake-migrate at the resulting directory.

Expected structure:
```
slack-export/
  channels.json
  users.json
  general/
    2024-01-15.json
    2024-01-16.json
  engineering/
    ...
```

### Google Takeout

Use [Google Takeout](https://takeout.google.com) to export your data. Select the products you want to migrate (Gmail, Drive, Chat). Extract the ZIP and point twake-migrate at the directory.

Expected structure:
```
takeout/
  Takeout/
    Mail/
      All mail Including Spam and Trash.mbox
    Drive/
      My Drive/
        ...
    Google Chat/
      Groups/
        ...
      Users/
        ...
```

## Architecture

```
src/
  index.js                  CLI entry point (Commander.js)
  importers/
    slack.js                Parse Slack export format
    google.js               Parse Google Takeout format
  exporters/
    matrix.js               Matrix Client-Server API client
    drive.js                Cozy Files API client
    jmap.js                 JMAP email import client
```

The tool follows a **parser/exporter** architecture:

1. **Importers** read and parse source platform export formats
2. **Exporters** write data into Twake's service APIs
3. The CLI orchestrates the flow with progress reporting

## How It Works

### Slack Import Flow

1. Parse `channels.json` to discover channels and metadata
2. Parse `users.json` to build Slack username to Matrix user ID mapping
3. For each channel:
   - Create a Matrix room with matching name and topic
   - Read daily JSON files in chronological order
   - Convert Slack markup (`<@U123>`, `<#C456|name>`) to readable text
   - Send messages via Matrix API with original sender attribution
   - Upload file attachments to Matrix content repository
   - Optionally mirror files to Twake Drive

### Google Import Flow

1. Discover available data types in the Takeout directory
2. **Gmail**: Parse mbox files, upload RFC 5322 blobs via JMAP Email/import
3. **Drive**: Recursively upload files preserving folder structure via Cozy API
4. **Chat/Hangouts**: Parse conversation JSON, create Matrix rooms, import messages

## Design Decisions

- **Zero runtime dependencies** beyond Commander.js for CLI parsing
- Uses Node.js 18+ native `fetch` for all HTTP calls
- Messages include `dev.twake.migrate.*` metadata fields for traceability
- Migrated rooms are tagged with `u.migrated` for easy filtering
- Rate limiting between batches prevents overwhelming target servers
- Errors are logged but don't abort the migration (skip-and-continue)

## License

AGPL-3.0 — matching Linagora's open-source licensing.
