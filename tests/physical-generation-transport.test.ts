import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { BrokerMcpClient } from "../packages/node-adapters/src/fusion-transport/mcp";
import { createAdmissionRequest } from "../packages/node-adapters/src/execution/admission-http";

test("prepared broker RPC authorizes at dispatch, not preparation or request scope", async (t) => {
  let received = 0;
  const server = createServer((request, response) => {
    received++;
    assert.equal(
      request.headers["x-fmcad-physical-grant"],
      "current-private-grant",
    );
    assert.equal(request.headers["x-fmcad-physical-turn"], undefined);
    assert.equal(request.headers["x-fmcad-physical-target"], undefined);
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  let authorized = false;
  let checks = 0;
  const client = new BrokerMcpClient(
    { url: endpoint },
    {
      version: "test",
      bridgeSource: () => "",
      requestTimeout: () => 1000,
      authorizePhysicalRequest(url) {
        checks++;
        assert.equal(url, endpoint);
        if (!authorized) throw new Error("Physical generation revoked");
        return { "X-Fmcad-Physical-Grant": "current-private-grant" };
      },
    },
  );
  const refused = await client.preparePost({ method: "tools/call", id: 1 });
  assert.equal(checks, 0);
  assert.throws(() => refused.send(), /generation revoked/);
  assert.equal(received, 0);
  authorized = true;
  const allowed = await client.preparePost({ method: "tools/call", id: 2 });
  await client.withRequest(
    {
      headers: {
        "x-fmcad-physical-grant": "request-cannot-replace-grant",
        "X-FMCAD-Physical-Turn": "request-cannot-provide-turn",
        "x-fmcad-PHYSICAL-target": "request-cannot-provide-target",
      },
    },
    () => allowed.send(),
  );
  assert.equal(received, 1);
  assert.equal(checks, 2);
});

for (const transport of ["node", "windows-curl"]) {
  test(`broker ${transport} rejects a prepared RPC after grant revocation`, async () => {
    let spawned = 0;
    let live = true;
    const client = new BrokerMcpClient(
      {
        url: "http://127.0.0.1:8765/mcp",
        transport,
      },
      {
        version: "test",
        bridgeSource: () => "",
        requestTimeout: () => 1000,
        authorizePhysicalRequest() {
          assert.equal(live, false);
          throw new Error("Physical generation revoked");
        },
        spawn() {
          spawned++;
          throw new Error("Must not spawn");
        },
      },
    );
    const prepared = await client.preparePost({ method: "tools/call", id: 1 });
    live = false;
    assert.throws(() => prepared.send(), /generation revoked/);
    assert.equal(spawned, 0);
  });
  test(`admission ${transport} rejects revoked generation before fetch or spawn`, async () => {
    let network = 0;
    const request = createAdmissionRequest(
      { transport },
      {
        authorizePhysicalRequest() {
          throw new Error("Physical generation revoked");
        },
        fetch: async () => {
          network++;
          throw new Error("Must not fetch");
        },
        spawn: () => {
          network++;
          throw new Error("Must not spawn");
        },
      },
    );
    await assert.rejects(
      request({
        endpoint: "http://127.0.0.1:8765/admission/v1",
        token: "private-admission-token",
        body: new Uint8Array(),
        timeoutMs: 1000,
      }),
      /generation revoked/,
    );
    assert.equal(network, 0);
  });
}
