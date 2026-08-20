import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { signupRateLimiter, generalRateLimiter } from "../src/middleware/rateLimit.js";

describe("signupRateLimiter", () => {
  it("allows requests up to the configured max, then rejects with 429", async () => {
    const app = express();
    app.use(signupRateLimiter({ SIGNUP_RATE_LIMIT_MAX: 2, RATE_LIMIT_WINDOW_MINUTES: 15 }));
    app.get("/signup", (_req, res) => res.status(200).json({ ok: true }));

    const first = await request(app).get("/signup");
    const second = await request(app).get("/signup");
    const third = await request(app).get("/signup");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body).toEqual({ error: "rate_limited", detail: "too many signup attempts, try again later" });
  });
});

describe("generalRateLimiter", () => {
  it("mounts cleanly and passes through requests under the limit, with rate-limit headers set", async () => {
    const app = express();
    app.use(generalRateLimiter({ RATE_LIMIT_WINDOW_MINUTES: 15 }));
    app.get("/ping", (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get("/ping");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeTruthy();
  });
});
