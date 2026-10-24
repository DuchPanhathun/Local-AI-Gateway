// A comment line every so often while a stream is quiet, so a proxy in front
// of the gateway doesn't cut a long run off: Vercel, at the public address,
// waits at most 2 minutes for more data. SSE clients skip comment lines. A
// ping only goes between events, never inside one.
const PING = new TextEncoder().encode(": keep-alive\n\n");

export const KEEP_ALIVE_MS = 20_000;

// Whether a chunk ends an event (a blank line), so a ping can follow it.
function endsEvent(chunk: Uint8Array): boolean {
  const n = chunk.length;
  return (n >= 2 && chunk[n - 1] === 10 && chunk[n - 2] === 10) || (n >= 4 && chunk[n - 1] === 10 && chunk[n - 2] === 13 && chunk[n - 3] === 10 && chunk[n - 4] === 13);
}

export function withKeepAlive(stream: ReadableStream<Uint8Array>, everyMs = KEEP_ALIVE_MS): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastSent = Date.now();
  let betweenEvents = true;
  const stop = () => clearInterval(timer);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        if (!betweenEvents || Date.now() - lastSent < everyMs) return;
        try {
          controller.enqueue(PING);
          lastSent = Date.now();
        } catch {
          stop(); // closed: the caller left
        }
      }, Math.max(50, Math.min(everyMs / 4, 1_000))); // so a ping goes within a second of being due
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stop();
          controller.close();
          return;
        }
        controller.enqueue(value);
        lastSent = Date.now();
        betweenEvents = endsEvent(value);
      } catch (err) {
        stop();
        controller.error(err);
      }
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
}
