/**
 * JMAP exporter — Import emails into Twake Mail via the JMAP protocol
 *
 * Used by the Google importer to push Gmail mbox data into TMail
 * (Apache James), which powers Twake Mail.
 *
 * JMAP Mail specification:
 *   https://www.rfc-editor.org/rfc/rfc8621
 *
 * TMail-specific notes:
 *   - Uses SHA-256(email) as accountId
 *   - Supports standard JMAP over a single /jmap endpoint
 *   - Email/import accepts RFC 5322 blobs
 */

import { createHash } from 'crypto';

const USER_AGENT = 'twake-migrate/1.0.0';

/**
 * JmapClient — lightweight JMAP client for email migration.
 *
 * Supports session discovery, mailbox management, and email import.
 */
export class JmapClient {
  /**
   * @param {Object} config
   * @param {string} config.sessionUrl  - JMAP session/API URL (e.g. https://mail.twake.app/jmap)
   * @param {string} config.bearerToken - JMAP bearer token
   */
  constructor({ sessionUrl, bearerToken }) {
    this.sessionUrl = sessionUrl.replace(/\/$/, '');
    this.bearerToken = bearerToken;

    // Resolved after first request
    this._accountId = null;
    this._mailboxCache = new Map();

    this.stats = {
      emailsImported: 0,
      mailboxesCreated: 0,
      errors: 0,
    };
  }

  /**
   * Derive the JMAP accountId from the bearer token.
   * TMail uses SHA-256(email) from the JWT payload as the accountId.
   *
   * @returns {string|null}
   */
  _extractAccountId() {
    try {
      const payload = JSON.parse(
        Buffer.from(this.bearerToken.split('.')[1], 'base64').toString()
      );
      const email = payload.email || payload.sub;
      if (!email) return null;
      return createHash('sha256').update(email).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Resolve the accountId, trying session discovery first, then JWT decode.
   *
   * @returns {Promise<string>}
   */
  async getAccountId() {
    if (this._accountId) return this._accountId;

    // Try GET session
    try {
      const res = await fetch(this.sessionUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`,
          'Accept': 'application/json;jmapVersion=rfc-8621',
          'User-Agent': USER_AGENT,
        },
      });
      if (res.ok) {
        const session = await res.json();
        this._accountId = Object.keys(session.accounts || {})[0];
        if (this._accountId) return this._accountId;
      }
    } catch {
      // Fall through to JWT decode
    }

    // Fallback: decode from JWT
    this._accountId = this._extractAccountId();
    if (!this._accountId) {
      throw new Error('Could not determine JMAP account ID from token');
    }

    return this._accountId;
  }

  /**
   * Execute JMAP method calls.
   *
   * @param {Array} methodCalls - Array of [method, args, callId] tuples
   * @param {string[]} [using] - JMAP capabilities to declare
   * @returns {Promise<Array>} Method responses
   */
  async request(methodCalls, using) {
    const accountId = await this.getAccountId();
    const capabilities = using || [
      'urn:ietf:params:jmap:core',
      'urn:ietf:params:jmap:mail',
    ];

    // Inject accountId into each method call's arguments
    const calls = methodCalls.map(([method, args, callId]) => [
      method,
      { accountId, ...args },
      callId,
    ]);

    const res = await fetch(this.sessionUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json;jmapVersion=rfc-8621',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ using: capabilities, methodCalls: calls }),
    });

    if (!res.ok) {
      throw new Error(`JMAP request failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.methodResponses;
  }

  /**
   * List all mailboxes, returning id/name/role for each.
   *
   * @returns {Promise<Array<{id: string, name: string, role: string|null}>>}
   */
  async listMailboxes() {
    const responses = await this.request([
      ['Mailbox/get', { properties: ['id', 'name', 'role', 'parentId'] }, 'boxes'],
    ]);

    const boxResponse = responses.find(r => r[2] === 'boxes');
    const mailboxes = boxResponse?.[1]?.list || [];

    // Update cache
    for (const mb of mailboxes) {
      this._mailboxCache.set(mb.name, mb.id);
      if (mb.role) this._mailboxCache.set(`role:${mb.role}`, mb.id);
    }

    return mailboxes;
  }

  /**
   * Get or create a mailbox by name.
   *
   * @param {string} name - Mailbox name (e.g. "Imported" or "Archive")
   * @returns {Promise<string>} Mailbox ID
   */
  async ensureMailbox(name) {
    if (this._mailboxCache.has(name)) {
      return this._mailboxCache.get(name);
    }

    // Refresh cache
    await this.listMailboxes();
    if (this._mailboxCache.has(name)) {
      return this._mailboxCache.get(name);
    }

    // Create new mailbox
    const accountId = await this.getAccountId();
    const responses = await this.request([
      ['Mailbox/set', {
        create: {
          'new-mailbox': { name },
        },
      }, 'create'],
    ]);

    const createResponse = responses.find(r => r[2] === 'create');
    const created = createResponse?.[1]?.created?.['new-mailbox'];

    if (!created) {
      const err = createResponse?.[1]?.notCreated?.['new-mailbox'];
      throw new Error(`Failed to create mailbox "${name}": ${JSON.stringify(err)}`);
    }

    this._mailboxCache.set(name, created.id);
    this.stats.mailboxesCreated++;
    return created.id;
  }

  /**
   * Get the Inbox mailbox ID.
   *
   * @returns {Promise<string>}
   */
  async getInboxId() {
    if (this._mailboxCache.has('role:inbox')) {
      return this._mailboxCache.get('role:inbox');
    }
    await this.listMailboxes();
    const inboxId = this._mailboxCache.get('role:inbox');
    if (!inboxId) throw new Error('Inbox mailbox not found');
    return inboxId;
  }

  /**
   * Upload an RFC 5322 email blob for import.
   *
   * TMail accepts raw email blobs via the JMAP upload endpoint.
   *
   * @param {Buffer} emailBlob - Raw RFC 5322 email data
   * @returns {Promise<string>} Blob ID for use with Email/import
   */
  async uploadBlob(emailBlob) {
    const accountId = await this.getAccountId();
    const uploadUrl = `${this.sessionUrl}/upload/${accountId}`;

    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.bearerToken}`,
        'Content-Type': 'message/rfc822',
        'User-Agent': USER_AGENT,
      },
      body: emailBlob,
    });

    if (!res.ok) {
      throw new Error(`Blob upload failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    return data.blobId;
  }

  /**
   * Import a single email from an RFC 5322 blob.
   *
   * @param {Buffer} emailBlob  - Raw email data
   * @param {string} mailboxId  - Target mailbox ID
   * @param {Object} [options]
   * @param {string[]} [options.keywords] - Email keywords/flags (e.g. ['$seen'])
   * @returns {Promise<string>} Imported email ID
   */
  async importEmail(emailBlob, mailboxId, options = {}) {
    const blobId = await this.uploadBlob(emailBlob);

    const responses = await this.request([
      ['Email/import', {
        emails: {
          'import-1': {
            blobId,
            mailboxIds: { [mailboxId]: true },
            keywords: options.keywords
              ? Object.fromEntries(options.keywords.map(k => [k, true]))
              : {},
          },
        },
      }, 'import'],
    ]);

    const importResponse = responses.find(r => r[2] === 'import');
    const imported = importResponse?.[1]?.created?.['import-1'];

    if (!imported) {
      const err = importResponse?.[1]?.notCreated?.['import-1'];
      this.stats.errors++;
      throw new Error(`Email import failed: ${JSON.stringify(err)}`);
    }

    this.stats.emailsImported++;
    return imported.id;
  }

  /**
   * Import multiple emails in sequence, with progress reporting.
   *
   * @param {Array<Buffer>} emailBlobs - Array of RFC 5322 email buffers
   * @param {string} mailboxId - Target mailbox
   * @param {Function} [onProgress] - Callback: (imported, total) => void
   * @returns {Promise<number>} Number of successfully imported emails
   */
  async importBatch(emailBlobs, mailboxId, onProgress) {
    let imported = 0;

    for (let i = 0; i < emailBlobs.length; i++) {
      try {
        await this.importEmail(emailBlobs[i], mailboxId, {
          keywords: ['$seen'], // Mark imported emails as read
        });
        imported++;
      } catch (err) {
        console.error(`    Warning: Failed to import email ${i + 1}: ${err.message}`);
      }

      if (onProgress) onProgress(i + 1, emailBlobs.length);
    }

    return imported;
  }

  /**
   * Get current migration stats.
   */
  getStats() {
    return { ...this.stats };
  }
}

/**
 * Parse a raw mbox file into individual email buffers.
 *
 * The mbox format separates emails with lines starting with "From ".
 * Each email is a complete RFC 5322 message.
 *
 * @param {Buffer} mboxData - Contents of an mbox file
 * @returns {Buffer[]} Array of individual email buffers
 */
export function parseMbox(mboxData) {
  const content = mboxData.toString('utf-8');
  const emails = [];

  // Split on "From " lines that start a new message
  // The pattern is: blank line followed by "From " at start of line
  const parts = content.split(/\n(?=From )/);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Strip the "From " envelope line (first line)
    const lines = trimmed.split('\n');
    const emailContent = lines[0].startsWith('From ')
      ? lines.slice(1).join('\n')
      : trimmed;

    // Un-escape "From " lines within the email body
    // (mbox format escapes them as ">From ")
    const unescaped = emailContent.replace(/^>From /gm, 'From ');

    if (unescaped.trim()) {
      emails.push(Buffer.from(unescaped, 'utf-8'));
    }
  }

  return emails;
}
