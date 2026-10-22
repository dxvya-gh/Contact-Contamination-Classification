# SmartLogix ESP32 IoT Dashboard & Contamination-Risk Estimator

An industrial-grade, lightweight IoT dashboard and embedded firmware system for venue door handles, turnstiles, and shared touchpoints. Built with **plain HTML, CSS, and modern JavaScript (ES Modules)** on the frontend and an **ESP32 microcontroller with SHT31 environmental sensing and dual capacitive touch zones** on the hardware side.

The system features a modular, explainable, time-decaying **Estimated Contamination-Risk Model** with real-time score dynamics explanation, threshold alerts, an authoritative sanitization-recording action, an algorithm information modal, and boot-state recovery.

---

## 1. Diagnostic Report: Root Cause of the Zero-Score Issue

### The Observed Defect
In the dashboard screenshot, both GPIO12 and GPIO14 were marked **TOUCHED** with raw readings around 101 and 118, but:
- The **Estimated Contamination Risk** score remained `0.0`.
- The **Confirmed Contact Events** count remained `0`.
- The **Recent Activity** table was completely empty.

### Root Cause Analysis
1. **Disconnected Telemetry Ingestion in the Webpage:**
   `app.js` rendered the hardware touch badges (`TOUCHED` / `RELEASED`) by evaluating `evaluateTouchState()`. However, `app.js` did **not** feed these evaluated logical touch states into any event detector or state machine.
   Instead, `renderRiskEstimator()` expected the ESP32 to publish an existing `data.riskScore` and `data.touchCount`. Because the deployed ESP32 firmware only published raw/basic sensor telemetry (`touch12`, `touch14`, `zone12_touched`, `zone14_touched`, `temperature`, `humidity`, `updatedAt`), `data.riskScore` was `undefined`.
   The code fell back to `score = 0.0` and `totalTouches = 0`. Since the score never changed from 0, no delta was detected, and no activity log entries were recorded.

2. **Resolution Applied:**
   - **Frontend (`app.js`):** Implemented a deterministic client-side `ContaminationRiskEngine`. It actively consumes the confirmed logical touch states (`isTouch12Active`, `isTouch14Active`) on every snapshot. When touches occur, it enforces a 2-sample debounce, runs the 300 ms dual-zone window, applies exponential time decay, increments the score (+2 single, +3 dual), triggers threshold alerts ($\ge 75$), populates the activity log table, and draws the trend chart.
   - **Immediate Initial State Recognition:** If the dashboard opens or receives a snapshot where electrodes are already in contact (e.g. raw 101 and 118), the engine immediately recognizes the active contact, records the event, and updates the score without remaining stuck at 0.
   - **Firmware (`esp32_sht31_touch.ino`):** Added a protective threshold floor (`max(baseline * 0.70, 150)`) so touches are reliably detected even if baseline calibration occurs with hands near the electrodes, and ensured field names match Firebase exactly.

---

## 2. Contamination-Risk Estimator Algorithm

> **Scientific Classification:** The risk score is an **Estimated Relative Contamination Risk** based on contact frequency, touch patterns, and environmental heuristics. It is **not** a direct microbial cell count, ATP measurement, or infection probability.

### A. Contact Detection & Debounce
- **Electrodes:** GPIO12 (Zone 1) and GPIO14 (Zone 2).
- **Sampling Rate:** Every 100 ms.
- **Debounce Confirmation:** Requires 2 consecutive readings below threshold (`baseline * 0.70`) before confirming a touch event to eliminate transient electrical noise.
- **Continuous Hold Protection:** Counted once at initial contact start; continuous holds are never counted repeatedly.

### B. Dual-Zone Classification (300 ms Window)
- **Window:** 300 ms (`DUAL_ZONE_WINDOW_MS = 300`).
- **Logic:**
  - If both Zone 1 and Zone 2 activate within 300 ms of each other, the event is classified as **one Dual-Zone Contact** (+3 points).
  - It does **not** double-count as two single-zone events plus one dual-zone event.
  - If only one zone activates and the 300 ms window expires without the second zone activating, it is classified as **one Single-Zone Contact** (+2 points).
- **Counters:** Maintained separately: `singleZoneCount`, `dualZoneCount`, and total `touchCount`.

### C. Event Weights
- **Confirmed Single-Zone Event:** `+2.0` provisional points
- **Confirmed Dual-Zone Event:** `+3.0` provisional points
- **Score Limits:** Strictly clamped between `0.0` and `100.0`.
- **Duration Tracking:** Contact duration is measured in milliseconds from initial touch to complete release and displayed independently without arbitrarily inflating the score.

### D. Time Decay Formula
Risk decays exponentially over elapsed monotonic time:

$$R(t) = R(\text{previous}) \times \exp\left(-\frac{\Delta t}{\tau_{\text{effective}}}\right)$$

- **Base Persistence Timescale ($\tau_{\text{base}}$):** 1800 seconds (30 minutes).
- **Time Base:** Monotonic clock (`Date.now()` / `millis()`) to eliminate clock-skew.

### E. Environmental Modifier (SHT31)
Ambient temperature and relative humidity modulate the effective decay timescale ($\tau_{\text{effective}}$) using a bounded heuristic:

$$\text{Modifier} = 1.0 + (\text{Temp} - 22.0) \times 0.01 + (\text{Humidity} - 50.0) \times 0.005$$
$$\text{clamped to } [0.70, 1.40]$$
$$\tau_{\text{effective}} = \frac{\tau_{\text{base}}}{\text{Modifier}}$$

- Warm and humid environments moderately prolong estimated persistence, while dry or cooler environments slightly shorten it.
- If SHT31 data is unavailable or non-finite, the model gracefully falls back to $\text{Modifier} = 1.00$.

### F. Risk Bands & Sanitization Recommendation
| Score Range | Risk Level | Meaning | Progress Bar Color |
| :---: | :---: | :--- | :---: |
| **0 – 24** | **Low** | Baseline contact accumulation. Minimal risk. | Green (`#10b981`) |
| **25 – 49** | **Elevated** | Moderate contact frequency. Ongoing decay in effect. | Cyan (`#38bdf8`) |
| **50 – 74** | **High** | Frequent touch events detected. Approaching threshold. | Amber (`#f59e0b`) |
| **75 – 100** | **Critical** | **Sanitization Recommended!** Action required. | Red (`#f43f5e`) |

- **Threshold Alert:** When the score crosses $\ge 75$, a prominent warning banner activates on the dashboard.
- **Persistence:** Viewing or dismissing the alert does **not** reset the risk score.

---

## 3. Algorithm Information Modal (ⓘ)

An interactive information button **ⓘ** is located beside the **Estimated Contamination Risk** heading:
- **Click or Keyboard Accessible:** Opens a modal dialog matching the dark control-room theme.
- **Dynamic Configuration Values:** Injects actual model configuration parameters (`dualZoneWindowMs`, `scoreIncSingle`, `scoreIncDual`, `baseTauSeconds`, `sanitizationThreshold`, `envModifierRange`) from `MODEL_CONFIG`.
- **Keyboard Navigation:** Closes with the `Escape` key, the close button (`×`), the "Close" button, or by clicking outside the modal backdrop. Clicking inside the card does not close it.
- **Sections Included:**
  1. **A. Contact Detection:** Capacitive touch sensing on GPIO12/14, calibrated baseline drop, debounce, and 300 ms dual-zone window.
  2. **B. Event Weights:** Single-zone (+2 pts), dual-zone (+3 pts), hold rejection, and grouping.
  3. **C. Time Decay:** The exponential formula $R(t) = R(\text{previous}) \times \exp(-\Delta t / \tau)$ and base 30-minute timescale.
  4. **D. Environmental Inputs:** SHT31 temperature and humidity modulating decay rate within $[0.70\times, 1.40\times]$.
  5. **E. Score Limits & Risk Bands:** 0–24 Low, 25–49 Elevated, 50–74 High, 75–100 Critical, and 75 sanitization threshold.
  6. **F. Sanitization Reset:** Operator-reported action archiving timestamp and pre-reset score.
  7. **G. Scientific Limitations:** Explicit declaration that capacitive sensors and environmental sensors do not detect viruses or bacteria.

---

## 4. "Mark as Sanitized" Action & Authoritative Sync

1. Operator clicks **"Mark as Sanitized"** in the dashboard.
2. A confirmation modal explains the action and prevents accidental resets.
3. Upon confirmation:
   - Posts command to `devices/door-01/control/sanitizationRequest`:
     ```json
     {
       "requested": true,
       "requestId": "san_1729440000000",
       "requestedAt": 1729440000000,
       "requestedBy": "operator@example.com",
       "status": "pending",
       "preSanitizeScore": 78.4
     }
     ```
   - Resets authoritative model score to `0.0`.
   - Clears active sanitization recommendation.
   - Archives pre-reset score and timestamp in the activity history.
   - Updates `devices/door-01/latest` in Firebase Realtime Database.

---

## 5. How to Run Using VS Code Live Server

1. **Install Live Server Extension:** In VS Code, press `Ctrl + Shift + X`, search for **"Live Server"** (by *Ritwick Dey*), and click **Install**.
2. **Open the Project Folder:** Open `c:\Users\divya\coding\bheed` in VS Code.
3. **Launch the Server:** Right-click [`index.html`](file:///c:/Users/divya/coding/bheed/index.html) and select **"Open with Live Server"** (or click **"Go Live"** in the status bar).
4. **Access the Dashboard:** Browser opens at `http://127.0.0.1:5500/index.html`.
5. **Sign In:** Use your authorized Firebase Authentication email and password.

---

## 6. Step-by-Step Testing & Verification Guide

1. **No Contact Test:**
   - When electrodes are untouched (`raw > threshold`), score remains stable apart from gradual exponential decay.
2. **Single-Zone Contact Test (GPIO12):**
   - Touch GPIO12 $\rightarrow$ Single-zone counter increments by 1, score increases by +2.0.
3. **Single-Zone Contact Test (GPIO14):**
   - Touch GPIO14 $\rightarrow$ Single-zone counter increments by 1, score increases by +2.0.
4. **Dual-Zone Contact Test:**
   - Touch both GPIO12 and GPIO14 within 300 ms $\rightarrow$ Dual-zone counter increments by 1, score increases by +3.0 without double-counting.
5. **Continuous Hold Rejection Test:**
   - Hold electrode for 10 seconds $\rightarrow$ Only one event triggers at contact start; no repeated increments occur during hold. Duration is recorded on release.
6. **New Contact after Release Test:**
   - Release and touch again $\rightarrow$ Another confirmed event is added.
7. **Invalid Environmental Reading Fallback:**
   - If SHT31 disconnected or returning NaN $\rightarrow$ Model uses documented default $1.00\times$ modifier ($\tau = 30\text{ min}$) without corrupting score.
8. **Threshold Alert Test:**
   - Contact sensors until score $\ge 75$ $\rightarrow$ Red critical banner appears with recommendation text.
9. **Sanitization Action Test:**
   - Click "Mark as Sanitized", confirm $\rightarrow$ Score resets to 0.0, banner clears, event log archives reset.
10. **Algorithm Information Popup Test:**
    - Click ⓘ beside heading $\rightarrow$ Modal opens showing sections A–G and dynamic model configuration values. Closes with `Escape` or close button.
