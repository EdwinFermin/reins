# Motion — animation contract

> The motion layer of `docs/design.md`. The `implementer` builds to it; the `design-reviewer` audits
> it on any diff that adds or changes animation, transition, or transform. **Severity-driven** — most
> motion findings are Advisory; a few are Block. Good motion is **felt, not noticed**: it explains a
> change, it never performs.

## When to animate — and when not

- **Animate** to preserve continuity and give feedback: enter/exit of an element, a layout shift,
  expand/collapse, a state change the user caused, drag, or a value updating in place. The animation
  should answer "what just happened / where did this come from".
- **Do not animate** decoratively: on-load reveals that delay content, anything that sits between the
  user and their goal, ambient infinite loops with no purpose, or "because it looks alive". When in
  doubt, ship it static — no animation beats a gratuitous one.

## Motion vocabulary

- **Duration.** UI affordances (hover, toggle, small enter/exit): **~150–250ms**. Larger or
  longer-distance moves can go further, but rarely past ~400ms. Anything slower makes the UI feel
  sluggish; anything near-instant on a large move feels abrupt.
- **Easing.** **ease-out** for elements entering (fast then settle), **ease-in** for elements leaving.
  Never **linear** for spatial motion — linear reads as mechanical. Reserve bounce/overshoot for
  playful brands and small elements, never for serious or large surfaces.
- **Spring vs tween.** Use **springs** for interactive, interruptible, or draggable motion (it tracks
  intent naturally); use **tweens** for discrete state transitions with a defined start and end.
- **Proportion.** Distance and scale are proportional to the element: a small chip moves a small
  distance; a full panel travels further and slightly slower. A tiny element flying across the screen
  is wrong.
- **One language.** A surface uses **one** coherent set of durations and easings. Mixed easings and
  random durations across the same screen read as slop.

## Implementer conditions

- **Respect `prefers-reduced-motion`.** Provide a reduced/instant variant for users who ask for it;
  never ship motion that ignores the media query, especially on essential flows.
- **Animate compositor-friendly properties** — `transform` and `opacity` — not layout properties
  (`width`, `height`, `top`, `left`, `margin`), which cause jank.
- **Make motion interruptible.** An animation mid-flight responds to new input (springs do this for
  free); it does not queue or block interaction.
- **Keep it coherent.** Match the durations/easings already used on adjacent surfaces; don't invent a
  new motion vocabulary for one component.

## Reviewer checks

- A duration far outside the ~150–250ms band for a UI affordance with no spatial justification.
- **Linear** easing on spatial motion; bounce/overshoot on a serious or large surface.
- Missing `prefers-reduced-motion` handling on a surface that animates.
- Animating `width`/`height`/`top`/`left`/`margin` (jank) where a `transform` would do.
- A decorative on-load animation that delays the user reaching content.
- Mixed easings/durations within one surface; motion that performs instead of explaining.

## Severity

- **Block** — motion that blocks or delays interaction on a hot path, ignores
  `prefers-reduced-motion` on an essential/accessibility-sensitive flow, or causes visible jank by
  animating layout properties.
- **Advisory** — off-band durations, mildly inconsistent easing, a decorative flourish that is
  harmless but unnecessary.
