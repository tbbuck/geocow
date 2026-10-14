// Keeping the map, the URL and the history stack in agreement.
//
// Three things race here. The camera animates, so it reports where it is for
// some time after it was told to move. Parsing is asynchronous, so geometry
// arrives some time after the link asking for it was opened. And the user can
// navigate again at any point during either.
//
// Everything that changes which history entry is on screen — a back or
// forward, a plot, a share — advances the generation. Work started for an
// earlier generation checks in before it applies its results, and stands
// down if the ground has moved. Without that, holding the back button leaves
// whichever fetch happened to be slowest deciding what the map shows.

export class NavigationTracker {
  /** The history entry currently on screen. */
  private current = 0;
  /** The entry an in-flight programmatic camera move belongs to. */
  private camera = 0;

  /** Move to a new history entry, returning its generation. */
  advance(): number {
    this.current++;
    return this.current;
  }

  /** The generation to hand to work started now. */
  get generation(): number {
    return this.current;
  }

  /** True if work tagged `generation` still applies. */
  isCurrent(generation: number | undefined): boolean {
    return generation === undefined || generation === this.current;
  }

  /** Note that a camera move is being started for the current entry. */
  beginCameraMove(): void {
    this.camera = this.current;
  }

  /**
   * Whether a camera report should be written to the URL.
   *
   * A gesture always counts: the user is dragging the map of the entry that
   * is on screen, by definition. A move the app started only counts while the
   * entry it was started for is still showing — otherwise it is the tail of
   * an animation the user has already navigated away from, and writing it
   * would stamp a stale view onto the entry they are now on.
   */
  allowsViewWrite(fromUser: boolean): boolean {
    if (fromUser) {
      // Whatever the camera was doing, the user has taken it over.
      this.camera = this.current;
      return true;
    }
    return this.camera === this.current;
  }

  /** Hand an in-flight camera move to the entry just advanced to. */
  adoptCameraMove(): void {
    this.camera = this.current;
  }
}
