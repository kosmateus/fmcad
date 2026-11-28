import test from "node:test";
import assert from "node:assert/strict";
import { parseDocumentInventory } from "./document-inventory";

test("public document JSON retains identities, file IDs, active state and Unicode names", () => {
  const stdout = JSON.stringify({
    success: true,
    results: [
      {
        creationId: "saved-1",
        name: "Zażółć 中文\n🚀",
        id: "cloud-file-1",
        isActive: true,
        isSaved: true,
        isModified: false,
      },
      {
        creationId: "unsaved-1",
        name: "Unsaved",
        isActive: false,
        isSaved: false,
        isModified: true,
      },
    ],
  });

  assert.deepEqual(parseDocumentInventory(stdout), {
    active: "saved-1",
    documents: [
      {
        creationId: "saved-1",
        name: "Zażółć 中文\n🚀",
        saved: true,
        modified: false,
        fileId: "cloud-file-1",
      },
      {
        creationId: "unsaved-1",
        name: "Unsaved",
        saved: false,
        modified: true,
        fileId: null,
      },
    ],
  });
});

for (const [label, stdout, expected] of [
  [
    "an unsuccessful envelope",
    JSON.stringify({ success: false, results: [] }),
    /did not succeed/u,
  ],
  [
    "a missing results array",
    JSON.stringify({ success: true }),
    /no results array/u,
  ],
  ["malformed JSON", "{", /JSON/u],
  [
    "a failed data-file lookup",
    JSON.stringify({
      success: true,
      results: [
        {
          creationId: "saved-1",
          name: "Saved",
          isActive: false,
          isSaved: true,
          isModified: false,
          dataFileError: "metadata unavailable",
        },
      ],
    }),
    /data-file error/u,
  ],
  [
    "missing typed state",
    JSON.stringify({
      success: true,
      results: [
        {
          creationId: "doc-1",
          name: "Document",
          isActive: false,
          isSaved: true,
        },
      ],
    }),
    /isModified/u,
  ],
  [
    "duplicate creation identities",
    JSON.stringify({
      success: true,
      results: [
        {
          creationId: "doc-1",
          name: "First",
          isActive: false,
          isSaved: false,
          isModified: false,
        },
        {
          creationId: "doc-1",
          name: "Second",
          isActive: false,
          isSaved: false,
          isModified: false,
        },
      ],
    }),
    /Duplicate document identity/u,
  ],
  [
    "multiple active documents",
    JSON.stringify({
      success: true,
      results: [
        {
          creationId: "doc-1",
          name: "First",
          isActive: true,
          isSaved: false,
          isModified: false,
        },
        {
          creationId: "doc-2",
          name: "Second",
          isActive: true,
          isSaved: false,
          isModified: false,
        },
      ],
    }),
    /multiple active/u,
  ],
] as const) {
  test(`public document JSON rejects ${label}`, () => {
    assert.throws(() => parseDocumentInventory(stdout), expected);
  });
}
