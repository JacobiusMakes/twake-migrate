/**
 * Drive exporter — Upload files to Twake Drive via the Cozy API
 *
 * Used by importers to push file attachments and Google Drive files
 * into Twake Drive (backed by Cozy Cloud).
 *
 * Cozy Files API reference:
 *   https://docs.cozy.io/en/cozy-stack/files/
 */

const USER_AGENT = 'twake-migrate/1.0.0';

/**
 * DriveClient — lightweight Cozy API client for file migration.
 *
 * Handles folder creation, file uploads, and directory listing.
 * Organizes migrated files under a dedicated /Migrated directory.
 */
export class DriveClient {
  /**
   * @param {Object} config
   * @param {string} config.instanceUrl - Cozy instance URL (e.g. https://drive.twake.app)
   * @param {string} config.token       - Cozy bearer token
   */
  constructor({ instanceUrl, token }) {
    this.instanceUrl = instanceUrl.replace(/\/$/, '');
    this.token = token;

    // Cache: folder name → folder ID
    this._folderCache = new Map();

    this.stats = {
      foldersCreated: 0,
      filesUploaded: 0,
      bytesUploaded: 0,
      errors: 0,
    };
  }

  /**
   * Make an authenticated request to the Cozy Files API.
   *
   * @param {string} endpoint - API path
   * @param {Object} [options] - fetch options
   * @returns {Promise<Object>} Parsed JSON response
   */
  async fetch(endpoint, options = {}) {
    const url = `${this.instanceUrl}${endpoint}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json',
        'User-Agent': USER_AGENT,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Cozy API ${res.status}: ${err || res.statusText} (${endpoint})`);
    }

    return res.json();
  }

  /**
   * Ensure a folder exists, creating it if needed.
   * Returns the folder's Cozy file ID.
   *
   * @param {string} folderName - Folder name to create
   * @param {string} [parentId='io.cozy.files.root-dir'] - Parent folder ID
   * @returns {Promise<string>} Folder ID
   */
  async ensureFolder(folderName, parentId = 'io.cozy.files.root-dir') {
    const cacheKey = `${parentId}/${folderName}`;
    if (this._folderCache.has(cacheKey)) {
      return this._folderCache.get(cacheKey);
    }

    // Try to find existing folder first
    try {
      const listing = await this.fetch(`/files/${parentId}`);
      const contents = listing.included || [];
      const existing = contents.find(
        item => item.attributes?.name === folderName && item.attributes?.type === 'directory'
      );
      if (existing) {
        this._folderCache.set(cacheKey, existing.id);
        return existing.id;
      }
    } catch {
      // Parent might not be listable; proceed to create
    }

    // Create the folder
    const url = `${this.instanceUrl}/files/${parentId}?Type=directory&Name=${encodeURIComponent(folderName)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/vnd.api+json',
        'User-Agent': USER_AGENT,
      },
    });

    if (!res.ok) {
      // 409 Conflict = folder already exists — try to find it
      if (res.status === 409) {
        const listing = await this.fetch(`/files/${parentId}`);
        const contents = listing.included || [];
        const existing = contents.find(
          item => item.attributes?.name === folderName && item.attributes?.type === 'directory'
        );
        if (existing) {
          this._folderCache.set(cacheKey, existing.id);
          return existing.id;
        }
      }
      throw new Error(`Failed to create folder "${folderName}": ${res.status}`);
    }

    const data = await res.json();
    const folderId = data.data?.id;
    this._folderCache.set(cacheKey, folderId);
    this.stats.foldersCreated++;
    return folderId;
  }

  /**
   * Create a nested folder path, ensuring each level exists.
   *
   * @param {string} path - Folder path (e.g. "Migrated/Slack/general")
   * @returns {Promise<string>} The deepest folder's ID
   */
  async ensureFolderPath(path) {
    const parts = path.split('/').filter(Boolean);
    let parentId = 'io.cozy.files.root-dir';

    for (const part of parts) {
      parentId = await this.ensureFolder(part, parentId);
    }

    return parentId;
  }

  /**
   * Upload a file to Twake Drive.
   *
   * @param {Buffer} fileData  - File contents
   * @param {string} fileName  - File name
   * @param {string} folderId  - Destination folder ID
   * @param {Object} [options]
   * @param {string} [options.contentType] - MIME type (default: application/octet-stream)
   * @param {Date}   [options.createdAt]   - Original creation date
   * @param {Date}   [options.updatedAt]   - Original modification date
   * @returns {Promise<Object>} Upload result with id and name
   */
  async uploadFile(fileData, fileName, folderId, options = {}) {
    const contentType = options.contentType || detectMimeType(fileName);

    const url = `${this.instanceUrl}/files/${folderId}?Type=file&Name=${encodeURIComponent(fileName)}`;

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': contentType,
      'User-Agent': USER_AGENT,
    };

    // Preserve original timestamps if available
    if (options.createdAt) {
      headers['Date'] = options.createdAt.toUTCString();
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: fileData,
    });

    if (!res.ok) {
      // 409 = file with same name already exists — skip silently
      if (res.status === 409) {
        return { id: null, name: fileName, skipped: true };
      }
      this.stats.errors++;
      throw new Error(`Upload failed for "${fileName}": ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    this.stats.filesUploaded++;
    this.stats.bytesUploaded += fileData.length;

    return {
      id: data.data?.id,
      name: fileName,
      size: fileData.length,
    };
  }

  /**
   * Upload multiple files to a folder, with progress reporting.
   *
   * @param {Array<{data: Buffer, name: string, contentType?: string}>} files
   * @param {string} folderId
   * @param {Function} [onProgress] - Callback: (uploaded, total) => void
   * @returns {Promise<number>} Number of files successfully uploaded
   */
  async uploadBatch(files, folderId, onProgress) {
    let uploaded = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        await this.uploadFile(file.data, file.name, folderId, {
          contentType: file.contentType,
        });
        uploaded++;
      } catch (err) {
        console.error(`    Warning: Failed to upload ${file.name}: ${err.message}`);
      }

      if (onProgress) onProgress(i + 1, files.length);
    }

    return uploaded;
  }

  /**
   * Get current migration stats.
   */
  getStats() {
    return { ...this.stats };
  }
}

/**
 * Detect MIME type from file extension.
 */
function detectMimeType(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const mimeTypes = {
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'odt': 'application/vnd.oasis.opendocument.text',
    'ods': 'application/vnd.oasis.opendocument.spreadsheet',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'json': 'application/json',
    'xml': 'application/xml',
    'html': 'text/html',
    'md': 'text/markdown',

    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'bmp': 'image/bmp',

    // Audio/Video
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mov': 'video/quicktime',

    // Archives
    'zip': 'application/zip',
    'gz': 'application/gzip',
    'tar': 'application/x-tar',
    'rar': 'application/vnd.rar',
  };

  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Format byte size for human-readable output.
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
