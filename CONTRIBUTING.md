# Contributing

Thanks for looking. Trail Flyover is a small library with one job: turn a GPS track into a smooth
fly-over that looks the same in the preview and in the exported video. Bug reports, ideas and
pull requests are all welcome, in English or Czech.

## Getting started

You need Node.js 22.18 or newer, and Python 3 for the demo server.

```
git clone https://github.com/zpracny/trail-flyover.git && cd trail-flyover
npm ci
npm run check                      # types, linter and tests — run this before every pull request
npm run build && npm run serve     # demo at http://127.0.0.1:8811
```

There is no build step while developing: tests and scripts run straight from the TypeScript in
`src/`. `npm run build:lib` produces the package apps install (`dist/`).

## Where things live

| | |
|---|---|
| `src/core/` | Pure computation with no DOM: the flight plan (`flightPlan.ts`), geometry, GPX reader. Everything here is tested in Node. |
| `src/maplibre/player.ts` | The player: MapLibre map, preview loop, prefetch, export. Needs a browser. |
| `src/hud/hud.ts` | What is drawn over the map: place labels, the tip of the trail, the default panel. Tested with a fake canvas. |
| `demo/` | The demo page. Also the easiest way to see a change. |
| `test/` | `node --test`. One real recording (`test/fixtures`) plus synthetic and random tracks. |

## What a good change looks like

- **The camera stays a pure function of time.** `poseAt(t)` must give the same answer for the same
  input, in preview and in export. No `Date.now()` or `performance.now()` in anything that draws.
- **Tests come with the change.** For camera behaviour, assert the property you care about
  (the tip stays in frame, acceleration stays under a bound) rather than exact numbers.
- **The library stays general.** Things specific to one app (its panel, its photo card, its data
  model) belong in that app; the library offers the hook (`hud`, `flight.stops`, `labels`, …).
- **No new runtime dependencies** without a good reason, and no API keys in built-in basemaps.
- **Texts shown to viewers** go through `src/core/i18n.ts`; errors for developers are in English.
- **Changes to the player** cannot be tested in Node. Say in the pull request how you checked
  them in a browser (the demo is fine), and what you did not check.

## Test data and privacy

The only real recording in the repository starts and ends a kilometre away from where the ride
really did, and its date is shifted. Please do not add GPS tracks that reveal where someone
lives or stays; a synthetic track or a trimmed one works just as well for a test.

## Reporting a bug

A GPX file that shows the problem helps most (trim it first if it starts at your door), together
with the options you used and the browser. For security problems see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the MIT licence of the project.
