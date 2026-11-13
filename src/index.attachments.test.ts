/**
 * Regression tests: attachments must survive the PRODUCTION MCP request path
 * (CallToolRequestSchema handler), not just dispatchTool (which duplicates the
 * send_email/create_draft branches and is what the other suites exercise).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  getAccounts: vi.fn().mockResolvedValue([
    { id: 'acc1', name: 'Test', user: 'test@example.com', host: 'imap.example.com', port: 993, smtpHost: 'smtp.example.com', smtpPort: 587, secure: true }
  ]),
  AUDIT_LOG_PATH: '/tmp/test-audit-attachments.log',
}));

vi.mock('./utils/templates.js', () => ({
  getTemplates: vi.fn().mockResolvedValue([]),
  applyVariables: vi.fn().mockImplementation((t: string) => t),
}));

const mockSendEmail = vi.fn().mockResolvedValue({ messageId: 'test' });
const mockCreateDraft = vi.fn().mockResolvedValue(undefined);

vi.mock('./services/mail.js', () => {
  const MockMailService = vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      sendEmail: mockSendEmail,
      createDraft: mockCreateDraft,
      imap: { onClose: null },
    };
  });
  return { MailService: MockMailService };
});

import { MailMCPServer } from './index.js';

function callToolHandler(server: any, name: string, args: Record<string, unknown>) {
  const handler = server.server._requestHandlers.get('tools/call');
  expect(handler).toBeDefined();
  return handler({ method: 'tools/call', params: { name, arguments: args } }, {});
}

describe('production tools/call handler forwards attachments', () => {
  beforeEach(() => {
    mockSendEmail.mockClear();
    mockCreateDraft.mockClear();
  });

  it('send_email passes attachments to the service', async () => {
    const server = new MailMCPServer(false) as any;
    const attachments = [{ path: '/workspace/resume.pdf' }];
    const result = await callToolHandler(server, 'send_email', {
      accountId: 'acc1',
      to: 'to@example.com',
      subject: 'Hi',
      body: 'See attached',
      attachments,
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][7]).toEqual(attachments);
    expect(JSON.stringify(result)).toContain('successfully sent');
  });

  it('create_draft passes attachments to the service', async () => {
    const server = new MailMCPServer(false) as any;
    const attachments = [{ filename: 'note.txt', content: Buffer.from('hi').toString('base64') }];
    const result = await callToolHandler(server, 'create_draft', {
      accountId: 'acc1',
      to: 'to@example.com',
      subject: 'Draft',
      body: 'See attached',
      attachments,
    });
    expect(mockCreateDraft).toHaveBeenCalledTimes(1);
    expect(mockCreateDraft.mock.calls[0][7]).toEqual(attachments);
    expect(JSON.stringify(result)).toContain('Draft successfully created');
  });

  it('omitted attachments reach the service as undefined (legacy path)', async () => {
    const server = new MailMCPServer(false) as any;
    await callToolHandler(server, 'send_email', {
      accountId: 'acc1',
      to: 'to@example.com',
      subject: 'Hi',
      body: 'No attachments',
    });
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][7]).toBeUndefined();
  });
});
