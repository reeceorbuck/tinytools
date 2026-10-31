/**
 * A carousel: slides in a row that scrolls a slide at a time, by swipe,
 * scroll, its buttons or its dots, optionally moving on by itself.
 *
 * ```tsx
 * const { component } = await tiny.imports(CarouselSignalComponent);
 * const photos = component.instance();
 *
 * <photos.Track label="Intra-oral photos" loop>
 *   <photos.Slide><img src="/a.jpg" alt="Upper arch" /></photos.Slide>
 *   <photos.Slide><img src="/b.jpg" alt="Lower arch" /></photos.Slide>
 * </photos.Track>
 * <photos.Previous /> <photos.Dots /> <photos.Next /> <photos.Status />
 * ```
 *
 * The track is a scroll container snapping to each slide, so it works by
 * touch, trackpad and the arrow keys without the page's script, and the
 * script only follows and steers it. `--carousel-slide` sets a slide's
 * width (default `100%`), so several may show at once.
 *
 * With `autoplay`, it moves on every that many milliseconds while the
 * pointer and focus are elsewhere, unless the viewer prefers reduced
 * motion; a `Play` button pauses and resumes it.
 *
 * Colours come from custom properties a caller may set on any ancestor:
 * `--carousel-border`, `--carousel-muted` and `--carousel-accent`.
 *
 * @module
 */

// deno-lint-ignore verbatim-module-syntax -- `h` is the classic JSX factory
import { h } from "../../jsx-runtime.ts";
import { tiny } from "../../mod.ts";
import { css } from "../../scopedStyles.ts";
import { signalTools } from "../../handlers/signals.ts";
import type { LifecycleElement } from "../../lifecycleElement.ts";

/**
 * Per instance: the slide at the start of the track, how many there are,
 * whether it wraps around, and whether it is moving on by itself.
 */
const carouselSignals = new tiny.Signals(
  import.meta.url,
  ({ Signal, Computed, perInstance }) =>
    perInstance(() => {
      const index = new Signal(0);
      const count = new Signal(0);
      const loop = new Signal<boolean>(false);
      const playing = new Signal<boolean>(false);
      return {
        index,
        count,
        loop,
        playing,
        atStart: new Computed(
          () => !loop.value && index.value <= 0,
          [index, loop],
        ),
        atEnd: new Computed(
          () => !loop.value && index.value >= count.value - 1,
          [index, count, loop],
        ),
        /** "2 / 5", once the slides are counted. */
        summary: new Computed(
          () => count.value ? `${index.value + 1} / ${count.value}` : "",
          [index, count],
        ),
        playLabel: new Computed(
          () => playing.value ? "Pause" : "Play",
          [playing],
        ),
      };
    }),
);

/** Helpers the handlers share, called through `fn`. */
const carouselTools = new tiny.Handlers(import.meta.url, {
  slides(track: HTMLElement): HTMLElement[] {
    return [...track.querySelectorAll<HTMLElement>(":scope > [data-slide]")];
  },
  /** The slide nearest the track's start, or the last once scrolled to the end. */
  nearest(track: HTMLElement, slides: HTMLElement[]): number {
    if (track.scrollLeft >= track.scrollWidth - track.clientWidth - 1) {
      return slides.length - 1;
    }
    const start = track.getBoundingClientRect().left;
    let best = 0;
    slides.forEach((slide, index) => {
      const distance = Math.abs(slide.getBoundingClientRect().left - start);
      const bestDistance = Math.abs(
        slides[best].getBoundingClientRect().left - start,
      );
      if (distance < bestDistance) best = index;
    });
    return best;
  },
  /** Scrolls the track to put `slide` at its start. */
  scrollToSlide(track: HTMLElement, slide: HTMLElement): void {
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({
      left: track.scrollLeft + slide.getBoundingClientRect().left -
        track.getBoundingClientRect().left,
      behavior: still ? "instant" : "smooth",
    });
  },
});

/** The track, holding its autoplay and scroll timers. */
type Track = HTMLElement & LifecycleElement & {
  carouselPlay?: ReturnType<typeof setInterval>;
  carouselScroll?: ReturnType<typeof setTimeout>;
  /** The slide the track was last scrolled to, or settled on. */
  carouselShown?: number;
};

const carouselHandlers = new tiny.Handlers(import.meta.url, async () => {
  const { fn, signal } = await tiny.imports(carouselSignals, carouselTools);
  return {
    /** Counts and labels the slides, and starts any autoplay. */
    adoptTrack: function (this: Track) {
      const slides = fn.slides(this);
      slides.forEach((slide, index) => {
        slide.setAttribute(
          "aria-label",
          slide.dataset.label ?? `${index + 1} of ${slides.length}`,
        );
      });
      signal.count.forInstance(this).value = slides.length;
      signal.loop.forInstance(this).value = this.hasAttribute("data-loop");
      // It starts at the first slide; a scroll the browser restores is
      // followed once it settles.
      this.carouselShown = signal.index.forInstance(this).value;
      this.abortController.signal.addEventListener(
        "abort",
        () => clearInterval(this.carouselPlay),
      );
      const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (this.dataset.autoplay && !still) {
        signal.playing.forInstance(this).value = true;
      }
    },
    /**
     * Scrolls to the slide `index` names, and starts or stops moving on by
     * itself as `playing` changes.
     */
    showSlide: function (this: Track) {
      const slides = fn.slides(this);
      const index = signal.index.forInstance(this);
      const slide = slides[index.value];
      if (slide && this.carouselShown !== index.value) {
        this.carouselShown = index.value;
        fn.scrollToSlide(this, slide);
      }
      const playing = signal.playing.forInstance(this).value;
      if (!playing) {
        clearInterval(this.carouselPlay);
        this.carouselPlay = undefined;
        return;
      }
      if (this.carouselPlay) return;
      this.carouselPlay = setInterval(() => {
        // Holds still while the viewer is looking at or using it.
        if (this.matches(":hover, :focus-within") || document.hidden) return;
        const count = signal.count.forInstance(this).value;
        if (count) index.value = (index.value + 1) % count;
      }, Number(this.dataset.autoplay) || 5000);
    },
    /** Follows a scroll by any means, once it settles. */
    trackScrolled: function (this: Track) {
      clearTimeout(this.carouselScroll);
      this.carouselScroll = setTimeout(() => {
        this.carouselShown = fn.nearest(this, fn.slides(this));
        signal.index.forInstance(this).value = this.carouselShown;
      }, 100);
    },
    previousSlide: function (this: HTMLButtonElement) {
      const index = signal.index.forInstance(this);
      const count = signal.count.forInstance(this).value;
      if (index.value > 0) index.value -= 1;
      else if (signal.loop.forInstance(this).value) index.value = count - 1;
    },
    nextSlide: function (this: HTMLButtonElement) {
      const index = signal.index.forInstance(this);
      const count = signal.count.forInstance(this).value;
      if (index.value < count - 1) index.value += 1;
      else if (signal.loop.forInstance(this).value) index.value = 0;
    },
    /** Draws a dot per slide, marking the current one. */
    showDots: function (this: HTMLElement) {
      const count = signal.count.forInstance(this).value;
      const index = signal.index.forInstance(this).value;
      if (this.children.length !== count) {
        this.replaceChildren(...Array.from({ length: count }, (_, at) => {
          const dot = document.createElement("button");
          dot.type = "button";
          dot.dataset.index = String(at);
          dot.setAttribute("aria-label", `Slide ${at + 1}`);
          return dot;
        }));
      }
      for (const dot of this.children) {
        const current = (dot as HTMLElement).dataset.index === String(index);
        if (current) dot.setAttribute("aria-current", "true");
        else dot.removeAttribute("aria-current");
      }
    },
    chooseDot: function (this: HTMLElement, event: MouseEvent) {
      const dot = (event.target as Element).closest?.("[data-index]") as
        | HTMLElement
        | null;
      if (dot) signal.index.forInstance(this).value = Number(dot.dataset.index);
    },
    togglePlay: function (this: HTMLButtonElement) {
      const playing = signal.playing.forInstance(this);
      playing.value = !playing.value;
    },
  };
});

const carouselStyles = new tiny.Styles(import.meta.url, {
  track: css`
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: var(--carousel-slide, 100%);
    gap: var(--carousel-gap, 0.75rem);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    border-radius: 10px;

    &::-webkit-scrollbar {
      display: none;
    }
    &:focus-visible {
      outline: 2px solid var(--carousel-accent, oklch(50.8% 0.105 165.6));
      outline-offset: 2px;
    }
  `,
  slide: css`
    scroll-snap-align: start;
    min-width: 0;
  `,
  button: css`
    display: inline-grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border: 1px solid var(--carousel-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
    border-radius: 50%;
    background: light-dark(oklch(100% 0 0), oklch(20% 0 0));
    color: inherit;
    font: inherit;
    font-size: 1.25rem;
    cursor: pointer;

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }
    @media (scripting: none) {
      display: none;
    }
  `,
  dots: css`
    display: inline-flex;
    gap: 0.375rem;
    align-items: center;

    > button {
      width: 0.625rem;
      height: 0.625rem;
      padding: 0;
      border: none;
      border-radius: 999px;
      background: var(--carousel-muted, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
      cursor: pointer;
      transition: width 150ms ease;
    }
    > button[aria-current="true"] {
      width: 1.5rem;
      background: var(--carousel-accent, oklch(50.8% 0.105 165.6));
    }
    @media (prefers-reduced-motion: reduce) {
      > button {
        transition: none;
      }
    }
  `,
  play: css`
    padding: 0.25rem 0.75rem;
    border: 1px solid var(--carousel-border, light-dark(oklch(87.2% 0.009 258.3), oklch(32.8% 0.007 258.3)));
    border-radius: 999px;
    background: light-dark(oklch(100% 0 0), oklch(20% 0 0));
    color: inherit;
    font: inherit;
    font-size: 0.8125rem;
    cursor: pointer;

    @media (scripting: none) {
      display: none;
    }
  `,
});

/**
 * `Track` holds the `Slide`s; `Previous`, `Next`, `Dots`, `Status` and
 * `Play` sit anywhere around it. All expose `signal.index`, the slide at the
 * track's start, which scrolls there when set, and `signal.count`.
 */
export const CarouselSignalComponent = new tiny.SignalComponent(
  async ({ instanced }) => {
    const { fn, signal, styled } = await tiny.imports(
      carouselSignals,
      carouselHandlers,
      carouselStyles,
      signalTools,
    );
    // Controls placed after the track connect once it has changed these
    // signals, so each catches up with `fireSelfSignal`.
    const exposed = [signal.index, signal.count];
    return {
      Track: instanced((props: {
        /** Names the carousel to assistive technology. */
        label?: string;
        /** Wraps around from the last slide to the first, and back. */
        loop?: boolean;
        /** Moves on by itself every this many milliseconds. */
        autoplay?: number;
        children?: unknown;
      }) => (
        <div
          role="region"
          aria-roledescription="carousel"
          aria-label={props.label}
          class={styled.track}
          tabindex="0"
          data-loop={props.loop ? "" : undefined}
          data-autoplay={props.autoplay ? String(props.autoplay) : undefined}
          onConnect={[signal.index, signal.playing, fn.adoptTrack]}
          onSignal={fn.showSlide}
          onScroll={fn.trackScrolled}
        >
          {props.children}
        </div>
      ), exposed),
      Slide: (props: {
        /** Names the slide; by default "2 of 5". */
        label?: string;
        children?: unknown;
      }) => (
        <div
          role="group"
          aria-roledescription="slide"
          class={styled.slide}
          data-slide=""
          data-label={props.label}
        >
          {props.children}
        </div>
      ),
      Previous: instanced((props: { children?: unknown }) => (
        <button
          type="button"
          class={styled.button}
          aria-label="Previous slide"
          disabled={signal.atStart}
          onConnect={[signal.atStart, fn.fireSelfSignal]}
          onClick={fn.previousSlide}
        >
          {props.children ?? "‹"}
        </button>
      ), exposed),
      Next: instanced((props: { children?: unknown }) => (
        <button
          type="button"
          class={styled.button}
          aria-label="Next slide"
          disabled={signal.atEnd}
          onConnect={[signal.atEnd, fn.fireSelfSignal]}
          onClick={fn.nextSlide}
        >
          {props.children ?? "›"}
        </button>
      ), exposed),
      Dots: instanced((props: { label?: string }) => (
        <div
          role="group"
          class={styled.dots}
          aria-label={props.label ?? "Choose a slide"}
          onConnect={[signal.count, signal.index, fn.showDots]}
          onSignal={fn.showDots}
          onClick={fn.chooseDot}
        />
      ), exposed),
      Status: instanced(
        () => (
          <output
            aria-live="polite"
            onConnect={[signal.summary, fn.fireSelfSignal]}
            onSignal={fn.setTextContent}
          />
        ),
        exposed,
      ),
      Play: instanced(() => (
        <button
          type="button"
          class={styled.play}
          onConnect={[signal.playLabel, fn.fireSelfSignal]}
          onSignal={fn.setTextContent}
          onClick={fn.togglePlay}
        >
          Play
        </button>
      ), exposed),
    };
  },
);
