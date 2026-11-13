import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockImapAppendMessage = vi.fn().mockResolvedValue(undefined);
const mockSmtpSend = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockSmtpConnect = vi.fn().mockResolvedValue(undefined);

vi.mock('../protocol/imap.js', () => {
  return {
    ImapClient: vi.fn(function () {
      return {
        connect: vi.fn().mockResolvedValue(undefined),
        appendMessage: mockImapAppendMessage,
      };
    }),
  };
});

vi.mock('../protocol/smtp.js', () => {
  return {
    SmtpClient: vi.fn(function () {
      return { connect: mockSmtpConnect, send: mockSmtpSend };
    }),
  };
});

import { MailService } from './mail.js';

const account = { id: 'test', name: 'Test', user: 'test@example.com', imap: {} as any, smtp: {} as any };

describe('MailService sendEmail/createDraft with attachments', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mail-mcp-svc-'));
    mockImapAppendMessage.mockClear();
    mockSmtpSend.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('sendEmail passes resolved attachments to SMTP and appends multipart raw to Sent', async () => {
    const file = path.join(tmpDir, 'resume.pdf');
    await fs.writeFile(file, '%PDF-1.4 fake-resume');
    const service = new MailService(account, false);
    await service.connect();
    await service.sendEmail('to@test.com', 'Application', 'See attached', false, undefined, undefined, true, [
      { path: file },
    ]);
    expect(mockSmtpSend).toHaveBeenCalledTimes(1);
    const smtpArgs = mockSmtpSend.mock.calls[0];
    expect(smtpArgs[7]).toHaveLength(1);
    expect(smtpArgs[7][0].filename).toBe('resume.pdf');
    expect(mockImapAppendMessage).toHaveBeenCalledTimes(1);
    const [folder, raw] = mockImapAppendMessage.mock.calls[0];
    expect(folder).toBe('Sent');
    const text = (raw as Buffer).toString('utf-8');
    expect(text).toMatch(/multipart\/mixed/);
    expect(text).toContain('resume.pdf');
    expect(text).toContain(Buffer.from('%PDF-1.4 fake-resume').toString('base64'));
  });

  it('sendEmail without attachments keeps the legacy single-part Sent raw', async () => {
    const service = new MailService(account, false);
    await service.connect();
    await service.sendEmail('to@test.com', 'Hi', 'Hello');
    const [, raw] = mockImapAppendMessage.mock.calls[0];
    expect((raw as string)).toContain('Content-Type: text/plain; charset=utf-8');
    expect(mockSmtpSend).toHaveBeenCalledWith('to@test.com', 'Hi', 'Hello', false, undefined, undefined);
  });

  it('createDraft appends multipart MIME with attachments to Drafts', async () => {
    const service = new MailService(account, false);
    await service.connect();
    const b64 = Buffer.from('draft-attachment').toString('base64');
    await service.createDraft('to@test.com', 'Draft', 'Body', false, undefined, undefined, true, [
      { filename: 'note.txt', content: b64 },
    ]);
    expect(mockImapAppendMessage).toHaveBeenCalledTimes(1);
    const [folder, raw] = mockImapAppendMessage.mock.calls[0];
    expect(folder).toBe('Drafts');
    const text = (raw as Buffer).toString('utf-8');
    expect(text).toMatch(/multipart\/mixed/);
    expect(text).toContain('note.txt');
  });

  it('sendEmail rejects before any network call when the attachment is missing', async () => {
    const service = new MailService(account, false);
    await service.connect();
    await expect(
      service.sendEmail('to@test.com', 'Hi', 'Hello', false, undefined, undefined, true, [
        { path: path.join(tmpDir, 'missing.pdf') },
      ])
    ).rejects.toThrow(/file not found/);
    expect(mockSmtpSend).not.toHaveBeenCalled();
    expect(mockImapAppendMessage).not.toHaveBeenCalled();
  });
});
