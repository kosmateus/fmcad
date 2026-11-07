import assert from "node:assert/strict";
import test from "node:test";
import { classifyNetworkConsoleErrors } from "./browser-network-evidence.ts";

const origin = "http://127.0.0.1:39001";
const url = origin + "/api/v1/console/snapshot";
const error = "net::ERR_CONNECTION_REFUSED";
const text = "Failed to load resource: " + error;

test("console evidence matches the exact failed request even after the outage ends", () => {
  const failures = [{ url, error }];
  const messages = [{ url, text }];
  assert.deepEqual(classifyNetworkConsoleErrors(messages, failures, origin), {
    expected: [text],
    unexpected: [],
  });
  assert.deepEqual(classifyNetworkConsoleErrors(messages, [], origin), {
    expected: [],
    unexpected: [text],
  });
});

test("one failed request cannot excuse an additional error at the same URL", () => {
  assert.deepEqual(
    classifyNetworkConsoleErrors(
      [
        { url, text },
        { url, text },
      ],
      [{ url, error }],
      origin,
    ),
    {
      expected: [text],
      unexpected: [text],
    },
  );
});

test("other origins, resources, error kinds and missing locations remain errors", () => {
  for (const candidate of [
    { url: "http://127.0.0.1:39002/api/v1/console/snapshot", error },
    { url: origin + "/missing.js", error },
    { url, error: "net::ERR_FAILED" },
  ]) {
    const message = {
      url: candidate.url,
      text: "Failed to load resource: " + candidate.error,
    };
    assert.deepEqual(
      classifyNetworkConsoleErrors([message], [candidate], origin),
      {
        expected: [],
        unexpected: [message.text],
      },
    );
  }
  for (const message of [
    { url: "", text },
    { url, text: "Uncaught TypeError" },
  ]) {
    assert.deepEqual(
      classifyNetworkConsoleErrors([message], [{ url, error }], origin),
      {
        expected: [],
        unexpected: [message.text],
      },
    );
  }
});

test("request URLs and network reasons must both match", () => {
  for (const failure of [
    { url: origin + "/api/v1/console/events", error },
    { url, error: "net::ERR_CONNECTION_RESET" },
  ]) {
    assert.deepEqual(
      classifyNetworkConsoleErrors([{ url, text }], [failure], origin),
      {
        expected: [],
        unexpected: [text],
      },
    );
  }
});
