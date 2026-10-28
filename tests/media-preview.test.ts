import assert from "node:assert/strict";
import test from "node:test";
import { archiveResourceUrl, memberPreviewPath } from "../src/domain/archive-context.ts";
import { mediaPreview } from "../src/domain/media-preview.ts";

test("pre-scoped photo previews keep archive and participant identity", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  try {
    for (const pathname of ["/tree", "/a/family-two/tree",
      memberPreviewPath(null, "vk:42"), memberPreviewPath("family-two", "vk:42")]) {
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        location: { pathname, origin: "https://drevo.example" },
      } });
      const scoped = archiveResourceUrl("/media/photo-id.png");
      for (const variant of ["tiny", "avatar", "thumb", "display", "print"] as const) {
        assert.equal(mediaPreview(scoped, variant), `${scoped}?variant=${variant}`);
        assert.equal(mediaPreview("/media/photo-id.png", variant), `${scoped}?variant=${variant}`);
      }
      assert.equal(mediaPreview(`${scoped}?variant=avatar`, "print"), `${scoped}?variant=avatar`);
      assert.equal(mediaPreview(scoped.replace(".png", ".gif"), "print"), scoped.replace(".png", ".gif"));
      assert.equal(mediaPreview("https://external.example/photo.png", "print"), "https://external.example/photo.png");
      if (pathname.includes("/preview/")) {
        assert.equal(mediaPreview("/a/other-tree/media/photo-id.png", "print"),
          archiveResourceUrl("/api/unavailable"));
        assert.equal(mediaPreview("/media/../../../api/family", "print"),
          archiveResourceUrl("/api/unavailable"));
      }
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("explicit archive resources receive print variants without changing the target archive", () => {
  for (const prefix of ["/a/family-one", "/preview/vk%3A42", "/a/family-one/preview/vk%3A42"]) {
    assert.equal(mediaPreview(`${prefix}/media/photo-id.jpg`, "print"), `${prefix}/media/photo-id.jpg?variant=print`);
    const shared = `${prefix}/api/shared/${"a".repeat(43)}/portrait/person-1`;
    assert.equal(mediaPreview(shared, "print"), `${shared}?variant=print`);
    assert.equal(mediaPreview(shared, "display"), shared);
  }
  assert.equal(mediaPreview(undefined, "print"), undefined);
});
