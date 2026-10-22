// BHEED-RAKSHAK BLE telemetry for an original ESP32-CAM.
// Sends anonymous touch, temperature, and humidity data to the dashboard.
// Do not use camera features: this prototype collects no image or identity data.

#include <Wire.h>
#include <Adafruit_SHT31.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#define SDA_PIN 13
#define SCL_PIN 15
#define TOUCH_ZONE_1 12
#define TOUCH_ZONE_2 14

#define SERVICE_UUID "4e5f1001-8b6b-4c3b-a1d9-9c948a90a001"
#define TELEMETRY_UUID "4e5f1002-8b6b-4c3b-a1d9-9c948a90a001"

Adafruit_SHT31 sht31 = Adafruit_SHT31();
BLECharacteristic *telemetryCharacteristic;
bool bleClientConnected = false;

int baselineZone1 = 0;
int baselineZone2 = 0;
int currentTouch1 = 0;
int currentTouch2 = 0;
float currentTemperature = NAN;
float currentHumidity = NAN;

const float TOUCH_THRESHOLD_PERCENT = 0.70;
unsigned long lastTouchRead = 0;
unsigned long lastEnvironmentRead = 0;
unsigned long lastTelemetrySend = 0;
const unsigned long TOUCH_INTERVAL = 100;
const unsigned long ENVIRONMENT_INTERVAL = 2000;
const unsigned long TELEMETRY_INTERVAL = 250;

class ConnectionCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleClientConnected = true; }
  void onDisconnect(BLEServer *server) override {
    bleClientConnected = false;
    server->startAdvertising();
  }
};

void calibrateTouchSensors() {
  delay(2000); // keep hands away during calibration
  long total1 = 0;
  long total2 = 0;
  for (int i = 0; i < 20; i++) {
    total1 += touchRead(TOUCH_ZONE_1);
    total2 += touchRead(TOUCH_ZONE_2);
    delay(50);
  }
  baselineZone1 = total1 / 20;
  baselineZone2 = total2 / 20;
}

void readTouch() {
  currentTouch1 = touchRead(TOUCH_ZONE_1);
  currentTouch2 = touchRead(TOUCH_ZONE_2);
}

void readEnvironment() {
  currentTemperature = sht31.readTemperature();
  currentHumidity = sht31.readHumidity();
}

void sendTelemetry() {
  if (!bleClientConnected || isnan(currentTemperature) || isnan(currentHumidity)) return;
  char payload[220];
  snprintf(payload, sizeof(payload),
    "{\"touchA\":%d,\"touchB\":%d,\"touchAActive\":%s,\"touchBActive\":%s,\"touchABaseline\":%d,\"touchBBaseline\":%d,\"temperature\":%.2f,\"humidity\":%.2f}",
    currentTouch1, currentTouch2,
    currentTouch1 < baselineZone1 * TOUCH_THRESHOLD_PERCENT ? "true" : "false",
    currentTouch2 < baselineZone2 * TOUCH_THRESHOLD_PERCENT ? "true" : "false",
    baselineZone1, baselineZone2, currentTemperature, currentHumidity);
  telemetryCharacteristic->setValue((uint8_t *)payload, strlen(payload));
  telemetryCharacteristic->notify();
}

void setup() {
  Wire.begin(SDA_PIN, SCL_PIN);
  if (!sht31.begin(0x44) && !sht31.begin(0x45)) while (true) delay(1000);
  calibrateTouchSensors();
  readTouch();
  readEnvironment();

  BLEDevice::init("BHEED-RAKSHAK CAM");
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ConnectionCallbacks());
  BLEService *service = server->createService(SERVICE_UUID);
  telemetryCharacteristic = service->createCharacteristic(TELEMETRY_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  telemetryCharacteristic->addDescriptor(new BLE2902());
  service->start();
  server->getAdvertising()->start();
}

void loop() {
  unsigned long now = millis();
  if (now - lastTouchRead >= TOUCH_INTERVAL) { lastTouchRead = now; readTouch(); }
  if (now - lastEnvironmentRead >= ENVIRONMENT_INTERVAL) { lastEnvironmentRead = now; readEnvironment(); }
  if (now - lastTelemetrySend >= TELEMETRY_INTERVAL) { lastTelemetrySend = now; sendTelemetry(); }
}
