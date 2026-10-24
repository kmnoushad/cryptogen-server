// Bound both headers and body parsing even if a transport ignores abort.
// Timeout means unknown outcome for writes. Never retry a mutation here.
export async function requestDeadline(load, timeoutMs, message = 'Request deadline exceeded') {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error(message)); }, timeoutMs);
  });
  try { return await Promise.race([load(controller.signal), expired]); }
  finally { clearTimeout(timer); }
}
