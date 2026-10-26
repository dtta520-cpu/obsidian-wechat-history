import https from 'node:https';

// Desktop Obsidian runs in a renderer. Node HTTPS avoids browser CORS without
// weakening TLS or relying on Electron's private remote/session interfaces.
export function nativeFetch(input, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    if (url.protocol !== 'https:') { reject(new Error('HTTPS required')); return; }
    const request = https.request(url, { method: 'GET', headers: options.headers, signal: options.signal }, response => {
      response.cancel = async () => response.destroy();
      resolve({ status: response.statusCode,
        headers: {
          get: name => { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value ?? null; },
          getSetCookie: () => response.headers['set-cookie'] || [],
        }, body: response,
      });
    });
    request.on('error', reject); request.end();
  });
}
