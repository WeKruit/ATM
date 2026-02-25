import { describe, it, expect } from 'bun:test';

import { StreamManager } from '../deploy-stream';

const decoder = new TextDecoder();

/**
 * Collects messages from a ReadableStream (the SSE response body)
 * with a timeout to avoid hanging on open-ended streams.
 */
async function collectMessages(
  stream: ReadableStream<Uint8Array>,
  count: number,
  timeoutMs: number = 1000,
): Promise<string[]> {
  const reader = stream.getReader();
  const messages: string[] = [];
  const deadline = Date.now() + timeoutMs;

  try {
    while (messages.length < count && Date.now() < deadline) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs),
        ),
      ]);

      if (done) break;
      if (value) {
        const text = decoder.decode(value);
        // SSE messages are delimited by \n\n
        const parts = text.split('\n\n').filter((p) => p.trim().length > 0);
        messages.push(...parts);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return messages;
}

describe('StreamManager', () => {
  it('createStream returns a Response with SSE headers', () => {
    const manager = new StreamManager();
    const response = manager.createStream();

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });

  it('clientCount tracks connected clients', () => {
    const manager = new StreamManager();
    expect(manager.clientCount).toBe(0);

    manager.createStream();
    expect(manager.clientCount).toBe(1);

    manager.createStream();
    expect(manager.clientCount).toBe(2);
  });

  it('broadcastLine sends SSE-formatted log data', async () => {
    const manager = new StreamManager();
    const response = manager.createStream();

    // Broadcast a line
    manager.broadcastLine('Deploying v1.2.3...');

    // Read from the response body
    const messages = await collectMessages(response.body!, 1);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0].replace('data: ', ''));
    expect(parsed.type).toBe('log');
    expect(parsed.line).toBe('Deploying v1.2.3...');
  });

  it('broadcastComplete sends completion event with success=true', async () => {
    const manager = new StreamManager();
    const response = manager.createStream();

    manager.broadcastComplete(true);

    const messages = await collectMessages(response.body!, 1);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0].replace('data: ', ''));
    expect(parsed.type).toBe('complete');
    expect(parsed.success).toBe(true);
    expect(parsed.error).toBeUndefined();
  });

  it('broadcastComplete sends completion event with error', async () => {
    const manager = new StreamManager();
    const response = manager.createStream();

    manager.broadcastComplete(false, 'ECR auth failed');

    const messages = await collectMessages(response.body!, 1);

    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0].replace('data: ', ''));
    expect(parsed.type).toBe('complete');
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('ECR auth failed');
  });

  it('multiple clients receive the same broadcast', async () => {
    const manager = new StreamManager();
    const response1 = manager.createStream();
    const response2 = manager.createStream();

    expect(manager.clientCount).toBe(2);

    manager.broadcastLine('shared message');

    const [messages1, messages2] = await Promise.all([
      collectMessages(response1.body!, 1),
      collectMessages(response2.body!, 1),
    ]);

    expect(messages1.length).toBeGreaterThanOrEqual(1);
    expect(messages2.length).toBeGreaterThanOrEqual(1);

    const parsed1 = JSON.parse(messages1[0].replace('data: ', ''));
    const parsed2 = JSON.parse(messages2[0].replace('data: ', ''));

    expect(parsed1.line).toBe('shared message');
    expect(parsed2.line).toBe('shared message');
  });

  it('broadcastLine sends multiple messages in sequence', async () => {
    const manager = new StreamManager();
    const response = manager.createStream();

    manager.broadcastLine('step 1');
    manager.broadcastLine('step 2');
    manager.broadcastLine('step 3');

    const messages = await collectMessages(response.body!, 3);

    expect(messages.length).toBeGreaterThanOrEqual(3);
    const lines = messages.map((m) => JSON.parse(m.replace('data: ', '')).line);
    expect(lines).toContain('step 1');
    expect(lines).toContain('step 2');
    expect(lines).toContain('step 3');
  });

  it('createStream returns a response with a readable body', () => {
    const manager = new StreamManager();
    const response = manager.createStream();

    expect(response.body).not.toBeNull();
    expect(response.body).toBeInstanceOf(ReadableStream);
  });
});
