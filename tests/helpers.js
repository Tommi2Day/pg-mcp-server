import { EventEmitter } from "node:events";
import { vi } from "vitest";

/** Erstellt ein Mock-Request-Objekt, das einen lesbaren Stream simuliert. */
export function makeReq(method, url, { headers = {}, body = "" } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = {
    authorization: `Bearer ${process.env.AUTH_TOKEN || ""}`,
    ...headers,
  };
  // Body-Chunks asynchron emittieren damit readBody() zuerst listener anhängen kann
  setImmediate(() => {
    if (body) req.emit("data", body);
    req.emit("end");
  });
  return req;
}

/** Erstellt ein Mock-Response-Objekt. */
export function makeRes() {
  return {
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

/** Parst den JSON-Body aus res.end.mock.calls[0][0]. */
export function resBody(res) {
  return JSON.parse(res.end.mock.calls[0][0]);
}
