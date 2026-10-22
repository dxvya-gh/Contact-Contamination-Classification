# BHEED-RAKSHAK — Implementation Outcomes

- [ ] **Dashboard command surface** — Deliver a responsive dark control-room dashboard for a provisional three-zone venue with high-contrast graphite panels, electric-cyan signals, amber/coral warnings, sparse grid overlays, diagnostic rails, clear hierarchy, and chart-led visual storytelling.
- [ ] **Anonymous zone monitoring and derived safety metrics** — Show anonymous occupancy counts, CPI, heat index, comfort score, temperature, humidity, current readings, trends, thresholds, and clear status states for all three zones.
- [ ] **Understandable alerts** — Derive simulated warnings from crowd-pressure and environmental thresholds; every alert shows zone, severity, cause, timestamp, and recommended response.
- [ ] **Safe route comparison** — Compare routes using only occupancy, CPI, temperature, humidity, distance, and explicitly selected comfort/accessibility needs; never use demographic or identity attributes.
- [ ] **Simulation controls** — Support starting, pausing, resetting, accelerating, manually varying occupancy and environmental readings, injecting sensor faults, and simulating incident scenarios.
- [ ] **Sensor health and hardware readiness** — Show source connectivity, freshness, fault state, calibration/readiness indicators, and planned ESP32, SHT31, and touch-sensor channels.
- [ ] **Actuation simulation** — Provide visible simulated responses for signage, ventilation, access-flow guidance, and zone restrictions with rationale and manual controls.
- [ ] **Impact view** — Show before/after and time-series effects of alerts, routing, and simulated actuations on congestion, environmental comfort, and venue safety indicators.
- [ ] **Offline-first architecture and route manifest** — Keep deterministic demo data local and expose a replaceable hardware abstraction layer plus route declarations for dashboard, zone detail, routing, simulation, alerts, hardware readiness, and system/privacy screens.
