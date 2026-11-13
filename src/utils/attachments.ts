import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { ValidationError } from '../errors.js';

const require = createRequire(import.meta.url);
// Deep require: nodemailer v8 no longer re-exports MailComposer from its
// entrypoint, and @types/nodemailer no longer ships a resolvable entry for
// these subpaths — but the file itself is stable public API used by the
// ecosystem for exactly this (rendering raw MIME).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const MailComposer = require('nodemailer/lib/mail-composer');

/**
 * A single file to attach to an outgoing email or draft.
 *
 * Provide exactly one source:
 * - `path`: a file on the MCP server host (relative paths resolve against the
 *   server's working directory, e.g. `/workspace/resume.pdf` in the sandbox).
 *   The filename defaults to the file's basename; override with `filename`.
 * - `content`: base64-encoded file bytes (requires `filename`).
 */
export interface AttachmentInput {
  path?: string;
  filename?: string;
  content?: string;
  contentType?: string;
}

/** Per-attachment size cap. Single small files (e.g. a <1MB resume) fit easily. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * A nodemailer-compatible attachment materialized from an AttachmentInput.
 * Structural subset of nodemailer's Attachment — { filename, content, contentType }.
 */
export interface ResolvedAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

function fail(index: number, reason: string): never {
  throw new ValidationError(`attachments[${index}]: ${reason}`);
}

function assertBase64(index: number, value: string): void {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    fail(index, '"content" is not valid base64');
  }
}

/**
 * Validate tool-supplied attachment inputs and materialize them as nodemailer
 * attachment objects. Throws ValidationError on any problem (missing file,
 * ambiguous source, oversize payload).
 */
export async function resolveAttachments(
  inputs: AttachmentInput[] | undefined
): Promise<ResolvedAttachment[]> {
  if (!inputs || inputs.length === 0) return [];
  const resolved: ResolvedAttachment[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i];
    if (!item || typeof item !== 'object') fail(i, 'must be an object');
    const { path: filePath, filename, content, contentType } = item;
    if (filePath && content) fail(i, 'provide either "path" or "content", not both');
    if (!filePath && !content) fail(i, 'provide "path" or "content"');

    if (filePath) {
      const absolute = path.resolve(process.cwd(), filePath);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(absolute);
      } catch {
        fail(i, `file not found: ${filePath}`);
      }
      if (!stat!.isFile()) fail(i, `not a file: ${filePath}`);
      if (stat!.size > MAX_ATTACHMENT_BYTES) {
        fail(i, `${filePath} is ${(stat!.size / 1024 / 1024).toFixed(1)}MB, limit is 10MB`);
      }
      const data = await fs.readFile(absolute);
      resolved.push({
        filename: filename ?? path.basename(absolute),
        content: data,
        ...(contentType ? { contentType } : {}),
      });
    } else {
      if (!filename) fail(i, '"filename" is required when using "content"');
      assertBase64(i, content!);
      const data = Buffer.from(content!.replace(/\s+/g, ''), 'base64');
      if (data.length > MAX_ATTACHMENT_BYTES) {
        fail(i, `${filename} decodes to ${(data.length / 1024 / 1024).toFixed(1)}MB, limit is 10MB`);
      }
      resolved.push({
        filename: filename!,
        content: data,
        ...(contentType ? { contentType } : {}),
      });
    }
  }
  return resolved;
}

export interface RawMessageOptions {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  extraHeaders?: Record<string, string>;
  attachments?: ResolvedAttachment[];
}

/**
 * Render a complete RFC 5322 message (used for the Sent/Drafts IMAP append
 * so the stored copy includes attachments, Date, and Message-ID instead of
 * the hand-built single-part approximation).
 */
export async function buildRawMessage(options: RawMessageOptions): Promise<Buffer> {
  const composer = new MailComposer({
    from: options.from,
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject: options.subject,
    text: options.text,
    html: options.html,
    headers: options.extraHeaders,
    attachments: options.attachments,
  });
  return composer.compile().build();
}
