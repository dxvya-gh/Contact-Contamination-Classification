# BHEED-RAKSHAK — Implementation Plan

## Product scope

BHEED-RAKSHAK is a simulation-first, offline environmental safety dashboard for a provisional three-zone crowd venue. The prototype operates on anonymous aggregate occupancy and environmental telemetry only. It does not collect, infer, store, or use identity, demographic, biometric, face-attribute, or individual-tracking data. Routing is safety-first and uses occupancy, CPI, temperature, humidity, distance, and explicitly selected comfort/accessibility needs.

## Design direction

- **Design movement:** Calm control-room / civic instrumentation — precise enough for operators, quiet enough to scan under pressure.
- **Core principles:** signal over decoration; progressive disclosure; every alert names a cause and response; no telemetry without context.
- **Color philosophy:** graphite surfaces reduce visual noise; electric cyan is the ownable BHEED signal; amber and coral communicate rising pressure without turning the whole interface into an alarm.
- **Layout paradigm:** a left diagnostic rail and offset, chart-led command surface. The venue zone cards establish the spatial read; supporting panels attach to that read rather than forming a generic centered grid.
- **Signature elements:** the B-mark signal glyph, hairline grid overlays, and small diagnostic rails with explicit freshness/readiness labels.
- **Interaction philosophy:** controls are reversible and simulation states are always visible. Zone selection, route preference, incident injection, actuation toggles, and simulation speed update the same shared state.
- **Animation:** restrained 180–260ms transitions, pulsing only on live signal dots and active alert borders, no decorative looping motion.
- **Typography:** Space Grotesk for interface hierarchy with IBM Plex Mono for readings, labels, timestamps, and telemetry.
- **Brand essence:** an anonymous, environment-first command surface that helps venue operators keep crowd movement in a safe rhythm. Personality: watchful, composed, humane.
- **Brand voice:** direct and calm. Example lines: “Keep the crowd in a safe rhythm.” / “Act on pressure before it becomes a bottleneck.”
- **Wordmark / logo:** a split B-shaped glyph made from two cyan signal brackets, paired with the spaced BHEED-RAKSHAK wordmark.
- **Signature brand color:** electric cyan `#61e7d6`.

## Implementation approach

- Vite + React + TypeScript, with a single dashboard route and anchored views for zones, routing, simulation, alerts, hardware, impact, and privacy/system information.
- Deterministic local simulation state seeded with three zones. The simulation adapter is isolated in `src/simulation.ts` so future ESP32, SHT31, and touch-sensor adapters can replace it without changing the UI contract.
- Derived values include CPI, heat index, comfort score, threshold state, safety alerts, route recommendation, sensor freshness, and simulated actuation impact.
- No backend, database, auth, analytics, or identity-bearing storage in this phase. The dashboard remains usable offline after asset load.
- Static route manifest is served from `public/manus-routes.json`.

## Project structure

- `src/main.tsx` — React entry point, dashboard state, reusable cards and chart primitives.
- `src/styles.css` — responsive control-room visual system, layout, surfaces, states, and motion.
- `public/manus-routes.json` — implementation-ready page route declarations.
- `app.config.ts` — project logo metadata hook.
- `plan.md` / `TODO.md` — approved scope and outcome criteria.
