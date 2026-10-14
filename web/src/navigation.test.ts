import { describe, it, expect, beforeEach } from "vitest";

import { NavigationTracker } from "./navigation";

describe("NavigationTracker", () => {
  let nav: NavigationTracker;

  beforeEach(() => {
    nav = new NavigationTracker();
  });

  it("treats work started now as current", () => {
    expect(nav.isCurrent(nav.generation)).toBe(true);
  });

  it("treats untagged work as always current", () => {
    // Plotting from the box isn't tied to a navigation, so it never expires.
    nav.advance();
    expect(nav.isCurrent(undefined)).toBe(true);
  });

  it("supersedes work from an earlier entry", () => {
    const started = nav.generation;
    nav.advance();
    expect(nav.isCurrent(started)).toBe(false);
  });

  it("gives each entry its own generation", () => {
    const a = nav.advance();
    const b = nav.advance();
    expect(a).not.toBe(b);
    expect(nav.isCurrent(a)).toBe(false);
    expect(nav.isCurrent(b)).toBe(true);
  });

  // The bug this exists for: a back press during a camera animation. The
  // animation finishes afterwards and reports its final position, which must
  // not be written onto the entry the user has just moved to.
  it("drops a camera report from an entry that has been left", () => {
    nav.beginCameraMove();
    expect(nav.allowsViewWrite(false)).toBe(true);

    nav.advance();
    expect(nav.allowsViewWrite(false)).toBe(false);
  });

  it("keeps accepting reports for a camera move on the current entry", () => {
    nav.beginCameraMove();
    expect(nav.allowsViewWrite(false)).toBe(true);
    expect(nav.allowsViewWrite(false)).toBe(true);
  });

  it("always accepts a gesture, whatever the camera was doing", () => {
    nav.beginCameraMove();
    nav.advance();
    expect(nav.allowsViewWrite(false)).toBe(false);
    expect(nav.allowsViewWrite(true)).toBe(true);
  });

  it("lets a gesture hand the camera back to the current entry", () => {
    nav.beginCameraMove();
    nav.advance();
    nav.allowsViewWrite(true); // user grabs the map
    // Inertia from that gesture reports without an originalEvent; it belongs
    // to the entry the user is on and should still be written.
    expect(nav.allowsViewWrite(false)).toBe(true);
  });

  // Plotting pushes an entry while the fit that prompted it is still
  // animating. That animation belongs to the new entry, not the old one.
  it("can hand an in-flight camera move to the new entry", () => {
    nav.beginCameraMove();
    nav.advance();
    expect(nav.allowsViewWrite(false)).toBe(false);
    nav.adoptCameraMove();
    expect(nav.allowsViewWrite(false)).toBe(true);
  });

  it("survives a burst of navigations", () => {
    const generations = [nav.advance(), nav.advance(), nav.advance()];
    // Only the last one is live; the two restores still in flight stand down.
    expect(generations.map((g) => nav.isCurrent(g))).toEqual([
      false,
      false,
      true,
    ]);
  });
});
