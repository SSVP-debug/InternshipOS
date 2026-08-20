import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { notFoundHandler, errorHandler } from "../src/middleware/errorHandler.js";

function mockRes() {
  const res: Partial<Response> & { headersSent: boolean } = { headersSent: false };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
}

describe("notFoundHandler", () => {
  it("returns a stable JSON 404 body including the requested path", () => {
    const req = { path: "/does-not-exist" } as Request;
    const res = mockRes();

    notFoundHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "not_found", path: "/does-not-exist" });
  });
});

describe("errorHandler", () => {
  it("returns a generic 500 with no error detail, message, or stack leaked to the client", () => {
    const req = { log: { error: vi.fn() } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    errorHandler(new Error("a raw Postgres connection string leaked here: postgres://user:pw@host/db"), req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({ error: "internal_server_error" });
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  it("logs the full error server-side via the per-request logger", () => {
    const logError = vi.fn();
    const req = { log: { error: logError } } as unknown as Request;
    const res = mockRes();
    const err = new Error("boom");

    errorHandler(err, req, res, vi.fn() as NextFunction);

    expect(logError).toHaveBeenCalledWith({ err }, "unhandled_request_error");
  });

  it("delegates to next(err) instead of writing a body when headers were already sent", () => {
    const req = { log: { error: vi.fn() } } as unknown as Request;
    const res = mockRes();
    res.headersSent = true;
    const next = vi.fn();

    errorHandler(new Error("late failure"), req, res, next as unknown as NextFunction);

    expect(res.status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it("still returns 500 without a per-request logger attached (defensive fallback)", () => {
    const req = {} as Request;
    const res = mockRes();

    expect(() => errorHandler(new Error("boom"), req, res, vi.fn() as NextFunction)).not.toThrow();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
