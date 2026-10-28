# finbrief — UI/UX Design Direction

**Status: binding contract.** Any UI work in this repo builds to this
document, not to vibes. "Premium and professional, not vibe coded" is
operationalized below into decisions a PR can be reviewed against.

## 1. Purpose

finbrief is a read-only personal-finance agent: scheduled, source-linked
briefings on where money went and whom the user owes, plus chat Q&A and a
debt/IOU ledger. The first screen is the **product** (briefings + ledger +
chat), never a marketing landing page.

## 2. Audience

People tracking their own money and informal debts. They return daily or
weekly; they scan, they don't explore. Money is trust-sensitive: the
interface must feel like a institution's statement, not a toy. The three
scan targets, in order: *what happened*, *what is stale*, *what do I owe /
what is owed to me*.

## 3. Tone

**Calm editorial / quiet financial console.** A premium financial
newspaper crossed with a precise instrument panel. Restrained, dense where
density serves scanning, generous where prose needs air. The memorability
comes from craft and precision, not decoration.

## 4. Decisions (reviewable)

- **Palette.** Warm off-white paper with near-black ink (light) and a true
  neutral dark theme; both first-class. One precise accent (deep ink-blue)
  for interactive elements only. Semantic money colors (positive/negative)
  reserved exclusively for money direction, with WCAG 2.2 AA contrast, and
  never the *only* signal (sign/direction carries the meaning too). No
  gradients, no hue-soup: multi-dimensional but quiet.
- **Typography.** One high-quality text face for briefing prose (editorial
  register), tabular lining figures for all money, dates, and counts. A
  fixed modular type scale — no ad-hoc font sizes in components. Sentence
  case everywhere; uppercase only for small labels.
- **Money rendering.** Right-aligned, tabular figures, fixed decimal
  alignment, explicit currency and sign. Stale figures always carry the
  as-of stamp (the Step 2.2 freshness gate surfaces visually — stale data
  must never *look* current). Every figure exposes its `sourceRef`
  provenance through a quiet affordance (hover/focus detail linking the
  underlying rows) — the trust contract made visible.
- **Surfaces & components.** Flat layers with hairline dividers; shadows
  only for genuinely elevated surfaces (menus, dialogs). No cards inside
  cards. Table-first for the ledger. One button vocabulary (primary /
  secondary / ghost), one input style, designed hover/focus/disabled/
  loading states for each. Icons for familiar tool actions, from one icon
  set, at one weight.
- **Motion.** Functional only: 120–180ms transitions that clarify state
  (appear, collapse, confirm). Nothing decorative, nothing over 200ms, no
  parallax or scroll effects. `prefers-reduced-motion` disables all of it.
- **States are designed, not improvised.** Every data surface specifies
  empty, loading, error, and stale states. Fail-closed UI mirrors fail-
  closed data: a missing briefing renders an honest empty state with
  next-run time — never a skeleton implying content that isn't there.
- **Accessibility.** WCAG 2.2 AA: contrast, visible focus rings, full
  keyboard operation, semantic landmarks, and screen-reader-correct money
  announcements (currency + signed amount). Touch targets ≥ 44px.
- **Responsive.** Fixed-format elements (tables, counters, toolbars) hold
  stable dimensions across states; labels wrap, never overflow; the
  briefing reads well at 360px and at 1600px.

## 5. Anti-patterns (automatic PR reject)

Purple/gradient hero sections, decorative blobs, glassmorphism, emoji as
iconography, oversized marketing typography, stock-atmospheric imagery,
cards nested in cards, feature-describing prose inside the UI, one-note
monochrome palettes, unlabeled skeleton loaders, color-only status.

## 6. Review gate

Any PR touching UI must include before/after screenshots and pass the
`frontend-design-direction` review checklist (hierarchy, contrast, stable
dimensions, honest states, motion restraint). Design changes update this
document in the same PR.
