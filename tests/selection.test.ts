import assert from "node:assert/strict";
import { test } from "node:test";
import * as shared from "../shared.ts";

test("backend selection prefers complete Herdr context over inherited Rex context", () => {
 const rex = { REX_SESSION: "session:test", REX_BLOCK: "block:test" };
 assert.equal(shared.detectBackend(rex), "rex");
 assert.equal(shared.detectBackend({ ...rex, HERDR_ENV: "1", HERDR_SOCKET_PATH: "/test.sock", HERDR_WORKSPACE_ID: "w1", HERDR_PANE_ID: "w1:p1" }), "herdr");
 assert.equal(shared.detectBackend({ ...rex, HERDR_ENV: "1" }), "rex");
 assert.equal(shared.detectBackend({}), undefined);
 assert.equal(shared.detectBackend({ REX_SESSION: "session:test" }), undefined);
});
