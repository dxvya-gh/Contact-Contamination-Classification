import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { evaluateAIRouting, VISITOR_PROFILES } from './aiRouting'
import type { AIRoutingDecision } from './aiRouting'
import './styles.css'

type ZoneStatus = 'calm' | 'watch' | 'elevated'
type Zone = {
  id: string
  name: string
  short: string
  accent: string
  occupancy: number
  capacity: number
  temperature: number
  humidity: number
  cpi: number
  comfort: number
  distance: number
  status: ZoneStatus
  history: number[]
}

type Alert = {
  id: string
  zone: string
  severity: 'watch' | 'elevated'
  title: string
  body: string
  time: string
  response: string
}

const initialZones: Zone[] = [
  { id: 'north', name: 'North Gate', short: 'N', accent: '#61e7d6', occupancy: 188, capacity: 450, temperature: 28.6, humidity: 57, cpi: 0.68, comfort: 82, distance: 120, status: 'watch', history: [39, 42, 46, 48, 51, 52, 54, 57, 59, 58, 61, 63] },
  { id: 'floor', name: 'Main Floor', short: 'M', accent: '#ffb96a', occupancy: 642, capacity: 860, temperature: 31.8, humidity: 66, cpi: 0.82, comfort: 63, distance: 220, status: 'elevated', history: [52, 56, 54, 60, 62, 66, 69, 72, 74, 75, 78, 79] },
  { id: 'river', name: 'River Walk', short: 'R', accent: '#8f9cff', occupancy: 104, capacity: 340, temperature: 26.1, humidity: 51, cpi: 0.36, comfort: 91, distance: 310, status: 'calm', history: [27, 28, 29, 31, 30, 33, 35, 34, 32, 31, 31, 30] },
]

const initialAlerts: Alert[] = [
  { id: 'alert-1', zone: 'Main Floor', severity: 'elevated', title: 'Pressure rising', body: 'CPI crossed the 0.80 watch threshold with heat index trending up.', time: '00:04 ago', response: 'Open River Walk flow' },
  { id: 'alert-2', zone: 'North Gate', severity: 'watch', title: 'Queue forming', body: 'Occupancy is stable, but entry dwell time is extending at the east lane.', time: '02:18 ago', response: 'Enable directional signage' },
]

const navItems = [
  { label: 'Dashboard', target: 'top', glyph: '⌂' },
  { label: 'Simulation', target: 'sim-controls', glyph: '⚙' },
  { label: 'Venue Map', target: 'map-section', glyph: '🗺' },
  { label: 'AI Routing', target: 'ai-engine', glyph: '🧠' },
  { label: 'Zones', target: 'zones', glyph: '◫' },
  { label: 'Alerts', target: 'alerts', glyph: '!' },
  { label: 'Impact', target: 'impact', glyph: '◒' },
]

function SignalMark({ small = false }: { small?: boolean }) {
  return <span className={small ? 'signal-mark signal-mark--small' : 'signal-mark'} aria-hidden="true"><i /><i /><i /></span>
}

function Glyph({ children }: { children: ReactNode }) {
  return <span className="glyph" aria-hidden="true">{children}</span>
}

function Sparkline({ values, accent = '#61e7d6', height = 48 }: { values: number[]; accent?: string; height?: number }) {
  const width = 260
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = Math.max(1, max - min)
  const points = values.map((value, index) => `${(index / (values.length - 1)) * width},${height - ((value - min) / span) * (height - 8) - 4}`).join(' ')
  const finalY = Number(points.split(' ').slice(-1)[0]?.split(',')[1] ?? height / 2)
  return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="telemetry trend">
    <defs><linearGradient id={`gradient-${accent.replace('#', '')}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={accent} stopOpacity=".28" /><stop offset="1" stopColor={accent} stopOpacity="0" /></linearGradient></defs>
    <polyline points={`0,${height} ${points} ${width},${height}`} fill={`url(#gradient-${accent.replace('#', '')})`} stroke="none" />
    <polyline points={points} fill="none" stroke={accent} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={width} cy={finalY} r="3.5" fill={accent} />
  </svg>
}

function Metric({ label, value, suffix, tone = 'cyan', detail }: { label: string; value: string; suffix?: string; tone?: string; detail: string }) {
  return <div className="metric-card">
    <div className="metric-label"><span>{label}</span><span className={`status-dot status-dot--${tone}`} /></div>
    <div className="metric-value">{value}<small>{suffix}</small></div>
    <div className="metric-detail">{detail}</div>
  </div>
}

function ProgressRail({ value, color = '#61e7d6' }: { value: number; color?: string }) {
  return <div className="progress-rail"><span style={{ width: `${Math.min(100, value)}%`, background: color }} /></div>
}

function ZoneCard({ zone, active, onSelect }: { zone: Zone; active: boolean; onSelect: () => void }) {
  const statusLabel = zone.status === 'elevated' ? 'Elevated' : zone.status === 'watch' ? 'Watch' : 'Calm'
  const statusTone = zone.status === 'elevated' ? 'coral' : zone.status === 'watch' ? 'amber' : 'cyan'
  return <button className={`zone-card ${active ? 'zone-card--active' : ''}`} onClick={onSelect} style={{ '--zone-accent': zone.accent } as CSSProperties}>
    <div className="zone-card__top"><div className="zone-id"><span className="zone-index">{zone.short}</span><div><strong>{zone.name}</strong><small>Zone telemetry</small></div></div><span className={`pill pill--${statusTone}`}>{statusLabel}</span></div>
    <div className="zone-card__pressure"><div><span className="micro-label">Crowd pressure index</span><strong>{zone.cpi.toFixed(2)}</strong></div><div className="pressure-ring" style={{ '--pressure': `${zone.cpi * 100}%` } as CSSProperties}><span>{Math.round(zone.cpi * 100)}<small>%</small></span></div></div>
    <ProgressRail value={(zone.occupancy / zone.capacity) * 100} color={zone.accent} />
    <div className="zone-card__stats"><span><b>{zone.occupancy}</b> people</span><span><b>{zone.temperature.toFixed(1)}°</b> / {Math.round(zone.humidity)}%</span><span><b>{zone.comfort}</b> comfort</span></div>
    <Sparkline values={zone.history} accent={zone.accent} />
  </button>
}

function Panel({ id, eyebrow, title, action, children, className = '' }: { id?: string; eyebrow: string; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section id={id} className={`panel ${className}`}><div className="panel-heading"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>{action}</div>{children}</section>
}

/**
 * Interactive 2D Venue Map featuring Dynamic AI Path Diversion Vectors
 */
function VenueMap({ zones, activeZoneId, onSelectZone, targetZoneId, targetZoneName }: { zones: Zone[]; activeZoneId: string; onSelectZone: (id: string) => void; targetZoneId: string; targetZoneName: string }) {
  const north = zones.find(z => z.id === 'north') ?? zones[0]
  const floor = zones.find(z => z.id === 'floor') ?? zones[1]
  const river = zones.find(z => z.id === 'river') ?? zones[2]

  const highestPressureZone = [...zones].sort((a, b) => b.cpi - a.cpi)[0]
  const isHighPressure = highestPressureZone.cpi >= 0.55
  const isElevated = highestPressureZone.cpi >= 0.79

  const getZoneCoords = (id: string) => {
    if (id === 'north') return { cx: 170, cy: 125 }
    if (id === 'floor') return { cx: 450, cy: 125 }
    return { cx: 730, cy: 125 }
  }

  const sourceCoords = getZoneCoords(highestPressureZone.id)
  const destCoords = getZoneCoords(targetZoneId !== 'none' ? targetZoneId : 'river')

  const zoneColor = (z: Zone) => z.status === 'elevated' ? '#ff6b6b' : z.status === 'watch' ? '#ffb96a' : '#61e7d6'

  return (
    <div className="venue-map-container">
      <div className={`map-diversion-banner map-diversion-banner--${highestPressureZone.status}`}>
        <div>
          <strong>{isHighPressure ? '⚡ AI DIVERSION VECTOR ACTIVE' : '✓ CROWD FLOW STABLE'}</strong>
          <span>
            {isHighPressure
              ? ` AI is re-routing crowd flow away from ${highestPressureZone.name} (CPI ${highestPressureZone.cpi.toFixed(2)}) → ${targetZoneName}`
              : ` All venue zones operating within safe crowd pressure boundaries.`}
          </span>
        </div>
        <span className="pulse" />
      </div>

      <svg viewBox="0 0 900 240" className="venue-map-svg">
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill={isElevated ? '#ff6b6b' : '#ffb96a'} />
          </marker>
        </defs>

        {/* Outer Venue Boundary */}
        <rect x="20" y="20" width="860" height="200" rx="8" fill="none" stroke="#1c282e" strokeWidth="1.5" strokeDasharray="4 4" />

        {/* Connecting Corridors */}
        <line x1="20" y1="125" x2="80" y2="125" stroke="#2a383f" strokeWidth="6" strokeLinecap="round" />
        <text x="30" y="110" fill="#657880" fontSize="9" fontFamily="IBM Plex Mono">MAIN GATE</text>

        <line x1="260" y1="125" x2="340" y2="125" stroke="#2a383f" strokeWidth="8" strokeLinecap="round" />
        <line x1="560" y1="125" x2="640" y2="125" stroke="#2a383f" strokeWidth="8" strokeLinecap="round" />

        {/* Safe Exit vector */}
        <line x1="730" y1="190" x2="730" y2="220" stroke="#61e7d6" strokeWidth="4" strokeDasharray="4 3" />
        <text x="740" y="215" fill="#61e7d6" fontSize="9" fontFamily="IBM Plex Mono">SAFE EXIT ↗</text>

        {/* North Gate Zone (A) */}
        <g className="map-zone-shape" onClick={() => onSelectZone('north')}>
          <rect
            x="80" y="55" width="180" height="135" rx="6"
            fill={activeZoneId === 'north' ? 'rgba(97,231,214,0.14)' : 'rgba(255,255,255,0.02)'}
            stroke={zoneColor(north)}
            strokeWidth={activeZoneId === 'north' ? '2.5' : '1.5'}
          />
          <text x="95" y="80" fill="#ffffff" fontSize="13" fontWeight="bold">North Gate (Zone A)</text>
          <text x="95" y="102" fill={zoneColor(north)} fontSize="10" fontFamily="IBM Plex Mono">CPI {north.cpi.toFixed(2)} · {north.status.toUpperCase()}</text>
          <text x="95" y="124" fill="#8f9cff" fontSize="10" fontFamily="IBM Plex Mono">{north.occupancy} / {north.capacity} people ({Math.round(north.occupancy/north.capacity*100)}%)</text>
          <text x="95" y="144" fill="#a1b0b5" fontSize="10" fontFamily="IBM Plex Mono">{north.temperature.toFixed(1)}°C · {Math.round(north.humidity)}% RH</text>
          <rect x="95" y="158" width={Math.min(150, (north.occupancy/north.capacity)*150)} height="4" rx="2" fill={zoneColor(north)} />
        </g>

        {/* Main Floor Zone (B) */}
        <g className="map-zone-shape" onClick={() => onSelectZone('floor')}>
          <rect
            x="340" y="55" width="220" height="135" rx="6"
            fill={activeZoneId === 'floor' ? 'rgba(255,185,106,0.14)' : 'rgba(255,255,255,0.02)'}
            stroke={zoneColor(floor)}
            strokeWidth={activeZoneId === 'floor' ? '2.5' : '1.5'}
          />
          <text x="355" y="80" fill="#ffffff" fontSize="13" fontWeight="bold">Main Floor (Zone B)</text>
          <text x="355" y="102" fill={zoneColor(floor)} fontSize="10" fontFamily="IBM Plex Mono">CPI {floor.cpi.toFixed(2)} · {floor.status.toUpperCase()}</text>
          <text x="355" y="124" fill="#8f9cff" fontSize="10" fontFamily="IBM Plex Mono">{floor.occupancy} / {floor.capacity} people ({Math.round(floor.occupancy/floor.capacity*100)}%)</text>
          <text x="355" y="144" fill="#a1b0b5" fontSize="10" fontFamily="IBM Plex Mono">{floor.temperature.toFixed(1)}°C · {Math.round(floor.humidity)}% RH</text>
          <rect x="355" y="158" width={Math.min(190, (floor.occupancy/floor.capacity)*190)} height="4" rx="2" fill={zoneColor(floor)} />
        </g>

        {/* River Walk Zone (C) */}
        <g className="map-zone-shape" onClick={() => onSelectZone('river')}>
          <rect
            x="640" y="55" width="180" height="135" rx="6"
            fill={activeZoneId === 'river' ? 'rgba(143,156,255,0.14)' : 'rgba(255,255,255,0.02)'}
            stroke={zoneColor(river)}
            strokeWidth={activeZoneId === 'river' ? '2.5' : '1.5'}
          />
          <text x="655" y="80" fill="#ffffff" fontSize="13" fontWeight="bold">River Walk (Zone C)</text>
          <text x="655" y="102" fill={zoneColor(river)} fontSize="10" fontFamily="IBM Plex Mono">CPI {river.cpi.toFixed(2)} · {river.status.toUpperCase()}</text>
          <text x="655" y="124" fill="#8f9cff" fontSize="10" fontFamily="IBM Plex Mono">{river.occupancy} / {river.capacity} people ({Math.round(river.occupancy/river.capacity*100)}%)</text>
          <text x="655" y="144" fill="#a1b0b5" fontSize="10" fontFamily="IBM Plex Mono">{river.temperature.toFixed(1)}°C · {Math.round(river.humidity)}% RH</text>
          <rect x="655" y="158" width={Math.min(150, (river.occupancy/river.capacity)*150)} height="4" rx="2" fill={zoneColor(river)} />
        </g>

        {/* Animated Diversion Path Vector */}
        {isHighPressure && sourceCoords.cx !== destCoords.cx && (
          <g>
            <path
              d={`M ${sourceCoords.cx} ${sourceCoords.cy - 35} Q ${(sourceCoords.cx + destCoords.cx) / 2} ${sourceCoords.cy - 65} ${destCoords.cx} ${destCoords.cy - 35}`}
              fill="none"
              stroke={isElevated ? '#ff6b6b' : '#ffb96a'}
              strokeWidth="3.5"
              className="map-flow-line"
              markerEnd="url(#arrowhead)"
            />
            <circle cx={(sourceCoords.cx + destCoords.cx) / 2} cy={sourceCoords.cy - 65} r="4" fill="#ff6b6b" className="map-particle" />
            <text
              x={(sourceCoords.cx + destCoords.cx) / 2}
              y={sourceCoords.cy - 72}
              fill={isElevated ? '#ff6b6b' : '#ffb96a'}
              fontSize="10"
              fontWeight="bold"
              fontFamily="IBM Plex Mono"
              textAnchor="middle"
            >
              AI PATH VECTOR ({highestPressureZone.short} → {targetZoneName})
            </text>
          </g>
        )}
      </svg>

      <div className="map-legend">
        <div className="map-legend-item"><span className="map-legend-swatch" style={{ background: '#61e7d6' }} /> Calm (CPI &lt; 0.55)</div>
        <div className="map-legend-item"><span className="map-legend-swatch" style={{ background: '#ffb96a' }} /> Watch (CPI 0.55–0.78)</div>
        <div className="map-legend-item"><span className="map-legend-swatch" style={{ background: '#ff6b6b' }} /> Elevated (CPI ≥ 0.79)</div>
        <div className="map-legend-item" style={{ marginLeft: 'auto' }}><span className="pulse" /> Interactive Map — Click zones to tune telemetry</div>
      </div>
    </div>
  )
}

function App() {
  const [zones, setZones] = useState<Zone[]>(initialZones.map((zone) => ({ ...zone, history: [...zone.history] })))
  const [activeZoneId, setActiveZoneId] = useState('floor')
  const [alerts, setAlerts] = useState<Alert[]>(initialAlerts.map((alert) => ({ ...alert })))
  const [running, setRunning] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [incident, setIncident] = useState(false)
  const [signage, setSignage] = useState(false)
  const [lastTick, setLastTick] = useState(new Date())
  const [activeNav, setActiveNav] = useState('top')
  const [globalIntensity, setGlobalIntensity] = useState(0)
  const [scenario, setScenario] = useState('baseline')

  // AI Routing Engine States
  const [selectedProfileId, setSelectedProfileId] = useState<string>('general')
  const [selectedModelType, setSelectedModelType] = useState<'utility' | 'neural_surge' | 'q_routing'>('utility')

  const activeZone = zones.find((zone) => zone.id === activeZoneId) ?? zones[1]
  const totalOccupancy = zones.reduce((sum, zone) => sum + zone.occupancy, 0)
  const totalCapacity = zones.reduce((sum, zone) => sum + zone.capacity, 0)
  const venueCpi = zones.reduce((sum, zone) => sum + zone.cpi * zone.occupancy, 0) / (totalOccupancy || 1)
  const activeCount = zones.filter((zone) => zone.status !== 'calm').length

  // Evaluate AI Routing Model Decision
  const aiDecision: AIRoutingDecision = useMemo(() => {
    return evaluateAIRouting(zones, selectedProfileId, selectedModelType)
  }, [zones, selectedProfileId, selectedModelType])

  useEffect(() => {
    if (!running) return undefined
    const interval = window.setInterval(() => {
      setZones((current) => current.map((zone, index) => {
        const drift = Math.sin(Date.now() / 4200 + index * 1.6) * 1.7 * speed
        const parameterBoost = globalIntensity / 100
        const eventBoost = scenario === 'surge' && zone.id === 'floor' ? 6 : scenario === 'evacuation' && zone.id === 'floor' ? 4.3 : scenario === 'blocked-exit' && zone.id === 'north' ? 3 : incident && zone.id === 'floor' ? 4.3 : 0
        const nextOccupancy = Math.max(24, Math.min(zone.capacity - 16, Math.round(zone.occupancy + drift + eventBoost + parameterBoost * 4)))
        const cpi = Math.min(0.99, Math.max(0.16, zone.cpi + (nextOccupancy - zone.occupancy) / zone.capacity * 0.6 + (eventBoost ? 0.018 : 0) + parameterBoost * 0.012))
        const temperature = Math.max(23, Math.min(38, zone.temperature + Math.sin(Date.now() / 5600 + index) * 0.08 + (zone.id === 'floor' ? 0.02 : 0) + parameterBoost * 0.025 + (scenario === 'heatwave' ? 0.18 : 0)))
        const humidity = Math.max(40, Math.min(88, zone.humidity + Math.cos(Date.now() / 4800 + index) * 0.3 + parameterBoost * 0.16 + (scenario === 'heatwave' ? 0.55 : 0)))
        const comfort = Math.round(Math.max(38, Math.min(96, 100 - (temperature - 23) * 2.4 - (humidity - 42) * 0.32 - cpi * 17)))
        const status: ZoneStatus = cpi >= 0.79 ? 'elevated' : cpi >= 0.55 ? 'watch' : 'calm'
        return { ...zone, occupancy: nextOccupancy, cpi: Number(cpi.toFixed(2)), temperature, humidity, comfort, status, history: [...zone.history.slice(-11), Math.round((nextOccupancy / zone.capacity) * 100)] }
      }))
      setLastTick(new Date())
    }, Math.max(1000, 2600 / speed))
    return () => window.clearInterval(interval)
  }, [globalIntensity, incident, running, scenario, speed])

  const jumpTo = (target: string) => {
    setActiveNav(target)
    document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const resetSimulation = () => {
    setZones(initialZones.map((zone) => ({ ...zone, history: [...zone.history] })))
    setAlerts(initialAlerts.map((alert) => ({ ...alert })))
    setIncident(false)
    setScenario('baseline')
    setGlobalIntensity(0)
    setSignage(false)
    setLastTick(new Date())
  }

  const applyScenario = (nextScenario: string) => {
    setScenario(nextScenario)
    if (nextScenario === 'baseline') {
      setIncident(false)
      setAlerts(initialAlerts.map((alert) => ({ ...alert })))
      return
    }
    const labels: Record<string, { zone: string; title: string; body: string; response: string }> = {
      surge: { zone: 'Main Floor', title: 'Crowd surge detected', body: 'Synthetic inflow is raising occupancy and CPI on the main floor.', response: 'Open River Walk flow' },
      heatwave: { zone: 'All zones', title: 'Heat stress rising', body: 'Temperature and humidity are climbing across the venue model.', response: 'Enable ventilation response' },
      'blocked-exit': { zone: 'North Gate', title: 'Exit route blocked', body: 'The north route is carrying an obstruction penalty in the route model.', response: 'Recalculate diversion' },
      evacuation: { zone: 'Main Floor', title: 'Evacuation scenario active', body: 'Pressure is rising while directional flow is being diverted to lower-risk zones.', response: 'Open River Walk flow' },
    }
    const event = labels[nextScenario]
    setIncident(nextScenario === 'evacuation' || nextScenario === 'surge')
    setAlerts((current) => [{ id: `scenario-${nextScenario}`, zone: event.zone, severity: 'elevated', title: event.title, body: event.body, time: 'just now', response: event.response }, ...current.filter((alert) => !alert.id.startsWith('scenario-'))])
  }

  const changeIntensity = (value: number) => {
    setGlobalIntensity(Math.max(0, Math.min(100, value)))
  }

  const changeZoneParameter = (zoneId: string, parameter: 'occupancy' | 'temperature' | 'humidity', value: number) => {
    setZones((current) => current.map((zone) => {
      if (zone.id !== zoneId) return zone
      const next = { ...zone, [parameter]: value }
      const occupancyRatio = next.occupancy / next.capacity
      const cpi = Number(Math.max(.12, Math.min(.99, .12 + occupancyRatio * .68 + Math.max(0, next.temperature - 27) * .012 + Math.max(0, next.humidity - 55) * .003)).toFixed(2))
      const comfort = Math.round(Math.max(25, Math.min(98, 100 - Math.max(0, next.temperature - 23) * 3.2 - Math.abs(next.humidity - 50) * .5 - cpi * 12)))
      const status: ZoneStatus = cpi >= .79 ? 'elevated' : cpi >= .55 ? 'watch' : 'calm'
      return { ...next, cpi, comfort, status, history: [...zone.history.slice(-11), Math.round(occupancyRatio * 100)] }
    }))
  }

  const scenarioOptions = [
    { id: 'baseline', icon: '◌', label: 'Baseline', detail: 'Normal venue rhythm', tone: 'cyan' },
    { id: 'surge', icon: '↗', label: 'Crowd surge', detail: 'Main floor inflow spike', tone: 'amber' },
    { id: 'heatwave', icon: '≈', label: 'Heat wave', detail: 'Temperature + humidity rise', tone: 'amber' },
    { id: 'blocked-exit', icon: '⊘', label: 'Blocked exit', detail: 'North route obstruction', tone: 'coral' },
    { id: 'evacuation', icon: '!', label: 'Emergency evacuation', detail: 'Pressure + route diversion', tone: 'coral' },
  ]

  const selectedZone = zones.find((zone) => zone.id === activeZoneId) ?? zones[1]

  return <div className="app-shell" id="top">
    <aside className="sidebar">
      <div className="brand"><SignalMark /><div><strong>BHEED</strong><span>RAKSHAK</span></div></div>
      <div className="sidebar-rule" />
      <div className="rail-label">Command surface</div>
      <nav className="main-nav" aria-label="Primary navigation">{navItems.map((item) => <button key={item.target} className={activeNav === item.target ? 'nav-item nav-item--active' : 'nav-item'} onClick={() => jumpTo(item.target)}><Glyph>{item.glyph}</Glyph><span>{item.label}</span>{item.target === 'alerts' && alerts.length > 0 && <em>{alerts.length}</em>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="live-badge"><span className="pulse" /> <span>AI Engine Online</span></div><button className="privacy-link" onClick={() => jumpTo('system')}><Glyph>⌁</Glyph><span>Privacy by design</span></button></div>
    </aside>

    <main className="content">
      <header className="topbar">
        <div className="mobile-brand"><SignalMark small /><strong>BHEED-RAKSHAK</strong></div>
        <div className="topbar-meta">
          <span className="system-state"><i className="pulse" /> AI decision engine online</span>
          <span className="divider-dot">·</span>
          <span>refreshed {lastTick.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <button className="icon-button" aria-label="Open system panel" onClick={() => jumpTo('system')}>⋯</button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow eyebrow--cyan">Venue control / 03 zones / Explainable AI Routing</div>
          <h1>Keep the crowd<br /><em>in a safe rhythm.</em></h1>
          <p>An AI-driven, environment-first command surface. Pluggable multi-criteria utility, neural surge forecasting, and safety-constrained Q-routing decide the optimal path for arriving visitors.</p>
          <div className="hero-actions">
            <button className="primary-button" onClick={() => jumpTo('ai-engine')}><span className="button-mark">🧠</span> Test AI Routing Engine</button>
            <button className="secondary-button" onClick={() => jumpTo('map-section')}>View Interactive Map <span>🗺</span></button>
          </div>
        </div>
        <div className="hero-signal">
          <div className="signal-orbit signal-orbit--outer" />
          <div className="signal-orbit signal-orbit--inner" />
          <div className="signal-core"><SignalMark /><span>AI<br />Routing</span></div>
          <div className="orbit-label orbit-label--top">CPI <b>{venueCpi.toFixed(2)}</b></div>
          <div className="orbit-label orbit-label--right">{totalOccupancy.toLocaleString()} <span>people</span></div>
          <div className="orbit-label orbit-label--bottom">AI Path: <b>{aiDecision.selectedZoneName}</b></div>
        </div>
      </section>

      <section className="metric-strip" aria-label="Venue overview">
        <Metric label="Venue pressure" value={venueCpi.toFixed(2)} tone={venueCpi > .75 ? 'coral' : 'cyan'} detail={venueCpi > .75 ? 'above comfort band' : 'within comfort band'} />
        <Metric label="People in venue" value={totalOccupancy.toLocaleString()} suffix={` / ${totalCapacity.toLocaleString()}`} detail={`${Math.round(totalOccupancy / totalCapacity * 100)}% total capacity`} />
        <Metric label="Active Profile" value={aiDecision.profile.name} tone="cyan" detail={aiDecision.profile.description} />
        <Metric label="AI Recommended Path" value={aiDecision.selectedZoneName} tone="cyan" detail={`Model: ${selectedModelType.toUpperCase()}`} />
      </section>

      {/* Simulation Controls Section */}
      <section id="sim-controls" className="simulation-grid">
        <Panel eyebrow="01 / event presets" title="Simulate an event scenario" action={<div className="sim-status"><i className={running ? 'pulse' : ''} /> {running ? 'running' : 'paused'}</div>}>
          <div className="event-grid">{scenarioOptions.map((option) => <button key={option.id} className={`event-option event-option--${option.tone} ${scenario === option.id ? 'event-option--active' : ''}`} onClick={() => applyScenario(option.id)}><span className="event-icon">{option.icon}</span><span><b>{option.label}</b><small>{option.detail}</small></span>{scenario === option.id && <i className="event-check">✓</i>}</button>)}</div>
          <div className="simulation-actions"><button className="primary-button primary-button--compact" onClick={() => setRunning((value) => !value)}><span>{running ? 'Ⅱ' : '▶'}</span> {running ? 'Pause run' : 'Resume run'}</button><button className="secondary-button secondary-button--compact" onClick={resetSimulation}>Reset baseline</button><div className="speed-select"><span>speed</span>{[.5, 1, 2].map((item) => <button key={item} className={speed === item ? 'speed speed--active' : 'speed'} onClick={() => setSpeed(item)}>{item}×</button>)}</div></div>
        </Panel>

        <Panel eyebrow="02 / parameter sweep" title="Global parameter intensity" action={<span className="intensity-readout">{globalIntensity}% intensity</span>}>
          <p className="simulation-description">Raise synthetic load across occupancy, pressure, temperature, and humidity. Observe how the AI model re-evaluates the optimal path!</p>
          <div className="intensity-control"><div className="intensity-scale"><span>nominal</span><b>{globalIntensity < 30 ? 'gentle' : globalIntensity < 70 ? 'stress' : 'critical'}</b><span>critical</span></div><input type="range" min="0" max="100" value={globalIntensity} onChange={(event) => changeIntensity(Number(event.target.value))} style={{ '--intensity': `${globalIntensity}%` } as CSSProperties} aria-label="Global parameter intensity" /></div>
          <div className="parameter-readouts"><div><span>occupancy</span><b>+{Math.round(globalIntensity * .42)}%</b></div><div><span>temperature</span><b>+{(globalIntensity * .06).toFixed(1)}°</b></div><div><span>humidity</span><b>+{Math.round(globalIntensity * .18)}%</b></div><div><span>pressure</span><b>+{(globalIntensity * .7).toFixed(0)} pts</b></div></div>
          <button className="intensity-button" onClick={() => changeIntensity(Math.min(100, globalIntensity + 20))}>Increase parameters <span>＋</span></button>
        </Panel>
      </section>

      {/* Interactive Venue Map Section */}
      <Panel id="map-section" eyebrow="03 / spatial AI visualization" title="Interactive Venue Map & AI Diversion Path Vector">
        <VenueMap zones={zones} activeZoneId={activeZoneId} onSelectZone={setActiveZoneId} targetZoneId={aiDecision.selectedZoneId} targetZoneName={aiDecision.selectedZoneName} />
      </Panel>

      {/* AI Routing Engine & Decision Matrix Section */}
      <Panel id="ai-engine" eyebrow="04 / Explainable AI Decision Engine" title="AI Path Routing & Explainability Matrix">
        <div className="ai-control-bar">
          <div>
            <span className="micro-label" style={{ display: 'block', marginBottom: '6px' }}>Visitor Profile Selection</span>
            <div className="profile-selector">
              {Object.values(VISITOR_PROFILES).map((p) => (
                <button
                  key={p.id}
                  className={`profile-chip ${selectedProfileId === p.id ? 'profile-chip--active' : ''}`}
                  onClick={() => setSelectedProfileId(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="micro-label" style={{ display: 'block', marginBottom: '6px' }}>AI Routing Model</span>
            <select
              value={selectedModelType}
              onChange={(e) => setSelectedModelType(e.target.value as any)}
              className="ai-model-select"
              aria-label="AI Model Selection"
            >
              <option value="utility">Multi-Criteria Utility AI (Comfort + Vacancy Curve)</option>
              <option value="neural_surge">Predictive Neural Surge AI (10-Min Bottleneck Forecast)</option>
              <option value="q_routing">Reinforcement Safety Policy (Q-Routing)</option>
            </select>
          </div>
        </div>

        <div className="ai-decision-card">
          <div className="ai-decision-top">
            <div>
              <span className="micro-label">AI Selected Path Target</span>
              <div className="ai-decision-badge">➜ {aiDecision.selectedZoneName}</div>
            </div>
            <span className="pill pill--cyan">{aiDecision.profile.name} · {selectedModelType.toUpperCase()} MODEL</span>
          </div>
          <div className="ai-explanation-box">
            <strong>Explainable AI Rationale:</strong> {aiDecision.reason}
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table className="ai-matrix-table">
            <thead>
              <tr>
                <th>Candidate Zone</th>
                <th>Hard Safety Gates</th>
                <th>AI Score</th>
                <th>Comfort Term</th>
                <th>Vacancy Term</th>
                <th>Distance Cost</th>
                <th>Risk Penalty</th>
              </tr>
            </thead>
            <tbody>
              {aiDecision.zoneEvaluations.map((evalItem) => (
                <tr key={evalItem.zoneId} className={evalItem.zoneId === aiDecision.selectedZoneId ? 'tr--selected' : ''}>
                  <td><strong>{evalItem.zoneName}</strong></td>
                  <td>
                    {evalItem.passedHardGates ? (
                      <span className="gate-pass">✓ PASSED</span>
                    ) : (
                      <span className="gate-fail">✕ EXCLUDED ({evalItem.rejectionReason})</span>
                    )}
                  </td>
                  <td><strong>{evalItem.passedHardGates ? `${evalItem.score} pts` : '0 pts'}</strong></td>
                  <td>+{evalItem.comfortComponent}</td>
                  <td>+{evalItem.vacancyComponent}</td>
                  <td>-{evalItem.distanceComponent}</td>
                  <td>-{evalItem.riskComponent + evalItem.surgePenalty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Zone Parameter Tuning Section */}
      <section className="simulation-grid simulation-grid--lower">
        <Panel eyebrow="05 / zone response map" title="Zone Telemetry Summary">
          <div className="simulation-zone-list">{zones.map((zone) => <button key={zone.id} className={`simulation-zone-row ${activeZoneId === zone.id ? 'simulation-zone-row--active' : ''}`} onClick={() => setActiveZoneId(zone.id)}><span className="zone-index" style={{ '--zone-accent': zone.accent } as CSSProperties}>{zone.short}</span><span className="simulation-zone-name"><b>{zone.name}</b><small>{zone.occupancy} / {zone.capacity} people</small></span><span className="simulation-zone-bar"><i style={{ width: `${zone.cpi * 100}%`, background: zone.status === 'elevated' ? 'var(--coral)' : zone.status === 'watch' ? 'var(--amber)' : zone.accent }} /></span><strong className={`simulation-zone-value simulation-zone-value--${zone.status}`}>{zone.cpi.toFixed(2)}</strong><span className="simulation-zone-state">{zone.status}</span></button>)}</div>
          <div className="selected-simulation-zone"><span className="micro-label">Selected zone / {selectedZone.name}</span><strong>{selectedZone.comfort}<small> comfort</small></strong><span>{selectedZone.temperature.toFixed(1)}°C · {Math.round(selectedZone.humidity)}% humidity · {selectedZone.distance}m exit distance</span></div>
        </Panel>

        <Panel eyebrow="06 / parameter tuning" title={`Tune ${selectedZone.name}`}>
          <p className="simulation-description">Drag sliders to adjust occupancy, temperature, and humidity. All AI decisions and map vectors update live!</p>
          <div className="sim-zone-controls">
            <label><span>Occupancy <b>{selectedZone.occupancy} people</b></span><input type="range" min="0" max={selectedZone.capacity} value={selectedZone.occupancy} onChange={(event) => changeZoneParameter(selectedZone.id, 'occupancy', Number(event.target.value))} /></label>
            <label><span>Temperature <b>{selectedZone.temperature.toFixed(1)}°C</b></span><input type="range" min="18" max="45" step=".1" value={selectedZone.temperature} onChange={(event) => changeZoneParameter(selectedZone.id, 'temperature', Number(event.target.value))} /></label>
            <label><span>Humidity <b>{Math.round(selectedZone.humidity)}% RH</b></span><input type="range" min="20" max="95" value={selectedZone.humidity} onChange={(event) => changeZoneParameter(selectedZone.id, 'humidity', Number(event.target.value))} /></label>
          </div>
        </Panel>
      </section>

      {/* Zones at a glance with Sparklines */}
      <div className="section-heading" id="zones">
        <div><div className="eyebrow">07 / live telemetry pulse</div><h2>Zones at a glance</h2></div>
        <div className="section-note"><span className="legend-dot legend-dot--cyan" /> calm <span className="legend-dot legend-dot--amber" /> watch <span className="legend-dot legend-dot--coral" /> elevated</div>
      </div>

      <section className="zone-layout">
        <div className="zone-list">{zones.map((zone) => <ZoneCard key={zone.id} zone={zone} active={zone.id === activeZoneId} onSelect={() => setActiveZoneId(zone.id)} />)}</div>
        <Panel eyebrow="Selected zone / live read" title={activeZone.name} className="zone-detail">
          <div className="selected-zone-head">
            <div><span className={`pill pill--${activeZone.status === 'elevated' ? 'coral' : activeZone.status === 'watch' ? 'amber' : 'cyan'}`}>{activeZone.status} · live</span><p>{activeZone.status === 'elevated' ? 'The next safe action is already in view.' : 'Telemetry is steady. Keep the line of sight clear.'}</p></div>
            <div className="selected-zone-value"><span>CPI</span><b>{activeZone.cpi.toFixed(2)}</b></div>
          </div>
          <div className="large-chart">
            <div className="chart-axis"><span>100%</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
            <Sparkline values={activeZone.history} accent={activeZone.accent} height={152} />
            <div className="chart-labels"><span>-60m</span><span>-45m</span><span>-30m</span><span>-15m</span><span>now</span></div>
          </div>
          <div className="detail-grid">
            <div><span className="micro-label">Occupancy</span><strong>{activeZone.occupancy}</strong><small> / {activeZone.capacity}</small><ProgressRail value={activeZone.occupancy / activeZone.capacity * 100} color={activeZone.accent} /></div>
            <div><span className="micro-label">Comfort score</span><strong>{activeZone.comfort}</strong><small> / 100</small><ProgressRail value={activeZone.comfort} color={activeZone.comfort > 75 ? '#61e7d6' : '#ffb96a'} /></div>
            <div><span className="micro-label">Heat index</span><strong>{(activeZone.temperature + activeZone.humidity * .04).toFixed(1)}°</strong><small> feels like</small><span className="detail-trend">↗ +0.8° / 20m</span></div>
            <div><span className="micro-label">Flow distance</span><strong>{activeZone.distance}</strong><small> m to exit</small><span className="detail-trend detail-trend--muted">→ route stable</span></div>
          </div>
        </Panel>
      </section>

      {/* Safety Signals & Alerts */}
      <section className="two-column" id="alerts">
        <Panel id="alerts" eyebrow="08 / act now" title="Safety signals" action={<button className="text-button" onClick={() => setAlerts([])}>Clear resolved <span>×</span></button>}>
          <div className="alert-list">{alerts.length === 0 ? <div className="empty-state"><span>✓</span><strong>Quiet for now.</strong><p>No unresolved pressure signals in the simulation.</p></div> : alerts.map((alert) => <article className={`alert-item alert-item--${alert.severity}`} key={alert.id}><div className="alert-indicator">{alert.severity === 'elevated' ? '!' : '•'}</div><div className="alert-body"><div className="alert-topline"><span>{alert.zone}</span><time>{alert.time}</time></div><strong>{alert.title}</strong><p>{alert.body}</p><button className="alert-response" onClick={() => jumpTo('sim-controls')}>{alert.response} <span>→</span></button></div></article>)}</div>
        </Panel>

        <Panel eyebrow="09 / AI policy constraints" title="Safety Hard Gates Log">
          <div className="ai-explanation-box" style={{ background: '#0b1215', minHeight: '180px' }}>
            <strong>Active Safety Rules:</strong>
            <ul style={{ paddingLeft: '18px', marginTop: '8px', lineHeight: '1.7' }}>
              <li><strong>90% Hard Capacity Ceiling:</strong> Automatically excludes any zone projected at or above 90% occupancy.</li>
              <li><strong>RED Risk Band Exclusion:</strong> Excludes any zone with CPI ≥ 0.79 regardless of profile comfort score.</li>
              <li><strong>Soft Ceiling Limits:</strong> General profile capped at 75%; priority profiles capped at 85%.</li>
              <li><strong>Pending Arrivals Reservation:</strong> Prevents herding by accounting for visitors routed within the last 90 seconds.</li>
            </ul>
          </div>
        </Panel>
      </section>

      {/* Impact & Privacy */}
      <section className="impact-panel" id="impact">
        <div className="impact-copy">
          <div className="eyebrow">10 / measurable impact</div>
          <h2>Small interventions.<br /><em>Visible difference.</em></h2>
          <p>The simulation shows how early AI warnings turn into calmer movement. Every response is reversible, explainable, and tied to a measurable signal.</p>
          <button className="secondary-button" onClick={() => jumpTo('alerts')}>Review intervention log <span>→</span></button>
        </div>
        <div className="impact-chart">
          <div className="impact-chart__legend"><span><i className="legend-line legend-line--cyan" /> with BHEED AI</span><span><i className="legend-line legend-line--muted" /> baseline</span></div>
          <svg viewBox="0 0 620 210" preserveAspectRatio="none" role="img" aria-label="Impact comparison chart">
            <defs><linearGradient id="impact-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#61e7d6" stopOpacity=".24" /><stop offset="1" stopColor="#61e7d6" stopOpacity="0" /></linearGradient></defs>
            <path d="M0 172 C80 161 101 158 150 130 S230 120 272 139 S338 112 380 94 S462 84 510 62 S580 47 620 37 L620 210 L0 210 Z" fill="url(#impact-fill)" />
            <path d="M0 172 C80 161 101 158 150 130 S230 120 272 139 S338 112 380 94 S462 84 510 62 S580 47 620 37" fill="none" stroke="#61e7d6" strokeWidth="3" />
            <path d="M0 182 C80 178 106 173 150 167 S232 171 272 162 S335 170 380 151 S456 157 510 140 S577 137 620 126" fill="none" stroke="#506069" strokeWidth="2" strokeDasharray="5 6" />
            <line x1="0" x2="620" y1="70" y2="70" stroke="#2a373d" />
            <line x1="0" x2="620" y1="140" y2="140" stroke="#2a373d" />
            <circle cx="380" cy="94" r="5" fill="#61e7d6" />
            <circle cx="510" cy="62" r="5" fill="#61e7d6" />
            <text x="390" y="84" fill="#a1b0b5" fontSize="11">AI route active</text>
            <text x="520" y="52" fill="#a1b0b5" fontSize="11">stable flow</text>
          </svg>
          <div className="impact-axis"><span>−60m</span><span>−45m</span><span>−30m</span><span>−15m</span><span>now</span></div>
        </div>
        <div className="impact-metrics">
          <div><span>congestion</span><b>−28%</b><small>vs baseline</small></div>
          <div><span>comfort</span><b>+17 pts</b><small>after response</small></div>
          <div><span>response time</span><b>04:12</b><small>avg. to act</small></div>
        </div>
      </section>

      <section className="system-panel" id="system">
        <div className="system-card">
          <div className="eyebrow">11 / system note</div>
          <h2>Human-safe by construction.</h2>
          <p>BHEED-RAKSHAK is designed around anonymous counts and environmental conditions. No names, face attributes, demographic inference, or individual movement trails are part of this command surface.</p>
          <div className="system-tags"><span>anonymous telemetry</span><span>explainable AI</span><span>safety over comfort</span></div>
        </div>
        <div className="contract-card">
          <div className="eyebrow">adapter contract / v0.4</div>
          <div className="code-lines"><span><b>source</b> <em>AI-ENGINE-04</em></span><span><b>models</b> utility · neural_surge · q_routing</span><span><b>identity</b> <em>excluded</em></span><span><b>retention</b> session only</span></div>
          <button className="secondary-button secondary-button--dark" onClick={() => navigator.clipboard?.writeText('BHEED-RAKSHAK AI contract v0.4')}>Copy contract summary <span>↗</span></button>
        </div>
      </section>

      <footer className="footer">
        <div><SignalMark small /> <span>BHEED-RAKSHAK · venue safety interface</span></div>
        <span>AI Engine Build 0.4.5</span>
        <span>made for clearer next actions</span>
      </footer>
    </main>
  </div>
}

export default App

const rootElement = document.getElementById('root')!
const runtime = globalThis as typeof globalThis & { __bheedRoot?: ReturnType<typeof createRoot> }
const appRoot = runtime.__bheedRoot ?? createRoot(rootElement)
runtime.__bheedRoot = appRoot
appRoot.render(<App />)
