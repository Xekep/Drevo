import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url);

test("App delegates secondary pages instead of importing their implementations", () => {
  const app = readFileSync(new URL("src/App.tsx", root), "utf8"),
    section = readFileSync(
      new URL("src/components/archive-section.tsx", root),
      "utf8",
    );
  assert.match(app, /from "\.\/components\/archive-section"/);
  for (const module of [
    "people-catalog",
    "families-catalog",
    "gallery",
    "places-map",
  ])
    assert.doesNotMatch(app, new RegExp(`components\\/${module}`));
  assert.match(section, /const PeopleCatalog = lazy/);
  assert.match(section, /const FamiliesCatalog = lazy/);
  assert.match(section, /const Gallery = lazy/);
  assert.match(section, /const PlacesMap = lazy/);
  assert.match(section, /const InsightsPage = lazy/);
});

test("App delegates photo viewer and upload state to photo workspace", () => {
  const app = readFileSync(new URL("src/App.tsx", root), "utf8"),
    workspace = readFileSync(
      new URL("src/hooks/usePhotoWorkspace.ts", root),
      "utf8",
    ),
    overlays = readFileSync(
      new URL("src/components/photo-workspace-overlays.tsx", root),
      "utf8",
    );

  assert.match(app, /usePhotoWorkspace\(family\)/);
  assert.match(app, /<PhotoWorkspaceOverlays/);
  for (const module of ["photo-viewer", "photo-upload", "photo-albums"])
    assert.doesNotMatch(app, new RegExp(module));
  assert.match(workspace, /const \[uploadOpen, setUploadOpen\]/);
  assert.match(workspace, /const openPhoto = useCallback/);
  assert.match(overlays, /<PhotoUpload/);
  assert.match(overlays, /<PhotoViewer/);
});
