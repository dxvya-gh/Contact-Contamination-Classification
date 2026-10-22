/**
 * SmartLogix ESP32 IoT Dashboard & Contamination-Risk Estimator
 * 
 * Modular Firebase SDK v10 (Browser CDN) implementation.
 * Connects to Firebase Authentication & Realtime Database.
 * Features:
 *   - Live SHT31 temperature & humidity display
 *   - Calibrated GPIO12 and GPIO14 capacitive touch readings
 *   - Deterministic touch-event state machine with 300ms dual-zone window
 *   - Continuous exponential time decay (exp(-dt / tau)) with SHT31 env modifier
 *   - Threshold alerts (>= 75) and authoritative sanitization actions
 *   - Dynamic algorithm information popup explaining the model
 */

// ============================================================================
// 1. FIREBASE MODULAR SDK IMPORTS (Browser CDN)
// ============================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  onAuthStateChanged, 
  signOut 
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { 
  getDatabase, 
  ref, 
  onValue,
  set,
  update
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ============================================================================
// 2. CONFIGURATION CONSTANTS
// ============================================================================
const firebaseConfig = {
  apiKey: "AIzaSyBpxI-oAByM9QmnBNOcjP5m0DpF4zj6uZo",
  authDomain: "live-esp32-data.firebaseapp.com",
  databaseURL: "https://live-esp32-data-default-rtdb.firebaseio.com",
  projectId: "live-esp32-data",
  storageBucket: "live-esp32-data.firebasestorage.app",
  messagingSenderId: "409292546534",
  appId: "1:409292546534:web:c7365be20b958b104d7627",
  measurementId: "G-6NQCVRF468"
};

// Target Database Paths
const TELEMETRY_PATH = "devices/door-01/latest";
const CONTROL_PATH   = "devices/door-01/control/sanitizationRequest";

// Model Configuration Parameters (Provisional relative weights & timescales)
const MODEL_CONFIG = {
  scoreIncSingle: 4.0,        // +4 points for confirmed single-zone touch onset (doubled from +2)
  scoreIncDual: 6.0,          // +6 points for confirmed dual-zone touch onset (doubled from +3)
  scoreIncHold: 2.0,          // +2 points for each completed continuous hold interval
  holdIntervalMs: 5000,       // 5000 ms (5 seconds) per hold interval
  holdMaxIntervals: 5,        // Maximum 5 intervals (+10 pts max duration penalty)
  dualZoneWindowMs: 300,      // 300 ms window to group simultaneous/overlapping touches
  baseTauSeconds: 1800,       // 30 minutes base exponential persistence timescale
  sanitizationThreshold: 75.0,// Score threshold for sanitization alert
  // Piecewise relative humidity modifier configuration
  humidityBands: [
    { max: 35, modifier: 0.80, label: "Dry (<35%): Accelerates decay (0.80×)" },
    { max: 65, modifier: 1.00, label: "Comfortable (35–65%): Baseline decay (1.00×)" },
    { max: 80, modifier: 1.20, label: "Humid (65–80%): Slows decay (1.20×)" },
    { max: 100, modifier: 1.35, label: "Very Humid (>80%): Maximum persistence (1.35×)" }
  ],
  humidityFallbackModifier: 1.00,
  // Temperature modifier parameters
  tempBaselineC: 22.0,
  tempCoeff: 0.01,
  tempModifierMin: 0.85,
  tempModifierMax: 1.15,
  // Bounded combined environmental modifier range
  envModifierMin: 0.70,       // Minimum environmental persistence multiplier
  envModifierMax: 1.50        // Maximum environmental persistence multiplier
};

// ============================================================================
// 3. INITIALIZATION & STATE
// ============================================================================
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Active unsubscribe references
let unsubscribeTelemetry = null;
let unsubscribeConnection = null;

// Ticker & timestamps
let lastPacketDate = null;
let tickerIntervalId = null;

// ============================================================================
// 4. DOM ELEMENT REFERENCES
// ============================================================================
const elements = {
  // Navigation / Status
  connectionPill: document.getElementById("connection-status-pill"),
  connectionText: document.getElementById("connection-status-text"),
  userControls: document.getElementById("user-controls"),
  userEmail: document.getElementById("user-display-email"),
  signoutBtn: document.getElementById("signout-button"),

  // Sections
  authSection: document.getElementById("auth-section"),
  dashboardSection: document.getElementById("dashboard-section"),

  // Auth Form
  loginForm: document.getElementById("login-form"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  loginBtn: document.getElementById("login-button"),
  loginBtnText: document.querySelector("#login-button .btn-text"),
  loginBtnSpinner: document.querySelector("#login-button .btn-spinner"),
  loginErrorAlert: document.getElementById("login-error-alert"),
  loginErrorMessage: document.getElementById("login-error-message"),

  // Dashboard Banners
  loadingBanner: document.getElementById("loading-banner"),
  missingDataBanner: document.getElementById("missing-data-banner"),
  permissionErrorBanner: document.getElementById("permission-error-banner"),
  sanitizationAlertBanner: document.getElementById("sanitization-alert-banner"),
  alertScoreNum: document.getElementById("alert-score-num"),
  alertThresholdNum: document.getElementById("alert-threshold-num"),
  alertSanitizeBtn: document.getElementById("alert-sanitize-btn"),

  // Risk Estimator Hero Card
  openSanitizeModalBtn: document.getElementById("open-sanitize-modal-btn"),
  riskScoreValue: document.getElementById("risk-score-value"),
  riskLevelBadge: document.getElementById("risk-level-badge"),
  heroThresholdDisplay: document.getElementById("hero-threshold-display"),
  riskBandDesc: document.getElementById("risk-band-desc"),
  riskProgressFill: document.getElementById("risk-progress-fill"),

  // Score Explanation
  scoreExplanationText: document.getElementById("score-explanation-text"),
  scoreDeltaChip: document.getElementById("score-delta-chip"),

  // Risk Metrics Subcards
  totalTouchesValue: document.getElementById("total-touches-value"),
  singleTouchesValue: document.getElementById("single-touches-value"),
  dualTouchesValue: document.getElementById("dual-touches-value"),
  recentTouchType: document.getElementById("recent-touch-type"),
  recentTouchDuration: document.getElementById("recent-touch-duration"),
  recentTouchTime: document.getElementById("recent-touch-time"),
  activeHoldDuration: document.getElementById("active-hold-duration"),
  activeHoldPoints: document.getElementById("active-hold-points"),
  decayTauValue: document.getElementById("decay-tau-value"),
  humModifierValue: document.getElementById("hum-modifier-value"),
  tempModifierValue: document.getElementById("temp-modifier-value"),
  envModifierValue: document.getElementById("env-modifier-value"),
  sanitizationStatusPill: document.getElementById("sanitization-status-pill"),
  sanitizationStatusText: document.getElementById("sanitization-status-text"),
  lastSanitizedTime: document.getElementById("last-sanitized-time"),
  preSanitizeScore: document.getElementById("pre-sanitize-score"),

  // Chart & Timeline
  riskScoreCanvas: document.getElementById("risk-score-canvas"),
  chartPointsCount: document.getElementById("chart-points-count"),
  chartEmptyState: document.getElementById("chart-empty-state"),
  activityLogBody: document.getElementById("activity-log-body"),

  // Hardware Metric Cards
  cardGpio12: document.getElementById("card-gpio12"),
  cardGpio14: document.getElementById("card-gpio14"),
  tempValue: document.getElementById("temp-value"),
  tempStatus: document.getElementById("temp-status"),
  humidityValue: document.getElementById("humidity-value"),
  humidityStatus: document.getElementById("humidity-status"),
  gpio12RawValue: document.getElementById("gpio12-raw-value"),
  gpio12StatusBadge: document.getElementById("gpio12-status-badge"),
  gpio12StatusText: document.getElementById("gpio12-status-text"),
  gpio14RawValue: document.getElementById("gpio14-raw-value"),
  gpio14StatusBadge: document.getElementById("gpio14-status-badge"),
  gpio14StatusText: document.getElementById("gpio14-status-text"),
  lastUpdatedText: document.getElementById("last-updated-text"),
  timeAgoBadge: document.getElementById("time-ago-badge"),
  syncSourceLabel: document.getElementById("sync-source-label"),
  firebaseConnectionLabel: document.getElementById("firebase-connection-label"),
  firebaseLatencyBadge: document.getElementById("firebase-latency-badge"),

  // Raw Inspector
  rawPayloadDisplay: document.getElementById("raw-payload-display"),

  // Sanitization Confirmation Modal
  sanitizationModal: document.getElementById("sanitization-modal"),
  modalCancelBtn: document.getElementById("modal-cancel-btn"),
  modalConfirmBtn: document.getElementById("modal-confirm-btn"),
  modalConfirmBtnText: document.querySelector("#modal-confirm-btn .btn-text"),
  modalConfirmBtnSpinner: document.querySelector("#modal-confirm-btn .btn-spinner"),

  // Algorithm Information Modal
  algoInfoBtn: document.getElementById("algo-info-btn"),
  algoInfoModal: document.getElementById("algo-info-modal"),
  algoModalCloseBtn: document.getElementById("algo-modal-close-btn"),
  algoModalOkBtn: document.getElementById("algo-modal-ok-btn"),
  infoWindowMs: document.getElementById("info-window-ms"),
  infoWindowMs2: document.getElementById("info-window-ms-2"),
  infoWeightSingle: document.getElementById("info-weight-single"),
  infoWeightDual: document.getElementById("info-weight-dual"),
  infoWeightHold: document.getElementById("info-weight-hold"),
  infoHoldInterval: document.getElementById("info-hold-interval"),
  infoBaseTau: document.getElementById("info-base-tau"),
  infoThreshold: document.getElementById("info-threshold"),
  infoEnvRange: document.getElementById("info-env-range")
};

// ============================================================================
// 5. DETERMINISTIC CONTAMINATION-RISK ESTIMATOR ENGINE
// ============================================================================

class ContaminationRiskEngine {
  constructor() {
    this.score = 0.0;
    this.totalEvents = 0;
    this.singleZoneEvents = 0;
    this.dualZoneEvents = 0;

    // Contact state machine tracking
    this.z1Active = false;
    this.z2Active = false;
    this.z1ActiveStartTime = 0;
    this.z2ActiveStartTime = 0;
    this.lastContactDurationMs = 0;
    this.lastContactTimestamp = null;
    this.lastContactType = "none";

    // 300 ms Dual-Zone Window State
    this.windowPending = false;
    this.windowTimer = null;
    this.windowZ1Triggered = false;
    this.windowZ2Triggered = false;

    // Continuous hold state
    this.isHeld = false;
    this.contactStartTime = 0;
    this.holdIntervalsAwarded = 0;
    this.activeHoldDurationMs = 0;
    this.activeHoldPoints = 0;

    // Timestamps and dynamics explanation
    this.lastDecayTime = Date.now();
    this.lastChangeReason = "Model initialized";
    this.lastChangeDelta = 0.0;
    this.lastSanitizationTimestamp = null;
    this.preSanitizeScore = 0.0;
    this.sanitizationRecommended = false;
    this.alertTriggered = false;

    // History and charting buffers
    this.scoreHistory = [];
    this.activityLog = [];
    this.initialized = false;
  }

  /**
   * Relative humidity modifier piecewise response heuristic:
   *   - < 35% RH: 0.80x (Dry air accelerates desiccation/decay)
   *   - 35% - 65% RH: 1.00x (Comfortable indoor baseline)
   *   - 65% - 80% RH: 1.20x (Humid air slows evaporation/decay)
   *   - > 80% RH: 1.35x (Very humid; maximum persistence)
   *   - Invalid / missing: 1.00x fallback
   */
  computeHumidityModifier(hum) {
    if (hum === undefined || hum === null || isNaN(hum) || hum < 0 || hum > 100) {
      return MODEL_CONFIG.humidityFallbackModifier;
    }
    for (const band of MODEL_CONFIG.humidityBands) {
      if (hum <= band.max) {
        return band.modifier;
      }
    }
    return 1.35;
  }

  /**
   * Ambient temperature persistence modifier centered at 22°C
   * Neutral at 22°C: +0.01 per degree, bounded between [0.85, 1.15]
   */
  computeTempModifier(temp) {
    if (temp === undefined || temp === null || isNaN(temp) || temp < -20 || temp > 70) {
      return 1.00;
    }
    const factor = 1.0 + (temp - MODEL_CONFIG.tempBaselineC) * MODEL_CONFIG.tempCoeff;
    return Math.min(MODEL_CONFIG.tempModifierMax, Math.max(MODEL_CONFIG.tempModifierMin, factor));
  }

  /**
   * Combined environmental persistence timescale modifier
   */
  computeEnvModifier(temp, hum) {
    const humMod = this.computeHumidityModifier(hum);
    const tempMod = this.computeTempModifier(temp);
    const combined = humMod * tempMod;
    const envMod = Math.min(MODEL_CONFIG.envModifierMax, Math.max(MODEL_CONFIG.envModifierMin, combined));
    return { humMod, tempMod, envMod };
  }

  /**
   * Applies elapsed exponential decay
   */
  applyDecay(temp, hum, now) {
    if (this.score <= 0.001) {
      this.score = 0.0;
      this.lastDecayTime = now;
      return;
    }

    const elapsedSeconds = Math.max(0, (now - this.lastDecayTime) / 1000);
    if (elapsedSeconds < 1.0) return;

    this.lastDecayTime = now;
    const { envMod } = this.computeEnvModifier(temp, hum);
    const effectiveTau = MODEL_CONFIG.baseTauSeconds * envMod;

    const previous = this.score;
    this.score = this.score * Math.exp(-elapsedSeconds / effectiveTau);
    if (this.score < 0.05) this.score = 0.0;

    const delta = this.score - previous;
    if (Math.abs(delta) >= 0.1) {
      this.lastChangeDelta = delta;
      this.lastChangeReason = "Risk score decreased through elapsed-time decay.";
    }

    if (this.score < MODEL_CONFIG.sanitizationThreshold) {
      this.sanitizationRecommended = false;
      this.alertTriggered = false;
    }
  }

  /**
   * Evaluates active continuous hold duration and awards discrete hold increments (+2 pts per 5s)
   */
  checkHoldDuration(now) {
    if (!this.isHeld || this.contactStartTime === 0) {
      return false;
    }

    const elapsedMs = Math.max(0, now - this.contactStartTime);
    this.activeHoldDurationMs = elapsedMs;

    const completed = Math.min(
      MODEL_CONFIG.holdMaxIntervals,
      Math.floor(elapsedMs / MODEL_CONFIG.holdIntervalMs)
    );

    if (completed > this.holdIntervalsAwarded) {
      const newIntervals = completed - this.holdIntervalsAwarded;
      const pts = newIntervals * MODEL_CONFIG.scoreIncHold;
      this.holdIntervalsAwarded = completed;
      this.activeHoldPoints += pts;

      const previous = this.score;
      this.score = Math.min(100.0, Math.max(0.0, this.score + pts));
      this.lastChangeDelta = this.score - previous;
      const secondsHeld = completed * (MODEL_CONFIG.holdIntervalMs / 1000);
      this.lastChangeReason = `Continuous contact hold reached ${secondsHeld}s (+${pts.toFixed(1)} pts).`;

      // Check Sanitization Threshold (75)
      if (this.score >= MODEL_CONFIG.sanitizationThreshold) {
        this.sanitizationRecommended = true;
        if (!this.alertTriggered) {
          this.alertTriggered = true;
          this.addActivityItem({
            time: new Date(now).toLocaleTimeString(),
            event: "Threshold Alert",
            delta: `Score ${this.score.toFixed(1)}`,
            score: this.score,
            type: "event-alert"
          });
        }
      }

      // Add activity entry
      this.addActivityItem({
        time: new Date(now).toLocaleTimeString(),
        event: `Hold (${secondsHeld}s)`,
        delta: `+${pts.toFixed(1)}`,
        score: this.score,
        type: "event-touch-hold"
      });

      this.addScoreHistoryPoint(now, this.score);
      return true;
    }

    return false;
  }

  /**
   * Live ticker update: keeps decay and hold timer progressing smoothly
   */
  tick(now, temp, hum) {
    this.applyDecay(temp, hum, now);
    if (this.isHeld) {
      this.checkHoldDuration(now);
    }
  }

  /**
   * Processes live logical touched states from the sensor telemetry
   */
  processTouchStates(isZ1Touched, isZ2Touched, temp, hum, now) {
    const z1Now = Boolean(isZ1Touched);
    const z2Now = Boolean(isZ2Touched);

    // Apply any pending elapsed decay before scoring new contacts
    this.applyDecay(temp, hum, now);

    // Detect transitions from untouched to touched
    const z1NewContact = z1Now && !this.z1Active;
    const z2NewContact = z2Now && !this.z2Active;

    // Handle initial state on first telemetry packet (e.g. if page loads while touched)
    if (!this.initialized) {
      this.initialized = true;
      if (z1Now && z2Now) {
        this.z1Active = true;
        this.z2Active = true;
        this.z1ActiveStartTime = now;
        this.z2ActiveStartTime = now;
        this.isHeld = true;
        this.contactStartTime = now;
        this.holdIntervalsAwarded = 0;
        this.activeHoldPoints = 0;
        this.recordContactEvent("dual", now, "Confirmed dual-zone contact: +6 points.");
        return;
      } else if (z1Now) {
        this.z1Active = true;
        this.z1ActiveStartTime = now;
        this.isHeld = true;
        this.contactStartTime = now;
        this.holdIntervalsAwarded = 0;
        this.activeHoldPoints = 0;
        this.recordContactEvent("single_12", now, "Confirmed single-zone GPIO12 contact: +4 points.");
        return;
      } else if (z2Now) {
        this.z2Active = true;
        this.z2ActiveStartTime = now;
        this.isHeld = true;
        this.contactStartTime = now;
        this.holdIntervalsAwarded = 0;
        this.activeHoldPoints = 0;
        this.recordContactEvent("single_14", now, "Confirmed single-zone GPIO14 contact: +4 points.");
        return;
      }
    }

    // Update active timers on new contact
    if (z1NewContact) {
      this.z1Active = true;
      this.z1ActiveStartTime = now;
      if (!this.isHeld) {
        this.contactStartTime = now;
        this.holdIntervalsAwarded = 0;
        this.activeHoldPoints = 0;
      }
    }
    if (z2NewContact) {
      this.z2Active = true;
      this.z2ActiveStartTime = now;
      if (!this.isHeld) {
        this.contactStartTime = now;
        this.holdIntervalsAwarded = 0;
        this.activeHoldPoints = 0;
      }
    }

    // Release Detection: When contact ends, calculate duration
    if (!z1Now && this.z1Active) {
      this.z1Active = false;
      if (now > this.z1ActiveStartTime) {
        this.lastContactDurationMs = now - this.z1ActiveStartTime;
      }
    }
    if (!z2Now && this.z2Active) {
      this.z2Active = false;
      if (now > this.z2ActiveStartTime) {
        this.lastContactDurationMs = now - this.z2ActiveStartTime;
      }
    }

    // Complete release: when all zones released
    if (!z1Now && !z2Now) {
      if (this.isHeld) {
        this.isHeld = false;
        if (this.contactStartTime > 0) {
          this.lastContactDurationMs = Math.max(0, now - this.contactStartTime);
        }
        this.contactStartTime = 0;
        this.holdIntervalsAwarded = 0;
        this.activeHoldDurationMs = 0;
        this.activeHoldPoints = 0;
      }
    } else {
      // At least one zone is still held
      this.isHeld = true;
      this.checkHoldDuration(now);
    }

    // ------------------------------------------------------------------------
    // Dual-Zone Classification Logic with 300 ms Window
    // ------------------------------------------------------------------------
    if (z1NewContact && z2NewContact) {
      // Both activated simultaneously
      if (this.windowTimer) {
        clearTimeout(this.windowTimer);
        this.windowTimer = null;
      }
      this.windowPending = false;
      this.isHeld = true;
      this.recordContactEvent("dual", now, "Confirmed dual-zone contact: +6 points.");
    } else if (z1NewContact || z2NewContact) {
      // One zone activated
      if (!this.windowPending) {
        this.windowPending = true;
        this.windowZ1Triggered = z1NewContact;
        this.windowZ2Triggered = z2NewContact;

        // Start 300 ms window to wait for potential second zone
        this.windowTimer = setTimeout(() => {
          this.resolvePendingWindow();
        }, MODEL_CONFIG.dualZoneWindowMs);
      } else {
        // Second zone activated within existing window!
        if (z1NewContact) this.windowZ1Triggered = true;
        if (z2NewContact) this.windowZ2Triggered = true;

        if (this.windowZ1Triggered && this.windowZ2Triggered) {
          if (this.windowTimer) {
            clearTimeout(this.windowTimer);
            this.windowTimer = null;
          }
          this.windowPending = false;
          this.isHeld = true;
          this.recordContactEvent("dual", Date.now(), "Confirmed dual-zone contact: +6 points.");
        }
      }
    }
  }

  /**
   * Finalizes single-zone contact if 300ms window expires without second zone
   */
  resolvePendingWindow() {
    this.windowPending = false;
    this.windowTimer = null;
    const now = Date.now();

    if (this.windowZ1Triggered && !this.windowZ2Triggered) {
      this.isHeld = true;
      this.recordContactEvent("single_12", now, "Confirmed single-zone GPIO12 contact: +4 points.");
    } else if (this.windowZ2Triggered && !this.windowZ1Triggered) {
      this.isHeld = true;
      this.recordContactEvent("single_14", now, "Confirmed single-zone GPIO14 contact: +4 points.");
    }

    this.windowZ1Triggered = false;
    this.windowZ2Triggered = false;
    updateDashboardUI();
  }

  /**
   * Records a confirmed contact event and updates risk score
   */
  recordContactEvent(type, now, reasonText) {
    this.totalEvents++;
    this.lastContactTimestamp = now;

    let pts = 0;
    let eventName = "";
    let eventChipClass = "";

    if (type === "dual") {
      this.dualZoneEvents++;
      pts = MODEL_CONFIG.scoreIncDual;
      eventName = "Dual-Zone Touch";
      eventChipClass = "event-touch-dual";
      this.lastContactType = "Dual-Zone (GPIO12 + 14)";
    } else if (type === "single_12") {
      this.singleZoneEvents++;
      pts = MODEL_CONFIG.scoreIncSingle;
      eventName = "Single-Zone GPIO12";
      eventChipClass = "event-touch-single";
      this.lastContactType = "Single-Zone (GPIO12)";
    } else {
      this.singleZoneEvents++;
      pts = MODEL_CONFIG.scoreIncSingle;
      eventName = "Single-Zone GPIO14";
      eventChipClass = "event-touch-single";
      this.lastContactType = "Single-Zone (GPIO14)";
    }

    const previous = this.score;
    this.score = Math.min(100.0, Math.max(0.0, this.score + pts));
    this.lastChangeDelta = this.score - previous;
    this.lastChangeReason = reasonText;

    // Check Sanitization Threshold (75)
    if (this.score >= MODEL_CONFIG.sanitizationThreshold) {
      this.sanitizationRecommended = true;
      if (!this.alertTriggered) {
        this.alertTriggered = true;
        this.addActivityItem({
          time: new Date(now).toLocaleTimeString(),
          event: "Threshold Alert",
          delta: `Score ${this.score.toFixed(1)}`,
          score: this.score,
          type: "event-alert"
        });
      }
    }

    // Add activity record
    this.addActivityItem({
      time: new Date(now).toLocaleTimeString(),
      event: eventName,
      delta: `+${pts.toFixed(1)}`,
      score: this.score,
      type: eventChipClass
    });

    // Buffer score for chart
    this.addScoreHistoryPoint(now, this.score);
  }

  /**
   * Resets model upon confirmed sanitization action
   */
  recordSanitization(operatorEmail, now) {
    this.preSanitizeScore = this.score;
    this.lastChangeDelta = -this.score;
    this.score = 0.0;
    this.sanitizationRecommended = false;
    this.alertTriggered = false;
    this.lastSanitizationTimestamp = now;
    this.lastChangeReason = `Sanitization recorded by ${operatorEmail}; modeled score reset.`;
    this.lastDecayTime = now;

    this.addActivityItem({
      time: new Date(now).toLocaleTimeString(),
      event: "Sanitization Reset",
      delta: `-${this.preSanitizeScore.toFixed(1)}`,
      score: 0.0,
      type: "event-sanitized"
    });

    this.addScoreHistoryPoint(now, 0.0);
  }

  addActivityItem(item) {
    this.activityLog.unshift(item);
    if (this.activityLog.length > 25) this.activityLog.pop();
  }

  addScoreHistoryPoint(timestamp, val) {
    this.scoreHistory.push({ timestamp, score: val });
    if (this.scoreHistory.length > 60) this.scoreHistory.shift();
  }

  getRiskLevel() {
    if (this.score < 25.0) return "Low";
    if (this.score < 50.0) return "Elevated";
    if (this.score < 75.0) return "High";
    return "Critical";
  }
}

// Global Risk Engine Instance
const riskEngine = new ContaminationRiskEngine();

// ============================================================================
// 6. AUTHENTICATION & SESSION MANAGEMENT
// ============================================================================

elements.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideLoginError();

  const email = elements.loginEmail.value.trim();
  const password = elements.loginPassword.value;

  if (!email || !password) {
    showLoginError("Please enter both email and password.");
    return;
  }

  setLoginLoading(true);

  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (error) {
    console.error("Sign-in error:", error);
    showLoginError(formatAuthErrorMessage(error));
  } finally {
    setLoginLoading(false);
  }
});

elements.signoutBtn.addEventListener("click", async () => {
  try {
    stopDatabaseSubscriptions();
    await signOut(auth);
  } catch (error) {
    console.error("Sign-out error:", error);
  }
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    elements.userEmail.textContent = user.email || "Authenticated User";
    elements.userControls.classList.remove("hidden");
    elements.authSection.classList.add("hidden");
    elements.dashboardSection.classList.remove("hidden");

    elements.loginPassword.value = "";
    hideLoginError();

    startDatabaseSubscriptions();
    initChartResizeListener();
    initAlgorithmModalHandlers();
  } else {
    stopDatabaseSubscriptions();
    resetDashboardState();

    elements.userControls.classList.add("hidden");
    elements.dashboardSection.classList.add("hidden");
    elements.authSection.classList.remove("hidden");

    updateConnectionStatusUI(false);
  }
});

function formatAuthErrorMessage(error) {
  const code = error.code || "";
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
      return "Incorrect email or password. Please verify your credentials.";
    case "auth/user-not-found":
      return "No account found with this email address.";
    case "auth/invalid-email":
      return "The email address is improperly formatted.";
    case "auth/user-disabled":
      return "This account has been disabled by an administrator.";
    case "auth/too-many-requests":
      return "Access temporarily locked due to failed attempts. Please try again later.";
    case "auth/network-request-failed":
      return "Network issue. Please check your internet connection.";
    default:
      return error.message || "An unexpected authentication error occurred.";
  }
}

function showLoginError(msg) {
  elements.loginErrorMessage.textContent = msg;
  elements.loginErrorAlert.classList.remove("hidden");
}

function hideLoginError() {
  elements.loginErrorAlert.classList.add("hidden");
}

function setLoginLoading(isLoading) {
  elements.loginBtn.disabled = isLoading;
  elements.loginEmail.disabled = isLoading;
  elements.loginPassword.disabled = isLoading;
  if (isLoading) {
    elements.loginBtnText.textContent = "Signing In...";
    elements.loginBtnSpinner.classList.remove("hidden");
  } else {
    elements.loginBtnText.textContent = "Sign In";
    elements.loginBtnSpinner.classList.add("hidden");
  }
}

// ============================================================================
// 7. REALTIME DATABASE SUBSCRIPTION LOGIC
// ============================================================================

function startDatabaseSubscriptions() {
  stopDatabaseSubscriptions();

  elements.loadingBanner.classList.remove("hidden");
  elements.missingDataBanner.classList.add("hidden");
  elements.permissionErrorBanner.classList.add("hidden");

  // 1. Connection state (.info/connected)
  const connectedRef = ref(db, ".info/connected");
  unsubscribeConnection = onValue(
    connectedRef,
    (snap) => {
      const isConnected = snap.val() === true;
      updateConnectionStatusUI(isConnected);
    },
    (err) => {
      console.warn("Connection listener error:", err);
      updateConnectionStatusUI(false);
    }
  );

  // 2. Sensor Telemetry & Risk Model (devices/door-01/latest)
  const telemetryRef = ref(db, TELEMETRY_PATH);
  unsubscribeTelemetry = onValue(
    telemetryRef,
    (snapshot) => {
      elements.loadingBanner.classList.add("hidden");

      if (!snapshot.exists()) {
        elements.missingDataBanner.classList.remove("hidden");
        elements.rawPayloadDisplay.textContent = `// Snapshot received at ${new Date().toLocaleTimeString()}\n// Status: Path "${TELEMETRY_PATH}" is currently null.`;
        resetSensorReadings();
        return;
      }

      const rawData = snapshot.val();
      if (!rawData || typeof rawData !== "object") {
        elements.missingDataBanner.classList.remove("hidden");
        elements.rawPayloadDisplay.textContent = `// Non-object payload received:\n${JSON.stringify(rawData, null, 2)}`;
        resetSensorReadings();
        return;
      }

      elements.missingDataBanner.classList.add("hidden");
      elements.permissionErrorBanner.classList.add("hidden");

      // Ingest telemetry into hardware display and drive the risk model
      renderTelemetryAndModel(rawData);
    },
    (error) => {
      console.error("Database subscription error:", error);
      elements.loadingBanner.classList.add("hidden");

      const isPermissionDenied = 
        error.code === "PERMISSION_DENIED" ||
        (error.message && error.message.toLowerCase().includes("permission_denied")) ||
        (error.message && error.message.toLowerCase().includes("permission denied"));

      if (isPermissionDenied) {
        elements.permissionErrorBanner.classList.remove("hidden");
        elements.rawPayloadDisplay.textContent = `// Error: Permission Denied\n// Path: ${TELEMETRY_PATH}\n// Details: ${error.message}`;
      } else {
        elements.rawPayloadDisplay.textContent = `// Database error: ${error.message}`;
      }
    }
  );

  startRelativeTimeTicker();
}

function stopDatabaseSubscriptions() {
  if (unsubscribeTelemetry) {
    unsubscribeTelemetry();
    unsubscribeTelemetry = null;
  }
  if (unsubscribeConnection) {
    unsubscribeConnection();
    unsubscribeConnection = null;
  }
  if (tickerIntervalId) {
    clearInterval(tickerIntervalId);
    tickerIntervalId = null;
  }
}

// ============================================================================
// 8. TELEMETRY PROCESSING & RISK ESTIMATOR EXECUTION
// ============================================================================

function getFirstDefined(obj, candidateKeys) {
  for (const key of candidateKeys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }
  return undefined;
}

/**
 * Main routine: Reads incoming snapshot, updates hardware cards,
 * and passes confirmed touch states to the risk engine.
 */
function renderTelemetryAndModel(data) {
  // Update raw JSON preview
  elements.rawPayloadDisplay.textContent = JSON.stringify(data, null, 2);

  const now = Date.now();

  // 1. Extract Temperature
  const rawTemp = getFirstDefined(data, ["temperature", "temp", "tempC", "t", "Temperature"]);
  let currentTemp = NaN;
  if (rawTemp !== undefined && !isNaN(Number(rawTemp))) {
    currentTemp = Number(rawTemp);
    elements.tempValue.textContent = currentTemp.toFixed(1);
    elements.tempStatus.textContent = currentTemp > 35 ? "High" : (currentTemp < 18 ? "Cool" : "Normal");
    elements.tempStatus.className = `meta-badge ${currentTemp > 35 ? "badge-warning" : "badge-success"}`;
  } else {
    elements.tempValue.textContent = "--";
    elements.tempStatus.textContent = "No data";
    elements.tempStatus.className = "meta-badge badge-neutral";
  }

  // 2. Extract Humidity
  const rawHumidity = getFirstDefined(data, ["humidity", "rh", "relativeHumidity", "h", "Humidity"]);
  let currentHum = NaN;
  if (rawHumidity !== undefined && !isNaN(Number(rawHumidity))) {
    currentHum = Number(rawHumidity);
    elements.humidityValue.textContent = currentHum.toFixed(1);
    elements.humidityStatus.textContent = (currentHum >= 30 && currentHum <= 65) ? "Comfortable" : (currentHum > 65 ? "Humid" : "Dry");
    elements.humidityStatus.className = `meta-badge ${(currentHum >= 30 && currentHum <= 65) ? "badge-success" : "badge-warning"}`;
  } else {
    elements.humidityValue.textContent = "--";
    elements.humidityStatus.textContent = "No data";
    elements.humidityStatus.className = "meta-badge badge-neutral";
  }

  // 3. Extract GPIO12 Raw Touch
  const raw12 = getFirstDefined(data, [
    "gpio12_raw", "gpio12Raw", "gpio12", "touch12", "touch_12", 
    "touchA", "touch1", "zone1", "rawZone1", "touch_zone_1"
  ]);
  elements.gpio12RawValue.textContent = (raw12 !== undefined && raw12 !== "") ? String(raw12) : "--";

  // 4. Extract GPIO14 Raw Touch
  const raw14 = getFirstDefined(data, [
    "gpio14_raw", "gpio14Raw", "gpio14", "touch14", "touch_14", 
    "touchB", "touch2", "zone2", "rawZone2", "touch_zone_2"
  ]);
  elements.gpio14RawValue.textContent = (raw14 !== undefined && raw14 !== "") ? String(raw14) : "--";

  // 5. Evaluate Logical Touched States
  const status12 = getFirstDefined(data, [
    "zone12_touched", "gpio12_status", "gpio12_touch", "gpio12_touched", "gpio12Touch", "gpio12Active",
    "touch12_active", "touchAActive", "touchedA", "touched1", "zone1_touched", "touch1Active"
  ]);
  const baseline1 = data.touchABaseline || data.baselineZone1;
  const isTouch12Active = evaluateTouchState(status12, raw12, baseline1);
  updateTouchBadge(elements.gpio12StatusBadge, elements.gpio12StatusText, elements.cardGpio12, isTouch12Active);

  const status14 = getFirstDefined(data, [
    "zone14_touched", "gpio14_status", "gpio14_touch", "gpio14_touched", "gpio14Touch", "gpio14Active",
    "touch14_active", "touchBActive", "touchedB", "touched2", "zone2_touched", "touch2Active"
  ]);
  const baseline2 = data.touchBBaseline || data.baselineZone2;
  const isTouch14Active = evaluateTouchState(status14, raw14, baseline2);
  updateTouchBadge(elements.gpio14StatusBadge, elements.gpio14StatusText, elements.cardGpio14, isTouch14Active);

  // 6. Timestamp parsing
  const rawTs = getFirstDefined(data, ["timestamp", "time", "lastUpdated", "updatedAt", "ts", "epoch"]);
  parseAndDisplayTimestamp(rawTs);

  // 7. Check if authoritative score was published by upgraded ESP32 firmware
  const firmwareScore = getFirstDefined(data, ["riskScore", "contaminationRisk", "estimatedRisk"]);
  const firmwareTouchCount = getFirstDefined(data, ["touchCount", "totalTouches"]);

  if (firmwareScore !== undefined && !isNaN(Number(firmwareScore)) && firmwareTouchCount !== undefined) {
    // Upgraded ESP32 firmware is authoritative
    syncFromFirmware(data, Number(firmwareScore));
  } else {
    // Drive the model deterministically using the live logical touch states
    riskEngine.processTouchStates(isTouch12Active, isTouch14Active, currentTemp, currentHum, now);
    updateDashboardUI();
  }
}

function evaluateTouchState(statusField, rawValue, baseline) {
  if (typeof statusField === "boolean") return statusField;
  if (typeof statusField === "string") {
    const s = statusField.trim().toUpperCase();
    if (s === "TOUCHED" || s === "ACTIVE" || s === "TRUE" || s === "1") return true;
    if (s === "NOT TOUCHED" || s === "RELEASED" || s === "INACTIVE" || s === "FALSE" || s === "0") return false;
  }
  if (typeof statusField === "number") {
    return statusField > 0;
  }
  if (rawValue !== undefined && baseline !== undefined && !isNaN(Number(rawValue)) && !isNaN(Number(baseline))) {
    return Number(rawValue) < Number(baseline) * 0.70;
  }
  // Fallback heuristic: standard ESP32 capacitive readings fall < 150 on contact
  if (rawValue !== undefined && !isNaN(Number(rawValue))) {
    return Number(rawValue) < 150;
  }
  return false;
}

function updateTouchBadge(badgeEl, textEl, cardEl, isTouched) {
  if (isTouched === true) {
    badgeEl.className = "touch-state-badge badge-touched";
    textEl.textContent = "TOUCHED";
    cardEl.classList.add("card-touch-active");
  } else if (isTouched === false) {
    badgeEl.className = "touch-state-badge badge-untouched";
    textEl.textContent = "RELEASED";
    cardEl.classList.remove("card-touch-active");
  } else {
    badgeEl.className = "touch-state-badge badge-untouched";
    textEl.textContent = "IDLE";
    cardEl.classList.remove("card-touch-active");
  }
}

/**
 * Synchronizes model state from authoritative ESP32 firmware payload
 */
function syncFromFirmware(data, fwScore) {
  riskEngine.score = Math.min(100.0, Math.max(0.0, fwScore));
  riskEngine.totalEvents = Number(getFirstDefined(data, ["touchCount", "totalTouches"]) || 0);
  riskEngine.singleZoneEvents = Number(getFirstDefined(data, ["singleZoneCount", "singleTouches"]) || 0);
  riskEngine.dualZoneEvents = Number(getFirstDefined(data, ["dualZoneCount", "dualTouches"]) || 0);

  const duration = getFirstDefined(data, ["lastTouchDurationMs", "lastDurationMs"]);
  if (duration !== undefined) riskEngine.lastContactDurationMs = Number(duration);

  const activeHold = getFirstDefined(data, ["activeHoldDurationMs", "activeHoldMs"]);
  if (activeHold !== undefined) riskEngine.activeHoldDurationMs = Number(activeHold);

  const lastEvent = getFirstDefined(data, ["lastTouchEvent"]);
  if (lastEvent) riskEngine.lastContactType = formatTouchTypeName(lastEvent);

  const lastTs = getFirstDefined(data, ["lastTouchTimestamp"]);
  if (lastTs) riskEngine.lastContactTimestamp = lastTs;

  const reason = getFirstDefined(data, ["lastScoreChangeReason"]);
  if (reason) riskEngine.lastChangeReason = reason;

  const delta = getFirstDefined(data, ["lastScoreChangeDelta"]);
  if (delta !== undefined) riskEngine.lastChangeDelta = Number(delta);

  const lastSanitized = getFirstDefined(data, ["lastSanitizationTimestamp"]);
  if (lastSanitized) riskEngine.lastSanitizationTimestamp = lastSanitized;

  const preScore = getFirstDefined(data, ["preSanitizeScore"]);
  if (preScore !== undefined) riskEngine.preSanitizeScore = Number(preScore);

  riskEngine.sanitizationRecommended = Boolean(
    getFirstDefined(data, ["sanitizationRecommended"]) ?? (riskEngine.score >= MODEL_CONFIG.sanitizationThreshold)
  );

  riskEngine.addScoreHistoryPoint(Date.now(), riskEngine.score);
  updateDashboardUI();
}

/**
 * Renders all Contamination Risk components based on riskEngine state
 */
function updateDashboardUI() {
  const score = riskEngine.score;
  const level = riskEngine.getRiskLevel();

  // 1. Score and Bar
  elements.riskScoreValue.textContent = score.toFixed(1);
  elements.heroThresholdDisplay.textContent = MODEL_CONFIG.sanitizationThreshold;
  elements.alertThresholdNum.textContent = MODEL_CONFIG.sanitizationThreshold;

  elements.riskLevelBadge.textContent = level;
  elements.riskLevelBadge.className = `risk-level-pill pill-${level.toLowerCase()}`;
  elements.riskProgressFill.style.width = `${Math.min(100, Math.max(0, score))}%`;

  const bandDescriptions = {
    "Low": "Baseline contact accumulation. Minimal contamination risk.",
    "Elevated": "Moderate touch contact detected. Ongoing time decay in effect.",
    "High": "Frequent contact detected. Approaching sanitization threshold.",
    "Critical": "Sanitization recommended! Surface contact exceeds safe threshold."
  };
  elements.riskBandDesc.textContent = bandDescriptions[level] || `Score at ${score.toFixed(1)} / 100`;

  // 2. Alert Banner
  if (riskEngine.sanitizationRecommended) {
    elements.sanitizationAlertBanner.classList.remove("hidden");
    elements.alertScoreNum.textContent = score.toFixed(1);
  } else {
    elements.sanitizationAlertBanner.classList.add("hidden");
  }

  // 3. Touch Event Counters
  elements.totalTouchesValue.textContent = riskEngine.totalEvents;
  elements.singleTouchesValue.textContent = riskEngine.singleZoneEvents;
  elements.dualTouchesValue.textContent = riskEngine.dualZoneEvents;

  // 4. Recent Contact Telemetry & Active Hold
  elements.recentTouchType.textContent = riskEngine.lastContactType !== "none" ? riskEngine.lastContactType : "No contact yet";
  elements.recentTouchDuration.textContent = riskEngine.lastContactDurationMs > 0 ? `${riskEngine.lastContactDurationMs} ms` : "-- ms";
  elements.recentTouchTime.textContent = riskEngine.lastContactTimestamp ? formatTimeOrRelative(riskEngine.lastContactTimestamp) : "No contact yet";

  if (elements.activeHoldDuration && elements.activeHoldPoints) {
    if (riskEngine.isHeld && riskEngine.activeHoldDurationMs > 0) {
      const sec = Math.floor(riskEngine.activeHoldDurationMs / 1000);
      elements.activeHoldDuration.textContent = `${sec}s`;
      elements.activeHoldPoints.textContent = `(+${riskEngine.activeHoldPoints.toFixed(0)} pts)`;
      elements.activeHoldDuration.style.color = "#fcd34d";
    } else {
      elements.activeHoldDuration.textContent = "0s";
      elements.activeHoldPoints.textContent = "(+0 pts)";
      elements.activeHoldDuration.style.color = "var(--text-dim)";
    }
  }

  // 5. Decay and Environmental Modifiers
  const temp = parseFloat(elements.tempValue.textContent);
  const hum = parseFloat(elements.humidityValue.textContent);
  const { humMod, tempMod, envMod } = riskEngine.computeEnvModifier(temp, hum);
  const effectiveTau = MODEL_CONFIG.baseTauSeconds * envMod;
  elements.decayTauValue.textContent = (effectiveTau / 60).toFixed(0);
  if (elements.humModifierValue) elements.humModifierValue.textContent = `${humMod.toFixed(2)}×`;
  if (elements.tempModifierValue) elements.tempModifierValue.textContent = `${tempMod.toFixed(2)}×`;
  elements.envModifierValue.textContent = `${envMod.toFixed(2)}×`;

  // 6. Sanitization Status
  if (riskEngine.lastSanitizationTimestamp) {
    elements.lastSanitizedTime.textContent = formatTimeOrRelative(riskEngine.lastSanitizationTimestamp);
  } else {
    elements.lastSanitizedTime.textContent = "None recorded";
  }
  elements.preSanitizeScore.textContent = riskEngine.preSanitizeScore > 0 ? riskEngine.preSanitizeScore.toFixed(1) : "--";

  if (riskEngine.sanitizationRecommended) {
    elements.sanitizationStatusPill.className = "touch-state-badge badge-touched";
    elements.sanitizationStatusText.textContent = "Sanitization Due";
  } else if (riskEngine.lastSanitizationTimestamp) {
    elements.sanitizationStatusPill.className = "touch-state-badge badge-untouched";
    elements.sanitizationStatusText.textContent = "Sanitized";
  } else {
    elements.sanitizationStatusPill.className = "touch-state-badge badge-untouched";
    elements.sanitizationStatusText.textContent = "Normal";
  }

  // 7. Score Explanation Box
  elements.scoreExplanationText.textContent = riskEngine.lastChangeReason;
  const delta = riskEngine.lastChangeDelta;
  const sign = delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
  elements.scoreDeltaChip.textContent = sign;
  elements.scoreDeltaChip.className = `delta-chip ${delta > 0 ? "chip-up" : (delta < 0 ? "chip-down" : "chip-neutral")}`;

  // 8. Render Table & Chart
  renderActivityLogTable();
  drawRiskScoreChart();
}

function formatTouchTypeName(rawType) {
  const str = String(rawType).toLowerCase();
  if (str.includes("dual")) return "Dual-Zone (GPIO12 + 14)";
  if (str.includes("12") || str.includes("a") || str.includes("zone1")) return "Single-Zone (GPIO12)";
  if (str.includes("14") || str.includes("b") || str.includes("zone2")) return "Single-Zone (GPIO14)";
  return "Single-Zone Contact";
}

function formatTimeOrRelative(ts) {
  if (!ts) return "--";
  const num = typeof ts === "number" ? ts : Date.parse(ts);
  if (isNaN(num)) return String(ts);
  const date = new Date(num < 10000000000 ? num * 1000 : num);
  return date.toLocaleTimeString();
}

function parseAndDisplayTimestamp(rawTs) {
  let parsedDate = null;
  if (rawTs !== undefined && rawTs !== null) {
    if (typeof rawTs === "number") {
      parsedDate = new Date(rawTs < 10000000000 ? rawTs * 1000 : rawTs);
    } else if (typeof rawTs === "string") {
      const parsed = Date.parse(rawTs);
      if (!isNaN(parsed)) {
        parsedDate = new Date(parsed);
      }
    }
  }

  if (!parsedDate || isNaN(parsedDate.getTime())) {
    parsedDate = new Date();
    elements.syncSourceLabel.textContent = "Client received time";
  } else {
    elements.syncSourceLabel.textContent = "Device timestamp";
  }

  lastPacketDate = parsedDate;
  elements.lastUpdatedText.textContent = `${parsedDate.toLocaleDateString()} ${parsedDate.toLocaleTimeString()}`;
  updateTimeAgo();
}

function updateTimeAgo() {
  if (!lastPacketDate) {
    elements.timeAgoBadge.textContent = "Awaiting data";
    elements.timeAgoBadge.className = "meta-badge badge-neutral";
    return;
  }

  const now = Date.now();
  const elapsedSec = Math.max(0, Math.round((now - lastPacketDate.getTime()) / 1000));

  let label = "";
  let badgeClass = "meta-badge badge-success";

  if (elapsedSec < 3) {
    label = "Just now";
  } else if (elapsedSec < 60) {
    label = `${elapsedSec}s ago`;
  } else if (elapsedSec < 3600) {
    const mins = Math.floor(elapsedSec / 60);
    label = `${mins}m ago`;
    if (mins >= 2) badgeClass = "meta-badge badge-warning";
  } else {
    const hrs = Math.floor(elapsedSec / 3600);
    label = `${hrs}h ago`;
    badgeClass = "meta-badge badge-warning";
  }

  elements.timeAgoBadge.textContent = label;
  elements.timeAgoBadge.className = badgeClass;
}

function startRelativeTimeTicker() {
  if (tickerIntervalId) clearInterval(tickerIntervalId);
  tickerIntervalId = setInterval(() => {
    updateTimeAgo();
    const temp = parseFloat(elements.tempValue.textContent);
    const hum = parseFloat(elements.humidityValue.textContent);
    riskEngine.tick(Date.now(), temp, hum);
    updateDashboardUI();
  }, 1000);
}

// ============================================================================
// 9. ACTIVITY LOG & REALTIME CHART
// ============================================================================

function renderActivityLogTable() {
  if (!elements.activityLogBody) return;
  if (riskEngine.activityLog.length === 0) {
    elements.activityLogBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="4">No activity recorded yet</td>
      </tr>
    `;
    return;
  }

  elements.activityLogBody.innerHTML = riskEngine.activityLog.map(evt => `
    <tr>
      <td><code>${evt.time}</code></td>
      <td><span class="event-chip ${evt.type}">${evt.event}</span></td>
      <td><strong>${evt.delta}</strong></td>
      <td><code>${evt.score.toFixed(1)}</code></td>
    </tr>
  `).join("");
}

function drawRiskScoreChart() {
  const canvas = elements.riskScoreCanvas;
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) return;

  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = rect.height;
  const padLeft = 40;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 30;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  ctx.clearRect(0, 0, w, h);

  const history = riskEngine.scoreHistory;
  if (history.length < 1) {
    elements.chartEmptyState.classList.remove("hidden");
    elements.chartPointsCount.textContent = "0 points";
    return;
  }

  elements.chartEmptyState.classList.add("hidden");
  elements.chartPointsCount.textContent = `${history.length} readings`;

  // Draw Grid Lines (0, 25, 50, 75, 100)
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#64748b";
  ctx.font = "10px JetBrains Mono, monospace";

  [0, 25, 50, 75, 100].forEach(val => {
    const y = padTop + plotH - (val / 100) * plotH;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();

    ctx.fillText(String(val), 12, y + 3);
  });

  // Draw Threshold Line (75)
  const threshY = padTop + plotH - (MODEL_CONFIG.sanitizationThreshold / 100) * plotH;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#f43f5e";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padLeft, threshY);
  ctx.lineTo(padLeft + plotW, threshY);
  ctx.stroke();
  ctx.fillStyle = "#f43f5e";
  ctx.fillText("Threshold (75)", padLeft + plotW - 90, threshY - 6);
  ctx.restore();

  // Plot Risk Score Points
  const n = history.length;
  const points = history.map((item, idx) => {
    const x = n === 1 ? padLeft + plotW / 2 : padLeft + (idx / (n - 1)) * plotW;
    const y = padTop + plotH - (Math.min(100, Math.max(0, item.score)) / 100) * plotH;
    return { x, y, score: item.score };
  });

  // Fill Gradient Area
  const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
  grad.addColorStop(0, "rgba(244, 63, 94, 0.35)");
  grad.addColorStop(0.5, "rgba(59, 130, 246, 0.2)");
  grad.addColorStop(1, "rgba(16, 185, 129, 0.02)");

  ctx.beginPath();
  ctx.moveTo(points[0].x, padTop + plotH);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, padTop + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw Trend Polyline
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Draw Glow Dot on Latest Point
  const lastPoint = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(lastPoint.x, lastPoint.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = lastPoint.score >= 75 ? "#f43f5e" : "#38bdf8";
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function initChartResizeListener() {
  window.addEventListener("resize", () => {
    drawRiskScoreChart();
  });
}

// ============================================================================
// 10. SANITIZATION ACTION & MODAL LOGIC
// ============================================================================

elements.openSanitizeModalBtn?.addEventListener("click", () => {
  openSanitizeModal();
});

elements.alertSanitizeBtn?.addEventListener("click", () => {
  openSanitizeModal();
});

elements.modalCancelBtn?.addEventListener("click", () => {
  closeSanitizeModal();
});

function openSanitizeModal() {
  elements.sanitizationModal.classList.remove("hidden");
}

function closeSanitizeModal() {
  elements.sanitizationModal.classList.add("hidden");
  setSanitizeLoading(false);
}

function setSanitizeLoading(isLoading) {
  elements.modalConfirmBtn.disabled = isLoading;
  elements.modalCancelBtn.disabled = isLoading;
  if (isLoading) {
    elements.modalConfirmBtnText.textContent = "Recording...";
    elements.modalConfirmBtnSpinner.classList.remove("hidden");
  } else {
    elements.modalConfirmBtnText.textContent = "Confirm & Reset Score";
    elements.modalConfirmBtnSpinner.classList.add("hidden");
  }
}

/**
 * Executes the authoritative sanitization action
 */
elements.modalConfirmBtn?.addEventListener("click", async () => {
  setSanitizeLoading(true);

  const now = Date.now();
  const requestId = "san_" + now;
  const operatorEmail = auth.currentUser?.email || "authenticated_operator";

  try {
    // 1. Post command to devices/door-01/control/sanitizationRequest for ESP32
    const controlRef = ref(db, CONTROL_PATH);
    await set(controlRef, {
      requested: true,
      requestId: requestId,
      requestedAt: now,
      requestedBy: operatorEmail,
      status: "pending",
      preSanitizeScore: riskEngine.score
    });

    // 2. Apply reset in authoritative risk engine
    riskEngine.recordSanitization(operatorEmail, now);

    // 3. Update devices/door-01/latest in Firebase
    const telemetryRef = ref(db, TELEMETRY_PATH);
    await update(telemetryRef, {
      riskScore: 0.0,
      riskLevel: "Low",
      sanitizationRecommended: false,
      lastSanitizationTimestamp: now,
      lastScoreChangeReason: `Sanitization recorded by ${operatorEmail}; modeled score reset.`,
      lastScoreChangeDelta: -riskEngine.preSanitizeScore,
      preSanitizeScore: riskEngine.preSanitizeScore
    });

    closeSanitizeModal();
    updateDashboardUI();
  } catch (error) {
    console.error("Sanitization request failed:", error);
    alert(`Could not record sanitization: ${error.message}`);
    setSanitizeLoading(false);
  }
});

// ============================================================================
// 11. ALGORITHM INFORMATION POPUP (MODAL) LOGIC
// ============================================================================

function initAlgorithmModalHandlers() {
  if (!elements.algoInfoBtn) return;

  // Render model configuration values dynamically into the popup
  if (elements.infoWindowMs) elements.infoWindowMs.textContent = MODEL_CONFIG.dualZoneWindowMs;
  if (elements.infoWindowMs2) elements.infoWindowMs2.textContent = MODEL_CONFIG.dualZoneWindowMs;
  if (elements.infoWeightSingle) elements.infoWeightSingle.textContent = MODEL_CONFIG.scoreIncSingle;
  if (elements.infoWeightDual) elements.infoWeightDual.textContent = MODEL_CONFIG.scoreIncDual;
  if (elements.infoWeightHold) elements.infoWeightHold.textContent = MODEL_CONFIG.scoreIncHold;
  if (elements.infoHoldInterval) elements.infoHoldInterval.textContent = (MODEL_CONFIG.holdIntervalMs / 1000).toFixed(0);
  if (elements.infoBaseTau) elements.infoBaseTau.textContent = (MODEL_CONFIG.baseTauSeconds / 60).toFixed(0);
  if (elements.infoThreshold) elements.infoThreshold.textContent = MODEL_CONFIG.sanitizationThreshold;
  if (elements.infoEnvRange) {
    elements.infoEnvRange.textContent = `${MODEL_CONFIG.envModifierMin.toFixed(2)}× to ${MODEL_CONFIG.envModifierMax.toFixed(2)}×`;
  }

  // Open modal on info icon click
  elements.algoInfoBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openAlgoInfoModal();
  });

  // Close handlers
  elements.algoModalCloseBtn?.addEventListener("click", () => {
    closeAlgoInfoModal();
  });

  elements.algoModalOkBtn?.addEventListener("click", () => {
    closeAlgoInfoModal();
  });

  // Close on backdrop click (outside the modal card)
  elements.algoInfoModal?.addEventListener("click", (e) => {
    if (e.target === elements.algoInfoModal) {
      closeAlgoInfoModal();
    }
  });

  // Keyboard accessibility: Escape key closes both modals
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!elements.algoInfoModal.classList.contains("hidden")) {
        closeAlgoInfoModal();
      }
      if (!elements.sanitizationModal.classList.contains("hidden")) {
        closeSanitizeModal();
      }
    }
  });
}

function openAlgoInfoModal() {
  elements.algoInfoModal.classList.remove("hidden");
  // Set focus for accessibility
  elements.algoModalOkBtn?.focus();
}

function closeAlgoInfoModal() {
  elements.algoInfoModal.classList.add("hidden");
  elements.algoInfoBtn?.focus();
}

// ============================================================================
// 12. CONNECTION & UI STATE HELPERS
// ============================================================================

function updateConnectionStatusUI(isConnected) {
  if (isConnected) {
    elements.connectionPill.className = "status-pill status-connected";
    elements.connectionText.textContent = "Connected";
    elements.firebaseConnectionLabel.textContent = "Connected";
    elements.firebaseConnectionLabel.style.color = "var(--color-success)";
    elements.firebaseLatencyBadge.textContent = "Live Stream";
    elements.firebaseLatencyBadge.className = "meta-badge badge-success";
  } else {
    elements.connectionPill.className = "status-pill status-disconnected";
    elements.connectionText.textContent = "Disconnected";
    elements.firebaseConnectionLabel.textContent = "Disconnected";
    elements.firebaseConnectionLabel.style.color = "var(--color-error)";
    elements.firebaseLatencyBadge.textContent = "Offline";
    elements.firebaseLatencyBadge.className = "meta-badge badge-warning";
  }
}

function resetSensorReadings() {
  elements.tempValue.textContent = "--";
  elements.tempStatus.textContent = "No data";
  elements.tempStatus.className = "meta-badge badge-neutral";

  elements.humidityValue.textContent = "--";
  elements.humidityStatus.textContent = "No data";
  elements.humidityStatus.className = "meta-badge badge-neutral";

  elements.gpio12RawValue.textContent = "--";
  elements.gpio12StatusBadge.className = "touch-state-badge badge-untouched";
  elements.gpio12StatusText.textContent = "--";
  elements.cardGpio12.classList.remove("card-touch-active");

  elements.gpio14RawValue.textContent = "--";
  elements.gpio14StatusBadge.className = "touch-state-badge badge-untouched";
  elements.gpio14StatusText.textContent = "--";
  elements.cardGpio14.classList.remove("card-touch-active");

  elements.lastUpdatedText.textContent = "--";
  elements.timeAgoBadge.textContent = "No data";
  elements.timeAgoBadge.className = "meta-badge badge-neutral";
  lastPacketDate = null;

  elements.riskScoreValue.textContent = "--";
  elements.riskProgressFill.style.width = "0%";
}

function resetDashboardState() {
  resetSensorReadings();
  elements.loadingBanner.classList.remove("hidden");
  elements.missingDataBanner.classList.add("hidden");
  elements.permissionErrorBanner.classList.add("hidden");
  elements.sanitizationAlertBanner.classList.add("hidden");
  elements.rawPayloadDisplay.textContent = "// Waiting for incoming Firebase snapshot...";
  riskEngine.scoreHistory = [];
  riskEngine.activityLog = [];
  drawRiskScoreChart();
}
