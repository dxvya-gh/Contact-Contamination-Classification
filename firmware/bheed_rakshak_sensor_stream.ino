// BHEED-RAKSHAK serial stream for the existing SHT31 + two touch-pad prototype.
// Uses the pins and touch behaviour from the supplied sketch. The output is a
// newline-delimited JSON object that the browser dashboard reads at 115200 baud.

#include <Wire.h>
#include <Adafruit_SHT31.h>

#define SDA_PIN 13
#define SCL_PIN 15
#define TOUCH_ZONE_1 12
#define TOUCH_ZONE_2 14

Adafruit_SHT31 sht31 = Adafruit_SHT31();

int baselineZone1 = 0;
int baselineZone2 = 0;
const float TOUCH_THRESHOLD_PERCENT = 0.70;
unsigned long lastTouchRead = 0;
unsigned long lastSHTRead = 0;
unsigned long lastTelemetrySend = 0;
const unsigned long TOUCH_INTERVAL = 100;
const unsigned long SHT_INTERVAL = 2000;
const unsigned long TELEMETRY_INTERVAL = 100;

int currentTouch1 = 0;
int currentTouch2 = 0;
float currentTemperature = NAN;
float currentHumidity = NAN;

void calibrateTouchSensors() {
  Serial.println("Calibrating touch pads: keep hands off for 2 seconds.");
  delay(2000);
  long totalZone1 = 0;
  long totalZone2 = 0;
  const int samples = 20;
  for (int i = 0; i < samples; i++) {
    totalZone1 += touchRead(TOUCH_ZONE_1);
    totalZone2 += touchRead(TOUCH_ZONE_2);
    delay(50);
  }
  baselineZone1 = totalZone1 / samples;
  baselineZone2 = totalZone2 / samples;
}

void readTouchSensors() {
  currentTouch1 = touchRead(TOUCH_ZONE_1);
  currentTouch2 = touchRead(TOUCH_ZONE_2);
}

void readEnvironment() {
  currentTemperature = sht31.readTemperature();
  currentHumidity = sht31.readHumidity();
  if (isnan(currentTemperature) || isnan(currentHumidity)) {
    Serial.println("{\"error\":\"sht31_read_failed\"}");
  }
}

void sendTelemetry() {
  if (isnan(currentTemperature) || isnan(currentHumidity)) return;
  // A complete frame every 100 ms; temperature/humidity are refreshed every 2 s.
  Serial.print("{\"touchA\":");
  Serial.print(currentTouch1);
  Serial.print(",\"touchB\":");
  Serial.print(currentTouch2);
  Serial.print(",\"touchAActive\":");
  Serial.print(currentTouch1 < baselineZone1 * TOUCH_THRESHOLD_PERCENT ? "true" : "false");
  Serial.print(",\"touchBActive\":");
  Serial.print(currentTouch2 < baselineZone2 * TOUCH_THRESHOLD_PERCENT ? "true" : "false");
  Serial.print(",\"touchABaseline\":");
  Serial.print(baselineZone1);
  Serial.print(",\"touchBBaseline\":");
  Serial.print(baselineZone2);
  Serial.print(",\"temperature\":");
  Serial.print(currentTemperature, 2);
  Serial.print(",\"humidity\":");
  Serial.print(currentHumidity, 2);
  Serial.println("}");
}

void setup() {
  Serial.begin(115200);
  Wire.begin(SDA_PIN, SCL_PIN);
  if (!sht31.begin(0x44) && !sht31.begin(0x45)) {
    Serial.println("{\"error\":\"sht31_not_found\"}");
    while (true) delay(1000);
  }
  calibrateTouchSensors();
  readTouchSensors();
  readEnvironment();
}

void loop() {
  unsigned long now = millis();
  if (now - lastTouchRead >= TOUCH_INTERVAL) {
    lastTouchRead = now;
    readTouchSensors();
  }
  if (now - lastSHTRead >= SHT_INTERVAL) {
    lastSHTRead = now;
    readEnvironment();
  }
  if (now - lastTelemetrySend >= TELEMETRY_INTERVAL) {
    lastTelemetrySend = now;
    sendTelemetry();
  }
}
