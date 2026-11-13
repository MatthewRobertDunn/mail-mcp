import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildRawMessage,
  resolveAttachments,
  MAX_ATTACHMENT_BYTES,
} from './attachments.js';

describe('resolveAttachments', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-attach-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns [] for undefined/empty input', async () => {
    await expect(resolveAttachments(undefined)).resolves.toEqual([]);
    await expect(resolveAttachments([])).resolves.toEqual([]);
  });

  it('resolves a path item to filename + Buffer content', async () => {
    const file = path.join(tmpDir, 'resume.pdf');
    await fs.writeFile(file, '%PDF-1.4 fake');
    const [att] = await resolveAttachments([{ path: file }]);
    expect(att.filename).toBe('resume.pdf');
    expect(Buffer.isBuffer(att.content)).toBe(true);
    expect((att.content as Buffer).toString()).toBe('%PDF-1.4 fake');
  });

  it('honors explicit filename and contentType for path items', async () => {
    const file = path.join(tmpDir, 'a.bin');
    await fs.writeFile(file, 'data');
    const [att] = await resolveAttachments([
      { path: file, filename: 'b.pdf', contentType: 'application/pdf' },
    ]);
    expect(att.filename).toBe('b.pdf');
    expect(att.contentType).toBe('application/pdf');
  });

  it('resolves relative paths against the working directory', async () => {
    const prev = process.cwd();
    process.chdir(tmpDir);
    try {
      await fs.writeFile('rel.txt', 'hello');
      const [att] = await resolveAttachments([{ path: 'rel.txt' }]);
      expect(att.filename).toBe('rel.txt');
    } finally {
      process.chdir(prev);
    }
  });

  it('resolves a base64 content item', async () => {
    const [att] = await resolveAttachments([
      { filename: 'note.txt', content: Buffer.from('hello').toString('base64') },
    ]);
    expect(att.filename).toBe('note.txt');
    expect((att.content as Buffer).toString()).toBe('hello');
  });

  it('rejects missing files', async () => {
    await expect(
      resolveAttachments([{ path: path.join(tmpDir, 'nope.pdf') }])
    ).rejects.toThrow(/file not found/);
  });

  it('rejects directories', async () => {
    await expect(resolveAttachments([{ path: tmpDir }])).rejects.toThrow(/not a file/);
  });

  it('rejects items with both path and content', async () => {
    await expect(
      resolveAttachments([{ path: 'a.pdf', content: 'aGVsbG8=' } as any])
    ).rejects.toThrow(/either "path" or "content"/);
  });

  it('rejects items with neither path nor content', async () => {
    await expect(resolveAttachments([{}])).rejects.toThrow(/provide "path" or "content"/);
  });

  it('rejects content items without filename', async () => {
    await expect(resolveAttachments([{ content: 'aGVsbG8=' }])).rejects.toThrow(/"filename" is required/);
  });

  it('rejects invalid base64', async () => {
    await expect(resolveAttachments([{ filename: 'x.bin', content: '!!!not-base64!!!' }])).rejects.toThrow(
      /not valid base64/
    );
  });

  it('rejects oversize files', async () => {
    const file = path.join(tmpDir, 'big.bin');
    await fs.writeFile(file, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
    await expect(resolveAttachments([{ path: file }])).rejects.toThrow(/limit is 10MB/);
  });
});

describe('buildRawMessage', () => {
  it('renders a multipart message containing the attachment', async () => {
    const raw = await buildRawMessage({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Resume',
      text: 'Please find my resume attached.',
      attachments: [{ filename: 'resume.pdf', content: Buffer.from('%PDF-1.4 fake') }],
    });
    const text = raw.toString('utf-8');
    expect(text).toMatch(/multipart\/mixed/);
    expect(text).toContain('resume.pdf');
    expect(text).toContain(Buffer.from('%PDF-1.4 fake').toString('base64'));
    expect(text).toContain('Please find my resume attached.');
  });

  it('renders a plain message without attachments', async () => {
    const raw = await buildRawMessage({
      from: 'me@example.com',
      to: 'you@example.com',
      subject: 'Hi',
      text: 'Hello',
    });
    const text = raw.toString('utf-8');
    expect(text).not.toMatch(/multipart\/mixed/);
    expect(text).toContain('Hello');
  });
});
