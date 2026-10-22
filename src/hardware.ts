export type HardwareFrame = {
  touchA: number
  touchB: number
  touchAActive?: boolean
  touchBActive?: boolean
  touchABaseline?: number
  touchBBaseline?: number
  touchAThreshold?: number
  touchBThreshold?: number
  temperature: number
  humidity: number
  receivedAt: Date
  raw: string
  directionEvent?: 'entry' | 'exit' | 'ambiguous' | 'none'
  entryCount?: number
  exitCount?: number
  stuckA?: boolean
  stuckB?: boolean
}

/**
 * Turns diagnostic output from the ESP32 sketch into frames the dashboard can consume.
 * Supports the user's sketch line format:
 *   ZONE 1: 700 [NOT TOUCHED]    ZONE 2: 450 [TOUCHED]
 *   Temperature: 28.50 C
 *   Humidity: 60.10 %
 *   Zone 1 baseline: 700
 *   Zone 1 threshold: 490
 * As well as JSON objects and CSV lines.
 */
export class Esp32SerialFrameAssembler {
  private touchA: number | null = null
  private touchB: number | null = null
  private touchAActive: boolean | undefined
  private touchBActive: boolean | undefined
  private touchABaseline: number | undefined
  private touchBBaseline: number | undefined
  private touchAThreshold: number | undefined
  private touchBThreshold: number | undefined
  private temperature: number | null = null
  private humidity: number | null = null

  // Direction sequence tracking
  private lastTouchATime: number = 0
  private lastTouchBTime: number = 0
  private touchAState: boolean = false
  private touchBState: boolean = false
  private entryCount: number = 0
  private exitCount: number = 0
  private touchAStartTime: number = 0
  private touchBStartTime: number = 0
  private stuckA: boolean = false
  private stuckB: boolean = false

  private frame(): HardwareFrame | null {
    if (this.touchA === null || this.touchB === null) return null

    // Fallback temperature & humidity if SHT31 is missing or read failed
    const effectiveTemp = this.temperature ?? 25.0
    const effectiveHumidity = this.humidity ?? 50.0

    if (effectiveTemp < -40 || effectiveTemp > 100 || effectiveHumidity < 0 || effectiveHumidity > 100) return null

    // Direction detection (A -> B = Entry, B -> A = Exit within 1000ms)
    let directionEvent: 'entry' | 'exit' | 'ambiguous' | 'none' = 'none'
    const now = Date.now()

    // Watchdog for stuck sensors (> 10 sec)
    if (this.touchAActive && !this.touchAState) {
      this.touchAStartTime = now
      this.touchAState = true
      this.lastTouchATime = now
      if (now - this.lastTouchBTime <= 1000 && this.lastTouchBTime > 0) {
        directionEvent = 'exit'
        this.exitCount++
      }
    } else if (!this.touchAActive && this.touchAState) {
      this.touchAState = false
      this.stuckA = false
    } else if (this.touchAActive && (now - this.touchAStartTime > 10000)) {
      this.stuckA = true
    }

    if (this.touchBActive && !this.touchBState) {
      this.touchBStartTime = now
      this.touchBState = true
      this.lastTouchBTime = now
      if (now - this.lastTouchATime <= 1000 && this.lastTouchATime > 0) {
        directionEvent = 'entry'
        this.entryCount++
      }
    } else if (!this.touchBActive && this.touchBState) {
      this.touchBState = false
      this.stuckB = false
    } else if (this.touchBActive && (now - this.touchBStartTime > 10000)) {
      this.stuckB = true
    }

    return {
      touchA: this.touchA,
      touchB: this.touchB,
      touchAActive: this.touchAActive,
      touchBActive: this.touchBActive,
      touchABaseline: this.touchABaseline,
      touchBBaseline: this.touchBBaseline,
      touchAThreshold: this.touchAThreshold,
      touchBThreshold: this.touchBThreshold,
      temperature: effectiveTemp,
      humidity: effectiveHumidity,
      receivedAt: new Date(),
      raw: JSON.stringify({
        touchA: this.touchA,
        touchB: this.touchB,
        touchAActive: this.touchAActive,
        touchBActive: this.touchBActive,
        temperature: effectiveTemp,
        humidity: effectiveHumidity,
        direction: directionEvent,
      }),
      directionEvent,
      entryCount: this.entryCount,
      exitCount: this.exitCount,
      stuckA: this.stuckA,
      stuckB: this.stuckB,
    }
  }

  ingest(line: string): HardwareFrame | null {
    const raw = line.trim()
    if (!raw) return null

    // 1. Direct JSON frame
    const directFrame = parseHardwareFrame(raw)
    if (directFrame) {
      this.touchA = directFrame.touchA
      this.touchB = directFrame.touchB
      this.touchAActive = directFrame.touchAActive
      this.touchBActive = directFrame.touchBActive
      this.temperature = directFrame.temperature
      this.humidity = directFrame.humidity
      if (directFrame.touchABaseline) this.touchABaseline = directFrame.touchABaseline
      if (directFrame.touchBBaseline) this.touchBBaseline = directFrame.touchBBaseline
      return this.frame()
    }

    // 2. Calibration / baseline / threshold lines
    const base1Match = raw.match(/Zone\s*1\s*baseline\s*:\s*(\d+)/i)
    if (base1Match) {
      this.touchABaseline = Number(base1Match[1])
      return null
    }

    const base2Match = raw.match(/Zone\s*2\s*baseline\s*:\s*(\d+)/i)
    if (base2Match) {
      this.touchBBaseline = Number(base2Match[1])
      return null
    }

    const thresh1Match = raw.match(/Zone\s*1\s*threshold\s*:\s*(\d+)/i)
    if (thresh1Match) {
      this.touchAThreshold = Number(thresh1Match[1])
      return null
    }

    const thresh2Match = raw.match(/Zone\s*2\s*threshold\s*:\s*(\d+)/i)
    if (thresh2Match) {
      this.touchBThreshold = Number(thresh2Match[1])
      return null
    }

    // 3. User sketch dual touch line:
    // ZONE 1: 700 [NOT TOUCHED]    ZONE 2: 450 [TOUCHED]
    const touchMatch = raw.match(/ZONE\s*1\s*:\s*(-?\d+(?:\.\d+)?)(?:\s*\[([^\]]+)\])?.*?ZONE\s*2\s*:\s*(-?\d+(?:\.\d+)?)(?:\s*\[([^\]]+)\])?/i)
    if (touchMatch) {
      this.touchA = Number(touchMatch[1])
      this.touchB = Number(touchMatch[3])
      const stateA = (touchMatch[2] ?? '').trim()
      const stateB = (touchMatch[4] ?? '').trim()

      if (stateA) {
        this.touchAActive = /TOUCHED/i.test(stateA) && !/NOT\s+TOUCHED/i.test(stateA)
      } else if (this.touchABaseline) {
        this.touchAActive = this.touchA < this.touchABaseline * 0.70
      }

      if (stateB) {
        this.touchBActive = /TOUCHED/i.test(stateB) && !/NOT\s+TOUCHED/i.test(stateB)
      } else if (this.touchBBaseline) {
        this.touchBActive = this.touchB < this.touchBBaseline * 0.70
      }

      return this.frame()
    }

    // 4. Single Zone lines (in case printed separately)
    const singleZone1 = raw.match(/^ZONE\s*1\s*:\s*(-?\d+(?:\.\d+)?)(?:\s*\[([^\]]+)\])?/i)
    if (singleZone1) {
      this.touchA = Number(singleZone1[1])
      const state = (singleZone1[2] ?? '').trim()
      if (state) this.touchAActive = /TOUCHED/i.test(state) && !/NOT\s+TOUCHED/i.test(state)
      return this.frame()
    }

    const singleZone2 = raw.match(/^ZONE\s*2\s*:\s*(-?\d+(?:\.\d+)?)(?:\s*\[([^\]]+)\])?/i)
    if (singleZone2) {
      this.touchB = Number(singleZone2[1])
      const state = (singleZone2[2] ?? '').trim()
      if (state) this.touchBActive = /TOUCHED/i.test(state) && !/NOT\s+TOUCHED/i.test(state)
      return this.frame()
    }

    // 5. Environmental lines
    const temperatureMatch = raw.match(/^Temperature\s*:\s*(-?\d+(?:\.\d+)?)/i)
    if (temperatureMatch) {
      this.temperature = Number(temperatureMatch[1])
      return null
    }

    const humidityMatch = raw.match(/^Humidity\s*:\s*(-?\d+(?:\.\d+)?)/i)
    if (humidityMatch) {
      this.humidity = Number(humidityMatch[1])
      return this.frame()
    }

    return null
  }
}

export type HardwareStatus = {
  connected: boolean
  source: 'web-serial' | 'web-bluetooth' | 'demo' | 'offline'
  label: string
  baudRate?: number
  lastMessageAt?: Date
  error?: string
}

export type HardwareDerivedMetrics = {
  touchA: number
  touchB: number
  touchFlow: number
  touchBalance: number
  occupancyEstimate: number
  cpi: number
  comfort: number
  heatIndex: number
  heatCategory: string
}

export const BHEED_BLE_SERVICE_UUID = '4e5f1001-8b6b-4c3b-a1d9-9c948a90a001'
export const BHEED_BLE_TELEMETRY_UUID = '4e5f1002-8b6b-4c3b-a1d9-9c948a90a001'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const numberOr = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  return parsed
}

export function parseHardwareFrame(line: string): HardwareFrame | null {
  const raw = line.trim()
  if (!raw) return null

  let source: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object') source = parsed
  } catch {
    const values = raw.split(',').map((value) => value.trim())
    if (values.length >= 4 && values.every((value) => Number.isFinite(Number(value)))) {
      source = { touchA: values[0], touchB: values[1], temperature: values[2], humidity: values[3] }
    }
  }

  if (!source) return null
  const touchA = numberOr(source.touchA ?? source.touch1 ?? source.electrodeA ?? source.e1)
  const touchB = numberOr(source.touchB ?? source.touch2 ?? source.electrodeB ?? source.e2)
  const temperature = numberOr(source.temperature ?? source.temp ?? source.t)
  const humidity = numberOr(source.humidity ?? source.rh ?? source.relativeHumidity)
  if (![touchA, touchB, temperature, humidity].every(Number.isFinite)) return null
  if (temperature < -40 || temperature > 100 || humidity < 0 || humidity > 100) return null
  const booleanOrUndefined = (value: unknown) => typeof value === 'boolean' ? value : undefined
  const touchABaseline = numberOr(source.touchABaseline ?? source.baselineTouchA ?? source.baseline1)
  const touchBBaseline = numberOr(source.touchBBaseline ?? source.baselineTouchB ?? source.baseline2)
  return {
    touchA,
    touchB,
    touchAActive: booleanOrUndefined(source.touchAActive ?? source.touchedA ?? source.touched1),
    touchBActive: booleanOrUndefined(source.touchBActive ?? source.touchedB ?? source.touched2),
    touchABaseline: Number.isFinite(touchABaseline) ? touchABaseline : undefined,
    touchBBaseline: Number.isFinite(touchBBaseline) ? touchBBaseline : undefined,
    temperature,
    humidity,
    receivedAt: new Date(),
    raw,
  }
}

/**
 * Calculates Heat Index using the Rothfusz regression / Steadman formula.
 * Input: temperature in °C, humidity in % RH.
 * Output: Heat Index in °C and classification category.
 */
export function calculateHeatIndex(tempC: number, rh: number): { heatIndexC: number; category: string } {
  const tempF = (tempC * 9) / 5 + 32

  let hiF = 0.5 * (tempF + 61.0 + (tempF - 68.0) * 1.2 + rh * 0.094)
  if (hiF >= 80) {
    hiF =
      -42.379 +
      2.04901523 * tempF +
      10.14333127 * rh -
      0.22475541 * tempF * rh -
      0.00683783 * tempF * tempF -
      0.05481717 * rh * rh +
      0.00122874 * tempF * tempF * rh +
      0.00085282 * tempF * rh * rh -
      0.00000199 * tempF * tempF * rh * rh

    if (rh < 13 && tempF >= 80 && tempF <= 112) {
      hiF -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(tempF - 95)) / 17)
    } else if (rh > 85 && tempF >= 80 && tempF <= 87) {
      hiF += ((rh - 85) / 10) * ((87 - tempF) / 5)
    }
  }

  const heatIndexC = Number((((hiF - 32) * 5) / 9).toFixed(1))

  let category = 'Comfortable'
  if (heatIndexC >= 51) category = 'Extreme Danger'
  else if (heatIndexC >= 39) category = 'Danger'
  else if (heatIndexC >= 32) category = 'Extreme Caution'
  else if (heatIndexC >= 27) category = 'Caution'

  return { heatIndexC, category }
}

export function deriveHardwareMetrics(frame: HardwareFrame): HardwareDerivedMetrics {
  const normalizedActivity = (value: number, baseline?: number, active?: boolean) => {
    if (active !== undefined) return active ? 1 : 0
    if (baseline && baseline > 0) return clamp((baseline - value) / (baseline * 0.30), 0, 1)
    return value <= 1 ? clamp(value, 0, 1) : 0
  }
  const touchA = normalizedActivity(frame.touchA, frame.touchABaseline, frame.touchAActive)
  const touchB = normalizedActivity(frame.touchB, frame.touchBBaseline, frame.touchBActive)
  const touchFlow = Math.round(((touchA + touchB) / 2) * 100)
  const touchBalance = Math.round(Math.abs(touchA - touchB) * 100)

  const netEntries = (frame.entryCount ?? 0) - (frame.exitCount ?? 0)
  const occupancyEstimate = Math.max(0, Math.round(180 + netEntries * 2 + touchFlow * 2.5))

  const { heatIndexC, category } = calculateHeatIndex(frame.temperature, frame.humidity)

  const cpi = Number(clamp(0.18 + touchFlow / 145 + touchBalance / 600 + Math.max(0, heatIndexC - 27) * 0.015, 0.16, 0.99).toFixed(2))
  const comfort = Math.round(clamp(100 - (heatIndexC - 23) * 2.8 - Math.abs(frame.humidity - 50) * 0.35 - cpi * 15, 20, 100))

  return {
    touchA: Math.round(touchA * 100),
    touchB: Math.round(touchB * 100),
    touchFlow,
    touchBalance,
    occupancyEstimate,
    cpi,
    comfort,
    heatIndex: heatIndexC,
    heatCategory: category,
  }
}

type SerialReader = ReadableStreamDefaultReader<string>
type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null
  open: (options: { baudRate: number }) => Promise<void>
  close: () => Promise<void>
  addEventListener?: (type: string, listener: (event: Event) => void) => void
}

type SerialLike = {
  requestPort: () => Promise<SerialPortLike>
  addEventListener?: (type: string, listener: (event: Event) => void) => void
}

type NavigatorWithSerial = Navigator & { serial?: SerialLike }

type BluetoothCharacteristicLike = {
  startNotifications: () => Promise<BluetoothCharacteristicLike>
  addEventListener: (type: 'characteristicvaluechanged', listener: (event: Event) => void) => void
}

type BluetoothDeviceLike = {
  gatt?: {
    connect: () => Promise<{ getPrimaryService: (uuid: string) => Promise<{ getCharacteristic: (uuid: string) => Promise<BluetoothCharacteristicLike> }> }>
    disconnect: () => void
  }
}

type NavigatorWithBluetooth = Navigator & {
  bluetooth?: { requestDevice: (options: { filters: Array<{ services: string[] }> }) => Promise<BluetoothDeviceLike> }
}

export class WebSerialHardwareAdapter {
  private port: SerialPortLike | null = null
  private reader: SerialReader | null = null
  private readableStreamClosed: Promise<void> | null = null
  private closed = false

  async connect(
    onFrame: (frame: HardwareFrame) => void,
    onStatus: (status: HardwareStatus) => void,
    baudRate: number = 115200
  ) {
    const serial = (navigator as NavigatorWithSerial).serial
    if (!serial) {
      throw new Error('Web Serial is not available in this browser. Please use Chrome, Edge, or Opera over HTTPS or localhost.')
    }

    this.port = await serial.requestPort()
    await this.port.open({ baudRate })
    this.closed = false

    onStatus({ connected: true, source: 'web-serial', label: `Web Serial / ${baudRate} baud`, baudRate })

    if (!this.port.readable) {
      throw new Error('The selected serial port is not readable.')
    }

    const decoder = new TextDecoderStream()
    this.readableStreamClosed = (this.port.readable as unknown as ReadableStream<BufferSource>).pipeTo(decoder.writable)
    this.reader = decoder.readable.getReader()

    let buffer = ''
    const assembler = new Esp32SerialFrameAssembler()

    // Listen for USB disconnects
    if (serial.addEventListener) {
      serial.addEventListener('disconnect', () => {
        onStatus({ connected: false, source: 'offline', label: 'USB serial device disconnected' })
        void this.disconnect()
      })
    }

    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read()
        if (done) break
        buffer += value
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const frame = assembler.ingest(line)
          if (frame) onFrame(frame)
        }
      }
    } catch (err) {
      if (!this.closed) {
        onStatus({
          connected: false,
          source: 'offline',
          label: 'Serial stream interrupted',
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      this.reader?.releaseLock()
      this.reader = null
    }
  }

  async disconnect() {
    this.closed = true
    if (this.reader) {
      await this.reader.cancel().catch(() => undefined)
      this.reader = null
    }
    if (this.readableStreamClosed) {
      await this.readableStreamClosed.catch(() => undefined)
      this.readableStreamClosed = null
    }
    if (this.port) {
      await this.port.close().catch(() => undefined)
      this.port = null
    }
  }
}

export class WebBluetoothHardwareAdapter {
  private device: BluetoothDeviceLike | null = null

  async connect(onFrame: (frame: HardwareFrame) => void, onStatus: (status: HardwareStatus) => void) {
    const bluetooth = (navigator as NavigatorWithBluetooth).bluetooth
    if (!bluetooth) throw new Error('Web Bluetooth is unavailable here. Use Chrome or Edge on desktop over localhost or HTTPS.')
    this.device = await bluetooth.requestDevice({ filters: [{ services: [BHEED_BLE_SERVICE_UUID] }] })
    if (!this.device.gatt) throw new Error('The selected ESP32 does not expose a Bluetooth GATT connection.')
    const server = await this.device.gatt.connect()
    const service = await server.getPrimaryService(BHEED_BLE_SERVICE_UUID)
    const characteristic = await service.getCharacteristic(BHEED_BLE_TELEMETRY_UUID)
    await characteristic.startNotifications()
    characteristic.addEventListener('characteristicvaluechanged', (event) => {
      const value = (event.target as { value?: DataView }).value
      if (!value) return
      const text = new TextDecoder().decode(value.buffer)
      const frame = parseHardwareFrame(text)
      if (frame) onFrame(frame)
    })
    onStatus({ connected: true, source: 'web-bluetooth', label: 'BLE / ESP32 telemetry' })
  }

  disconnect() {
    this.device?.gatt?.disconnect()
    this.device = null
  }
}
