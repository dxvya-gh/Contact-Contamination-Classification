/**
 * ============================================================================
 * SmartLogix ESP32 IoT Firmware & Contamination-Risk Estimator
 * ============================================================================
 * 
 * Hardware:
 *   - ESP32 / ESP32-CAM module
 *   - Adafruit SHT31 Temperature & Humidity Sensor (I2C: SDA=13, SCL=15)
 *   - Two Capacitive Touch Zones:
 *       Zone 1: GPIO12
 *       Zone 2: GPIO14
 * 
 * Features:
 *   - Calibrated capacitive touch sensing with debounce filtering
 *   - Dual-zone event classification (300ms window) without double-counting
 *   - Real-time Contamination-Risk Estimator (Single +2, Dual +3, clamped [0, 100])
 *   - Continuous time decay using monotonic elapsed time (exp(-dt / tau))
 *   - Environmental modifier via SHT31 temperature and humidity
 *   - Threshold alerts (sanitization recommendation at >= 75)
 *   - Bidirectional sanitization request & acknowledgment with Firebase
 *   - Boot state recovery from Firebase Realtime Database
 *   - Non-destructive compatibility with existing dashboard fields
 * ============================================================================
 */

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <time.h>
#include <math.h>

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================

// --- Wi-Fi Credentials ---
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// --- Firebase Realtime Database Config ---
const char* FIREBASE_HOST = "live-esp32-data-default-rtdb.firebaseio.com";
const char* DEVICE_PATH   = "devices/door-01";
// Optional: Database Auth token / secret if required by database rules
const char* FIREBASE_AUTH = ""; 

// --- Hardware Pins ---
#define SDA_PIN 13
#define SCL_PIN 15
#define TOUCH_ZONE_1 12
#define TOUCH_ZONE_2 14

// --- Model Parameters ---
const float TOUCH_THRESHOLD_PERCENT     = 0.70f;  // 30% drop threshold below baseline
const unsigned long DUAL_ZONE_WINDOW_MS = 300;    // 300 ms window to detect dual-zone contact
const float SCORE_INC_SINGLE            = 2.0f;   // +2 points for single-zone contact
const float SCORE_INC_DUAL              = 3.0f;   // +3 points for dual-zone contact
const float BASE_TAU_SECONDS            = 1800.0f;// Base persistence timescale (30 minutes)
const float SANITIZATION_THRESHOLD      = 75.0f;  // Score threshold for sanitization alert

// --- Timing Intervals ---
const unsigned long TOUCH_SAMPLE_INTERVAL_MS = 100;   // Touch sampling rate (100 ms)
const unsigned long ENV_SAMPLE_INTERVAL_MS   = 2000;  // SHT31 sampling rate (2 s)
const unsigned long TELEMETRY_PUSH_INTERVAL  = 3000;  // Push live telemetry to Firebase (3 s)
const unsigned long CONTROL_CHECK_INTERVAL   = 4000;  // Poll sanitization control request (4 s)

// ============================================================================
// 2. HARDWARE OBJECTS & SENSOR STATE
// ============================================================================
Adafruit_SHT31 sht31 = Adafruit_SHT31();

// Baselines & Raw Readings
int baselineZone1 = 0;
int baselineZone2 = 0;
int currentTouch1 = 0;
int currentTouch2 = 0;
bool zone1Touched = false;
bool zone2Touched = false;

// Environmental Data
float currentTemperature = NAN;
float currentHumidity    = NAN;

// ============================================================================
// 3. MODULAR CONTAMINATION-RISK ESTIMATOR CLASS
// ============================================================================
class ContaminationRiskEstimator {
private:
  float riskScore;
  int touchCount;
  int singleZoneCount;
  int dualZoneCount;
  bool sanitizationRecommended;

  // Touch state machine for Zone 1 & Zone 2
  int z1ConsecutiveLow;
  int z2ConsecutiveLow;
  bool z1ConfirmedActive;
  bool z2ConfirmedActive;
  unsigned long z1StartTime;
  unsigned long z2StartTime;

  // Event resolution pending window
  bool pendingWindowActive;
  unsigned long windowStartTime;
  bool z1TriggeredInWindow;
  bool z2TriggeredInWindow;

  // Contact duration tracking
  unsigned long lastContactDurationMs;
  unsigned long lastTouchTimestamp;
  String lastTouchEvent;

  // Score dynamics explanation
  String lastScoreChangeReason;
  float lastScoreChangeDelta;
  unsigned long lastSanitizationTimestamp;
  float preSanitizeScore;

  // Monotonic decay timer
  unsigned long lastDecayMillis;

public:
  ContaminationRiskEstimator() {
    riskScore = 0.0f;
    touchCount = 0;
    singleZoneCount = 0;
    dualZoneCount = 0;
    sanitizationRecommended = false;

    z1ConsecutiveLow = 0;
    z2ConsecutiveLow = 0;
    z1ConfirmedActive = false;
    z2ConfirmedActive = false;
    z1StartTime = 0;
    z2StartTime = 0;

    pendingWindowActive = false;
    windowStartTime = 0;
    z1TriggeredInWindow = false;
    z2TriggeredInWindow = false;

    lastContactDurationMs = 0;
    lastTouchTimestamp = 0;
    lastTouchEvent = "none";

    lastScoreChangeReason = "Model initialized";
    lastScoreChangeDelta = 0.0f;
    lastSanitizationTimestamp = 0;
    preSanitizeScore = 0.0f;

    lastDecayMillis = millis();
  }

  /**
   * Process raw sensor readings every 100ms
   */
  void processTouchSamples(int raw1, int raw2, int thresh1, int thresh2) {
    unsigned long now = millis();

    // 1. Debounce Confirmation (2 consecutive samples below threshold = confirmed active)
    bool rawLow1 = (raw1 < thresh1);
    bool rawLow2 = (raw2 < thresh2);

    if (rawLow1) z1ConsecutiveLow++; else z1ConsecutiveLow = 0;
    if (rawLow2) z2ConsecutiveLow++; else z2ConsecutiveLow = 0;

    bool z1NewActive = (z1ConsecutiveLow >= 2 && !z1ConfirmedActive);
    bool z2NewActive = (z2ConsecutiveLow >= 2 && !z2ConfirmedActive);

    // Track active state (prevents repeated firing on a continuous hold)
    if (z1ConsecutiveLow >= 2) {
      if (!z1ConfirmedActive) {
        z1ConfirmedActive = true;
        z1StartTime = now;
      }
    } else if (z1ConsecutiveLow == 0 && z1ConfirmedActive) {
      z1ConfirmedActive = false;
      if (now > z1StartTime) lastContactDurationMs = now - z1StartTime;
    }

    if (z2ConsecutiveLow >= 2) {
      if (!z2ConfirmedActive) {
        z2ConfirmedActive = true;
        z2StartTime = now;
      }
    } else if (z2ConsecutiveLow == 0 && z2ConfirmedActive) {
      z2ConfirmedActive = false;
      if (now > z2StartTime) lastContactDurationMs = now - z2StartTime;
    }

    // 2. Dual-Zone Classification Window Logic
    // If a new touch occurs and no window is open, open a 300ms window
    if ((z1NewActive || z2NewActive) && !pendingWindowActive) {
      pendingWindowActive = true;
      windowStartTime = now;
      z1TriggeredInWindow = z1NewActive;
      z2TriggeredInWindow = z2NewActive;
    } else if (pendingWindowActive) {
      // Accumulate any other zone that triggers within the window
      if (z1NewActive) z1TriggeredInWindow = true;
      if (z2NewActive) z2TriggeredInWindow = true;
    }

    // 3. Resolve Event once the 300ms window elapses
    if (pendingWindowActive && (now - windowStartTime >= DUAL_ZONE_WINDOW_MS)) {
      pendingWindowActive = false;

      if (z1TriggeredInWindow && z2TriggeredInWindow) {
        // Dual-zone event
        touchCount++;
        dualZoneCount++;
        applyScoreIncrement(SCORE_INC_DUAL, "Confirmed dual-zone contact (+3 pts)");
        lastTouchEvent = "dual_zone";
        lastTouchTimestamp = getEpochOrMillis();
        Serial.println("[MODEL] >> EVENT: Dual-Zone Contact (+3.0 pts)");
      } else if (z1TriggeredInWindow) {
        // Single-zone GPIO12 event
        touchCount++;
        singleZoneCount++;
        applyScoreIncrement(SCORE_INC_SINGLE, "Confirmed single-zone GPIO12 contact (+2 pts)");
        lastTouchEvent = "single_zone_12";
        lastTouchTimestamp = getEpochOrMillis();
        Serial.println("[MODEL] >> EVENT: Single-Zone GPIO12 Contact (+2.0 pts)");
      } else if (z2TriggeredInWindow) {
        // Single-zone GPIO14 event
        touchCount++;
        singleZoneCount++;
        applyScoreIncrement(SCORE_INC_SINGLE, "Confirmed single-zone GPIO14 contact (+2 pts)");
        lastTouchEvent = "single_zone_14";
        lastTouchTimestamp = getEpochOrMillis();
        Serial.println("[MODEL] >> EVENT: Single-Zone GPIO14 Contact (+2.0 pts)");
      }

      z1TriggeredInWindow = false;
      z2TriggeredInWindow = false;
    }
  }

  /**
   * Applies elapsed exponential decay modulated by SHT31 environment
   */
  void updateDecay(float temp, float hum) {
    unsigned long now = millis();
    float dtSeconds = (now - lastDecayMillis) / 1000.0f;

    // Apply decay every ~5 seconds to prevent floating point underflow
    if (dtSeconds >= 5.0f && riskScore > 0.01f) {
      lastDecayMillis = now;
      float envModifier = computeEnvModifier(temp, hum);
      float effectiveTau = BASE_TAU_SECONDS / envModifier;

      float oldScore = riskScore;
      riskScore = riskScore * exp(-dtSeconds / effectiveTau);
      if (riskScore < 0.05f) riskScore = 0.0f; // clean floor

      float delta = riskScore - oldScore;
      if (fabs(delta) >= 0.1f) {
        lastScoreChangeDelta = delta;
        lastScoreChangeReason = "Exponential time decay";
      }

      // Check if decay lowered score below threshold
      if (riskScore < SANITIZATION_THRESHOLD) {
        sanitizationRecommended = false;
      }
    } else if (riskScore <= 0.01f) {
      lastDecayMillis = now;
    }
  }

  /**
   * Environmental persistence modifier heuristic
   */
  float computeEnvModifier(float temp, float hum) {
    if (isnan(temp) || isnan(hum) || temp < -20.0f || temp > 70.0f || hum < 0.0f || hum > 100.0f) {
      return 1.0f; // fallback to default
    }
    // Proportional heuristic: slight modulation based on ambient warmth & humidity
    float factor = 1.0f + (temp - 22.0f) * 0.01f + (hum - 50.0f) * 0.005f;
    return constrain(factor, 0.70f, 1.40f);
  }

  /**
   * Reset risk score upon authoritative sanitization action
   */
  void markSanitized(unsigned long timestamp) {
    preSanitizeScore = riskScore;
    lastScoreChangeDelta = -riskScore;
    riskScore = 0.0f;
    sanitizationRecommended = false;
    lastSanitizationTimestamp = (timestamp > 0) ? timestamp : getEpochOrMillis();
    lastScoreChangeReason = "Sanitization recorded by operator";
    lastDecayMillis = millis();
    Serial.println("[MODEL] >> Authoritative Reset: Surface Marked as Sanitized (Score: 0.0)");
  }

  /**
   * Restore state from Firebase on reboot
   */
  void restoreState(float score, int total, int single, int dual, unsigned long lastSanitized) {
    riskScore = constrain(score, 0.0f, 100.0f);
    touchCount = total;
    singleZoneCount = single;
    dualZoneCount = dual;
    lastSanitizationTimestamp = lastSanitized;
    sanitizationRecommended = (riskScore >= SANITIZATION_THRESHOLD);
    lastDecayMillis = millis();
    lastScoreChangeReason = "State recovered from Firebase after boot";
    Serial.printf("[MODEL] >> State Restored: Score=%.1f, Touches=%d\n", riskScore, touchCount);
  }

  void applyScoreIncrement(float pts, const char* reason) {
    float oldScore = riskScore;
    riskScore = constrain(riskScore + pts, 0.0f, 100.0f);
    lastScoreChangeDelta = riskScore - oldScore;
    lastScoreChangeReason = reason;

    if (riskScore >= SANITIZATION_THRESHOLD) {
      sanitizationRecommended = true;
    }
  }

  // Getters
  float getRiskScore() const { return riskScore; }
  const char* getRiskLevel() const {
    if (riskScore < 25.0f) return "Low";
    if (riskScore < 50.0f) return "Elevated";
    if (riskScore < 75.0f) return "High";
    return "Critical";
  }
  int getTouchCount() const { return touchCount; }
  int getSingleZoneCount() const { return singleZoneCount; }
  int getDualZoneCount() const { return dualZoneCount; }
  bool isSanitizationRecommended() const { return sanitizationRecommended; }
  unsigned long getLastTouchDurationMs() const { return lastContactDurationMs; }
  unsigned long getLastTouchTimestamp() const { return lastTouchTimestamp; }
  const char* getLastTouchEvent() const { return lastTouchEvent.c_str(); }
  unsigned long getLastSanitizationTimestamp() const { return lastSanitizationTimestamp; }
  float getPreSanitizeScore() const { return preSanitizeScore; }
  const char* getLastScoreChangeReason() const { return lastScoreChangeReason.c_str(); }
  float getLastScoreChangeDelta() const { return lastScoreChangeDelta; }

private:
  unsigned long getEpochOrMillis() {
    time_t nowSec;
    time(&nowSec);
    if (nowSec > 100000000) {
      return (unsigned long)nowSec * 1000ULL;
    }
    return millis();
  }
};

// Model Instance
ContaminationRiskEstimator model;

// Loop Timers
unsigned long lastTouchSampleTime = 0;
unsigned long lastEnvSampleTime   = 0;
unsigned long lastTelemetryPush   = 0;
unsigned long lastControlCheck    = 0;

// ============================================================================
// 4. HARDWARE SENSING FUNCTIONS
// ============================================================================

void calibrateTouchSensors() {
  Serial.println("========================================");
  Serial.println("   CALIBRATING CAPACITIVE TOUCH ZONES   ");
  Serial.println("      Keep hands away for 2 seconds     ");
  Serial.println("========================================");
  delay(2000);

  long total1 = 0;
  long total2 = 0;
  const int SAMPLES = 20;

  for (int i = 0; i < SAMPLES; i++) {
    total1 += touchRead(TOUCH_ZONE_1);
    total2 += touchRead(TOUCH_ZONE_2);
    delay(50);
  }

  baselineZone1 = total1 / SAMPLES;
  baselineZone2 = total2 / SAMPLES;

  Serial.printf("Zone 1 (GPIO%d) Baseline: %d, Threshold: %d\n", 
    TOUCH_ZONE_1, baselineZone1, (int)(baselineZone1 * TOUCH_THRESHOLD_PERCENT));
  Serial.printf("Zone 2 (GPIO%d) Baseline: %d, Threshold: %d\n", 
    TOUCH_ZONE_2, baselineZone2, (int)(baselineZone2 * TOUCH_THRESHOLD_PERCENT));
  Serial.println("Calibration complete.\n");
}

void sampleTouchSensors() {
  currentTouch1 = touchRead(TOUCH_ZONE_1);
  currentTouch2 = touchRead(TOUCH_ZONE_2);

  // Calibrated threshold with protective floor (guarantees touches under 150 are always recognized)
  int thresh1 = max((int)(baselineZone1 * TOUCH_THRESHOLD_PERCENT), 150);
  int thresh2 = max((int)(baselineZone2 * TOUCH_THRESHOLD_PERCENT), 150);

  zone1Touched = (currentTouch1 < thresh1);
  zone2Touched = (currentTouch2 < thresh2);

  // Feed samples to the model
  model.processTouchSamples(currentTouch1, currentTouch2, thresh1, thresh2);
}

void sampleEnvironment() {
  currentTemperature = sht31.readTemperature();
  currentHumidity    = sht31.readHumidity();

  if (isnan(currentTemperature) || isnan(currentHumidity)) {
    Serial.println("[SHT31] Warning: Environmental reading failed.");
  }
}

// ============================================================================
// 5. FIREBASE HTTPS COMMUNICATION
// ============================================================================

/**
 * Pushes comprehensive telemetry and model state to devices/door-01/latest
 */
void pushTelemetryToFirebase() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure(); // Standard for ESP32 root certificate bypass
  HTTPClient https;

  String url = String("https://") + FIREBASE_HOST + "/" + DEVICE_PATH + "/latest.json";
  if (strlen(FIREBASE_AUTH) > 0) {
    url += String("?auth=") + FIREBASE_AUTH;
  }

  https.begin(client, url);
  https.addHeader("Content-Type", "application/json");

  // Get epoch time
  time_t nowSec;
  time(&nowSec);
  unsigned long epochMs = (nowSec > 100000000) ? ((unsigned long)nowSec * 1000ULL) : millis();

  float envMod = model.computeEnvModifier(currentTemperature, currentHumidity);

  // Build JSON payload preserving ALL legacy fields + adding risk model fields
  char payload[900];
  snprintf(payload, sizeof(payload),
    "{"
      "\"temperature\":%.2f,"
      "\"humidity\":%.2f,"
      "\"touch12\":%d,"
      "\"touch14\":%d,"
      "\"gpio12_raw\":%d,"
      "\"gpio14_raw\":%d,"
      "\"zone12_touched\":%s,"
      "\"zone14_touched\":%s,"
      "\"touchABaseline\":%d,"
      "\"touchBBaseline\":%d,"
      "\"riskScore\":%.2f,"
      "\"riskLevel\":\"%s\","
      "\"touchCount\":%d,"
      "\"singleZoneCount\":%d,"
      "\"dualZoneCount\":%d,"
      "\"sanitizationRecommended\":%s,"
      "\"sanitizationThreshold\":%.1f,"
      "\"lastTouchTimestamp\":%lu,"
      "\"lastTouchDurationMs\":%lu,"
      "\"lastTouchEvent\":\"%s\","
      "\"lastSanitizationTimestamp\":%lu,"
      "\"preSanitizeScore\":%.1f,"
      "\"lastScoreChangeReason\":\"%s\","
      "\"lastScoreChangeDelta\":%.2f,"
      "\"decayTauSeconds\":%.0f,"
      "\"envModifierFactor\":%.2f,"
      "\"modelVersion\":\"1.0.0-provisional\","
      "\"updatedAt\":%lu"
    "}",
    isnan(currentTemperature) ? 0.0f : currentTemperature,
    isnan(currentHumidity) ? 0.0f : currentHumidity,
    currentTouch1, currentTouch2,
    currentTouch1, currentTouch2,
    zone1Touched ? "true" : "false",
    zone2Touched ? "true" : "false",
    baselineZone1, baselineZone2,
    model.getRiskScore(),
    model.getRiskLevel(),
    model.getTouchCount(),
    model.getSingleZoneCount(),
    model.getDualZoneCount(),
    model.isSanitizationRecommended() ? "true" : "false",
    SANITIZATION_THRESHOLD,
    model.getLastTouchTimestamp(),
    model.getLastTouchDurationMs(),
    model.getLastTouchEvent(),
    model.getLastSanitizationTimestamp(),
    model.getPreSanitizeScore(),
    model.getLastScoreChangeReason(),
    model.getLastScoreChangeDelta(),
    BASE_TAU_SECONDS / envMod,
    envMod,
    epochMs
  );

  int httpCode = https.PATCH(payload);
  if (httpCode > 0) {
    if (httpCode == HTTP_CODE_OK || httpCode == 204) {
      // Telemetry synced
    } else {
      Serial.printf("[FIREBASE] Sync HTTP response: %d\n", httpCode);
    }
  } else {
    Serial.printf("[FIREBASE] Telemetry PATCH failed, error: %s\n", https.errorToString(httpCode).c_str());
  }
  https.end();
}

/**
 * Checks for sanitization commands at devices/door-01/control/sanitizationRequest
 */
void checkSanitizationControl() {
  if (WiFi.status() != WL_CONNECTED) return;

  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;

  String url = String("https://") + FIREBASE_HOST + "/" + DEVICE_PATH + "/control/sanitizationRequest.json";
  if (strlen(FIREBASE_AUTH) > 0) {
    url += String("?auth=") + FIREBASE_AUTH;
  }

  https.begin(client, url);
  int httpCode = https.GET();

  if (httpCode == HTTP_CODE_OK) {
    String resp = https.getString();
    // Simple fast JSON check: is requested true?
    if (resp.indexOf("\"requested\":true") >= 0 || resp.indexOf("\"requested\": true") >= 0) {
      Serial.println("[CONTROL] Sanitization request received from dashboard!");
      
      // Execute authoritative reset on the model
      model.markSanitized(0);

      // Acknowledge request by updating Firebase control node
      https.end();
      https.begin(client, url);
      https.addHeader("Content-Type", "application/json");
      String ackPayload = "{\"requested\":false,\"status\":\"acknowledged\",\"acknowledgedAt\":" + String(millis()) + "}";
      https.PATCH(ackPayload);
      https.end();

      // Immediately push updated telemetry to Firebase
      pushTelemetryToFirebase();
      return;
    }
  }
  https.end();
}

/**
 * Recovers persistent model counters on boot to avoid state reset
 */
void recoverStateFromFirebase() {
  if (WiFi.status() != WL_CONNECTED) return;

  Serial.println("[BOOT] Checking Firebase for previous device state...");
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient https;

  String url = String("https://") + FIREBASE_HOST + "/" + DEVICE_PATH + "/latest.json";
  if (strlen(FIREBASE_AUTH) > 0) {
    url += String("?auth=") + FIREBASE_AUTH;
  }

  https.begin(client, url);
  int httpCode = https.GET();

  if (httpCode == HTTP_CODE_OK) {
    String body = https.getString();
    // Parse key fields if present
    int scoreIdx = body.indexOf("\"riskScore\":");
    if (scoreIdx >= 0) {
      float score = body.substring(scoreIdx + 12).toFloat();
      int touchesIdx = body.indexOf("\"touchCount\":");
      int touches = touchesIdx >= 0 ? body.substring(touchesIdx + 13).toInt() : 0;
      int singleIdx = body.indexOf("\"singleZoneCount\":");
      int single = singleIdx >= 0 ? body.substring(singleIdx + 18).toInt() : 0;
      int dualIdx = body.indexOf("\"dualZoneCount\":");
      int dual = dualIdx >= 0 ? body.substring(dualIdx + 16).toInt() : 0;

      model.restoreState(score, touches, single, dual, 0);
    }
  }
  https.end();
}

// ============================================================================
// 6. SETUP & MAIN LOOP
// ============================================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n========================================");
  Serial.println("  SmartLogix ESP32 Contamination Model  ");
  Serial.println("========================================");

  // Initialize I2C for SHT31
  Wire.begin(SDA_PIN, SCL_PIN);
  if (sht31.begin(0x44)) {
    Serial.println("[SHT31] Sensor initialized at 0x44");
  } else if (sht31.begin(0x45)) {
    Serial.println("[SHT31] Sensor initialized at 0x45");
  } else {
    Serial.println("[SHT31] Not detected; will continue with default environmental values.");
  }

  // Calibrate touch sensors
  calibrateTouchSensors();

  // Connect to Wi-Fi
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int wifiAttempts = 0;
  while (WiFi.status() != WL_CONNECTED && wifiAttempts < 30) {
    delay(500);
    Serial.print(".");
    wifiAttempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\n[WIFI] Connected! IP: " + WiFi.localIP().toString());
    // Configure NTP time sync
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    recoverStateFromFirebase();
  } else {
    Serial.println("\n[WIFI] Wi-Fi connection timed out. Running in local mode.");
  }

  Serial.println("[SYSTEM] Setup complete. Entering operational loop.\n");
}

void loop() {
  unsigned long now = millis();

  // 1. Touch Sensor Sampling & State Machine (~100 ms)
  if (now - lastTouchSampleTime >= TOUCH_SAMPLE_INTERVAL_MS) {
    lastTouchSampleTime = now;
    sampleTouchSensors();
  }

  // 2. Environmental Sampling (~2000 ms)
  if (now - lastEnvSampleTime >= ENV_SAMPLE_INTERVAL_MS) {
    lastEnvSampleTime = now;
    sampleEnvironment();
  }

  // 3. Time Decay Model Calculation
  model.updateDecay(currentTemperature, currentHumidity);

  // 4. Sanitization Control Command Checking (~4000 ms)
  if (now - lastControlCheck >= CONTROL_CHECK_INTERVAL) {
    lastControlCheck = now;
    checkSanitizationControl();
  }

  // 5. Telemetry Push to Firebase (~3000 ms)
  if (now - lastTelemetryPush >= TELEMETRY_PUSH_INTERVAL) {
    lastTelemetryPush = now;
    pushTelemetryToFirebase();
  }
}
