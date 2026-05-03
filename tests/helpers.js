import { EventEmitter } from "node:events";
import { vi } from "vitest";

/** Creates a mock request object that simulates a readable stream. */
export function makeReq(method, url, { headers = {}, body = "" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {
    authorization: `Bearer ${process.env.AUTH_TOKEN || ""}`,
    ...headers,
  };
  // Emit body chunks asynchronously so readBody() can attach listeners first
  setImmediate(() => {
    if (body) req.emit("data", body);
    req.emit("end");
  });
  return req;
}

/** Creates a mock response object. */
export function makeRes() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

/** Parses the JSON body from res.end.mock.calls[0][0]. */
export function resBody(res) {
  return JSON.parse(res.end.mock.calls[0][0]);
}
