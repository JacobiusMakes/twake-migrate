/**
 * Matrix exporter — Create rooms and send messages via the Matrix Client-Server API
 *
 * Used by importers to push channels/messages into Twake Chat.
 * Follows the same API patterns as twake-cli's chat module but
 * oriented for bulk migration rather than interactive use.
 *
 * Matrix CS API reference:
 *   https://spec.matrix.org/v1.6/client-server-api/
 */

const USER_AGENT = 'twake-migrate/1.0.0';

/** Rate limit: pause between batches to avoid overwhelming the homeserver */
const BATCH_DELAY_MS = 50;

/**
 * MatrixClient — lightweight Matrix API client for migration operations.
 *
 * Supports room creation, message sending, file uploads, and user management.
 * Uses the native fetch API (Node 18+) with no external dependencies.
 */
export class MatrixClient {
  /**
   * @param {Object} config
   * @param {string} config.homeserver  - Matrix homeserver URL (e.g. https://matrix.twake.app)
   * @param {string} config.accessToken - Admin access token
   * @param {string} config.domain      - Matrix domain for user IDs (e.g. twake.app)
   */
  constructor({ homeserver, accessToken, domain }) {
    this.homeserver = homeserver.replace(/\/$/, '');
    this.accessToken = accessToken;
    this.domain = domain;

    // Cache: track rooms we've already created to avoid duplicates
    this._roomCache = new Map();

    // Stats
    this.stats = {
      roomsCreated: 0,
      messagesSent: 0,
      filesUploaded: 0,
      errors: 0,
    };
  }

  /**
   * Make an authenticated request to the Matrix Client-Server API.
   *
   * @param {string} endpoint - API path (e.g. /createRoom)
   * @param {Object} [options] - fetch options
   * @returns {Promise<Object>} Parsed JSON response
   */
  async fetch(endpoint, options = {}) {
    const url = `${this.homeserver}/_matrix/client/v3${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || err.errcode || res.statusText;
      throw new Error(`Matrix API ${res.status}: ${msg} (${endpoint})`);
    }

    return res.json();
  }

  /**
   * Create a Matrix room, mirroring a source channel.
   *
   * @param {Object} channel
   * @param {string} channel.name    - Channel/room name
   * @param {string} [channel.topic] - Room topic/purpose
   * @param {string} [channel.alias] - Room alias (without # or :domain)
   * @param {boolean} [channel.isPrivate] - Whether the room is invite-only
   * @returns {Promise<string>} The created room's ID
   */
  async createRoom({ name, topic, alias, isPrivate = false }) {
    // Check cache first
    const cacheKey = alias || name;
    if (this._roomCache.has(cacheKey)) {
      return this._roomCache.get(cacheKey);
    }

    const body = {
      name,
      visibility: isPrivate ? 'private' : 'public',
      preset: isPrivate ? 'private_chat' : 'public_chat',
      creation_content: {
        'm.federate': false, // Keep migration rooms local
      },
    };

    if (topic) body.topic = topic;
    if (alias) body.room_alias_name = alias;

    // Tag rooms as migrated for easy identification
    body.initial_state = [
      {
        type: 'm.room.tag',
        content: { tags: { 'u.migrated': { order: 1 } } },
      },
    ];

    try {
      const data = await this.fetch('/createRoom', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      this._roomCache.set(cacheKey, data.room_id);
      this.stats.roomsCreated++;
      return data.room_id;
    } catch (err) {
      // If room alias already exists, try to resolve it
      if (err.message.includes('M_ROOM_IN_USE') && alias) {
        try {
          const resolved = await this.fetch(
            `/directory/room/${encodeURIComponent(`#${alias}:${this.domain}`)}`
          );
          this._roomCache.set(cacheKey, resolved.room_id);
          return resolved.room_id;
        } catch {
          // Fall through to error
        }
      }
      this.stats.errors++;
      throw err;
    }
  }

  /**
   * Send a text message to a room.
   *
   * @param {string} roomId    - Target room ID
   * @param {string} body      - Message text
   * @param {Object} [options]
   * @param {number} [options.timestamp] - Original message timestamp (epoch ms)
   * @param {string} [options.sender]    - Original sender display name
   * @param {string} [options.format]    - Message format (e.g. 'org.matrix.custom.html')
   * @param {string} [options.formattedBody] - HTML-formatted message body
   * @returns {Promise<string>} Event ID
   */
  async sendMessage(roomId, body, options = {}) {
    const txnId = `migrate-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    const content = {
      msgtype: 'm.text',
      body,
    };

    // Preserve original sender as a prefix if we can't impersonate
    if (options.sender) {
      content.body = `[${options.sender}] ${body}`;
      content['dev.twake.migrate.original_sender'] = options.sender;
    }

    // Include original timestamp as metadata
    if (options.timestamp) {
      content['dev.twake.migrate.original_ts'] = options.timestamp;
    }

    // Support HTML-formatted messages (e.g. Slack's rich text)
    if (options.format && options.formattedBody) {
      content.format = options.format;
      content.formatted_body = options.formattedBody;
    }

    const endpoint = `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;

    try {
      const data = await this.fetch(endpoint, {
        method: 'PUT',
        body: JSON.stringify(content),
      });
      this.stats.messagesSent++;
      return data.event_id;
    } catch (err) {
      this.stats.errors++;
      throw err;
    }
  }

  /**
   * Send multiple messages in order, with rate limiting between batches.
   *
   * @param {string} roomId
   * @param {Array<{text: string, sender?: string, timestamp?: number}>} messages
   * @param {number} [batchSize=100]
   * @param {Function} [onProgress] - Callback: (sent, total) => void
   */
  async sendMessageBatch(roomId, messages, batchSize = 100, onProgress) {
    let sent = 0;

    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);

      for (const msg of batch) {
        try {
          await this.sendMessage(roomId, msg.text, {
            sender: msg.sender,
            timestamp: msg.timestamp,
          });
          sent++;
        } catch (err) {
          // Log but don't abort — skip failed messages
          console.error(`    Warning: Failed to send message: ${err.message}`);
        }
      }

      if (onProgress) onProgress(sent, messages.length);

      // Rate limiting pause between batches
      if (i + batchSize < messages.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    return sent;
  }

  /**
   * Upload a file to the Matrix content repository.
   *
   * @param {Buffer} fileData    - File contents
   * @param {string} fileName    - File name
   * @param {string} contentType - MIME type
   * @returns {Promise<string>}  mxc:// content URI
   */
  async uploadFile(fileData, fileName, contentType) {
    const url = `${this.homeserver}/_matrix/media/v3/upload?filename=${encodeURIComponent(fileName)}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': contentType,
        'User-Agent': USER_AGENT,
      },
      body: fileData,
    });

    if (!res.ok) {
      throw new Error(`File upload failed: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    this.stats.filesUploaded++;
    return data.content_uri;
  }

  /**
   * Send a file attachment message to a room.
   *
   * @param {string} roomId
   * @param {Buffer} fileData
   * @param {string} fileName
   * @param {string} contentType
   * @param {Object} [options]
   * @param {string} [options.sender] - Original sender name
   * @returns {Promise<string>} Event ID
   */
  async sendFileMessage(roomId, fileData, fileName, contentType, options = {}) {
    const contentUri = await this.uploadFile(fileData, fileName, contentType);

    const txnId = `migrate-file-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Determine message type from MIME
    let msgtype = 'm.file';
    if (contentType.startsWith('image/')) msgtype = 'm.image';
    else if (contentType.startsWith('audio/')) msgtype = 'm.audio';
    else if (contentType.startsWith('video/')) msgtype = 'm.video';

    const content = {
      msgtype,
      body: options.sender ? `[${options.sender}] ${fileName}` : fileName,
      filename: fileName,
      url: contentUri,
      info: {
        mimetype: contentType,
        size: fileData.length,
      },
    };

    if (options.sender) {
      content['dev.twake.migrate.original_sender'] = options.sender;
    }

    const endpoint = `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;

    const data = await this.fetch(endpoint, {
      method: 'PUT',
      body: JSON.stringify(content),
    });

    this.stats.messagesSent++;
    return data.event_id;
  }

  /**
   * Invite a user to a room.
   *
   * @param {string} roomId
   * @param {string} userId - Full Matrix user ID (@user:domain)
   */
  async inviteUser(roomId, userId) {
    await this.fetch(`/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    });
  }

  /**
   * Map an external username to a Matrix user ID.
   *
   * @param {string} username - Source platform username
   * @returns {string} Matrix user ID (e.g. @jane:twake.app)
   */
  toMatrixUserId(username) {
    // Matrix user localpart: lowercase, replace spaces/dots with underscores
    const localpart = username
      .toLowerCase()
      .replace(/[\s.]+/g, '_')
      .replace(/[^a-z0-9_\-]/g, '');
    return `@${localpart}:${this.domain}`;
  }

  /**
   * Get current migration stats.
   */
  getStats() {
    return { ...this.stats };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
