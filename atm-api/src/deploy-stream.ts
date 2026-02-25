/**
 * Deploy Stream — SSE (Server-Sent Events) manager for real-time deploy log streaming
 *
 * Manages connected SSE clients and broadcasts deploy output lines and
 * completion events to all listeners in real time.
 *
 * @module atm-api/src/deploy-stream
 */

const encoder = new TextEncoder();

/**
 * Manages connected SSE clients for deploy log streaming.
 *
 * Clients connect via GET /deploy/stream and receive:
 * - `{"type":"log","line":"..."}` for each output line
 * - `{"type":"complete","success":true|false}` when deploy finishes
 */
export class StreamManager {
  private streams: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set();

  /**
   * Creates an SSE Response for a new client connection.
   *
   * Uses a TransformStream to create a readable/writable pair.
   * The readable side becomes the Response body; the writable side
   * is stored for broadcasting.
   *
   * @returns Response with SSE headers and streaming body
   */
  createStream(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();

    this.streams.add(writer);

    // Disconnection is detected when writer.write() fails in broadcast().
    // No need to pipe the readable — it's consumed by the Response.

    return new Response(readable, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  }

  /**
   * Removes a disconnected client from the stream set.
   *
   * @param writer - The writer to remove
   */
  removeStream(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.streams.delete(writer);
    try {
      writer.close().catch(() => {});
    } catch {
      // Already closed
    }
  }

  /**
   * Broadcasts a log line to all connected SSE clients.
   *
   * Format: `data: {"type":"log","line":"..."}\n\n`
   *
   * @param line - The log line to broadcast
   */
  broadcastLine(line: string): void {
    const payload = JSON.stringify({ type: 'log', line });
    const message = encoder.encode(`data: ${payload}\n\n`);
    this.broadcast(message);
  }

  /**
   * Broadcasts a deploy completion event to all connected SSE clients.
   *
   * Format: `data: {"type":"complete","success":true|false,"error":"..."}\n\n`
   *
   * @param success - Whether the deploy succeeded
   * @param error - Optional error message on failure
   */
  broadcastComplete(success: boolean, error?: string): void {
    const payload: Record<string, unknown> = { type: 'complete', success };
    if (error !== undefined) {
      payload.error = error;
    }
    const message = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
    this.broadcast(message);
  }

  /**
   * Number of currently connected SSE clients.
   */
  get clientCount(): number {
    return this.streams.size;
  }

  /**
   * Sends a message to all connected writers.
   * Removes any writer that fails (disconnected client).
   */
  private broadcast(message: Uint8Array): void {
    for (const writer of this.streams) {
      writer.write(message).catch(() => {
        // Client disconnected — remove on next tick
        this.removeStream(writer);
      });
    }
  }
}

/**
 * Global singleton StreamManager instance for deploy log streaming.
 */
export const deployStream = new StreamManager();
