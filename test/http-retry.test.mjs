import test from "node:test";
import assert from "node:assert/strict";
import { postJson } from "../src/http.mjs";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}

test("nested backend errors preserve code, message, HTTP status, and retryability", async () => {
  let calls = 0;
  await assert.rejects(() => postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => {
      calls += 1;
      return response(422, {
        error: { code: "MODEL_NOT_SUPPORTED", message: "The model is not active." }
      });
    },
    sleep: async () => { throw new Error("must not sleep for a permanent rejection"); }
  }), (error) => {
    assert.equal(error.code, "MODEL_NOT_SUPPORTED");
    assert.equal(error.message, "The model is not active.");
    assert.equal(error.status, 422);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(calls, 1);
});

test("HTTP retry is bounded and limited to 429 and 5xx responses", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const sleeps = [];
    const result = await postJson("https://artificial-games.example/test", {}, {
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) {
          return response(status, { error: { code: "TRY_AGAIN", message: "Later" } });
        }
        return response(200, { ok: true });
      },
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      random: () => 0
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [200, 400]);
  }

  let permanentCalls = 0;
  await assert.rejects(() => postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => {
      permanentCalls += 1;
      return response(400, { error: { code: "INVALID_PAYLOAD", message: "No" } });
    },
    sleep: async () => { throw new Error("must not sleep"); }
  }), (error) => error.code === "INVALID_PAYLOAD" && !error.retryable);
  assert.equal(permanentCalls, 1);
});

test("a malformed HTTP 429 response remains retryable", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return new Response("rate limited", { status: 429 });
      return new Response('{"ok":true}', { status: 200 });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [200, 400]);
});

test("HTTP 429 honors a bounded Retry-After delay", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('{"error":{"code":"CONNECTOR_RATE_LIMITED","message":"Later"}}', {
          status: 429,
          headers: { "Retry-After": "2" }
        });
      }
      return new Response('{"ok":true}', { status: 200 });
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(sleeps, [2_000]);
});

test("network failures retry three times and preserve retryable status", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(() => postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0
  }), (error) => error.code === "NETWORK_UNAVAILABLE" && error.retryable);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [200, 400]);
});

test("the timeout covers response-body streaming, not only response headers", async () => {
  const started = Date.now();
  await assert.rejects(() => postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: async () => {}
        })
      }
    }),
    timeoutMs: 10,
    maxAttempts: 1
  }), (error) => error.code === "NETWORK_TIMEOUT" && error.retryable);
  assert.ok(Date.now() - started < 500, "body timeout did not terminate promptly");
});

test("mid-body transport failures are normalized and retried", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(() => postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: async () => { throw new TypeError("socket closed mid-body"); },
            cancel: async () => {}
          })
        }
      };
    },
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0
  }), (error) => error.code === "NETWORK_UNAVAILABLE" && error.retryable);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [200, 400]);
});

test("streamed responses are cancelled once the one-megabyte cap is exceeded", async () => {
  await assert.rejects(() => postJson("https://artificial-games.example/test", {}, {
    fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 })
  }), (error) => error.code === "RESPONSE_TOO_LARGE" && !error.retryable);
});
