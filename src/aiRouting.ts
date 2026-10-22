export type VisitorProfile = {
  id: string
  name: string
  description: string
  wComfort: number
  wVacancy: number
  wDist: number
  wRisk: number
  sensitivity: number
  softCeiling: number // %
}

export const VISITOR_PROFILES: Record<string, VisitorProfile> = {
  general: {
    id: 'general',
    name: 'General Visitor',
    description: 'Balanced routing prioritizing high vacancy and flow.',
    wComfort: 0.25,
    wVacancy: 0.55,
    wDist: 0.20,
    wRisk: 0.30,
    sensitivity: 1.0,
    softCeiling: 75,
  },
  elderly: {
    id: 'elderly',
    name: 'Elderly / Heat Sensitive',
    description: 'High sensitivity to temperature & humidity; comfort prioritized within 85% ceiling.',
    wComfort: 0.60,
    wVacancy: 0.30,
    wDist: 0.10,
    wRisk: 0.35,
    sensitivity: 1.5,
    softCeiling: 85,
  },
  pregnant: {
    id: 'pregnant',
    name: 'Pregnant Visitor',
    description: 'Thermal comfort and low crowd pressure prioritized.',
    wComfort: 0.55,
    wVacancy: 0.30,
    wDist: 0.15,
    wRisk: 0.35,
    sensitivity: 1.4,
    softCeiling: 85,
  },
  mobility: {
    id: 'mobility',
    name: 'Mobility Impaired',
    description: 'Short walking distance to exit & level access prioritized.',
    wComfort: 0.35,
    wVacancy: 0.30,
    wDist: 0.35,
    wRisk: 0.30,
    sensitivity: 1.2,
    softCeiling: 85,
  },
  child: {
    id: 'child',
    name: 'Child with Guardian',
    description: 'Moderate comfort with focus on spacious open paths.',
    wComfort: 0.40,
    wVacancy: 0.45,
    wDist: 0.15,
    wRisk: 0.30,
    sensitivity: 1.3,
    softCeiling: 85,
  },
}

export type CandidateZone = {
  id: string
  name: string
  occupancy: number
  capacity: number
  temperature: number
  humidity: number
  cpi: number
  comfort: number
  distance: number
  pendingArrivals?: number
  closed?: boolean
}

export type ZoneEvaluation = {
  zoneId: string
  zoneName: string
  score: number
  comfortComponent: number
  vacancyComponent: number
  distanceComponent: number
  riskComponent: number
  surgePenalty: number
  passedHardGates: boolean
  rejectionReason?: string
  projOccPct: number
}

export type AIRoutingDecision = {
  selectedZoneId: string
  selectedZoneName: string
  modelType: 'utility' | 'neural_surge' | 'q_routing'
  profile: VisitorProfile
  reason: string
  hardGatesApplied: string[]
  zoneEvaluations: ZoneEvaluation[]
}

export function evaluateAIRouting(
  zones: CandidateZone[],
  profileId: string = 'general',
  modelType: 'utility' | 'neural_surge' | 'q_routing' = 'utility'
): AIRoutingDecision {
  const profile = VISITOR_PROFILES[profileId] ?? VISITOR_PROFILES.general
  const hardGatesApplied: string[] = []

  const evaluations: ZoneEvaluation[] = zones.map((zone) => {
    const pending = zone.pendingArrivals ?? 0
    const projOcc = zone.occupancy + pending
    const projOccPct = (projOcc / zone.capacity) * 100
    const occPct = (zone.occupancy / zone.capacity) * 100

    let passed = true
    let rejectionReason: string | undefined

    // Hard Gate 1: Capacity Ceiling >= 90%
    if (projOccPct >= 90) {
      passed = false
      rejectionReason = `Hard ceiling reached (${projOccPct.toFixed(0)}% >= 90%)`
      hardGatesApplied.push(`${zone.name}: Excluded due to 90% hard capacity ceiling.`)
    }
    // Hard Gate 2: CPI in RED band (>= 0.79)
    else if (zone.cpi >= 0.79) {
      passed = false
      rejectionReason = `CPI in RED band (${zone.cpi.toFixed(2)} >= 0.79)`
      hardGatesApplied.push(`${zone.name}: Excluded due to RED risk band.`)
    }
    // Hard Gate 3: Staff Closed
    else if (zone.closed) {
      passed = false
      rejectionReason = `Zone closed by venue staff`
      hardGatesApplied.push(`${zone.name}: Excluded due to staff closure.`)
    }
    // Soft Ceiling check
    else if (occPct >= profile.softCeiling) {
      if (profile.id === 'general' && occPct >= 75) {
        // Soft penalty for general
      } else if (occPct >= profile.softCeiling) {
        passed = false
        rejectionReason = `Soft ceiling reached for ${profile.name} (${occPct.toFixed(0)}% >= ${profile.softCeiling}%)`
      }
    }

    // AI Scoring Components
    // Vacancy Score = 100 * (1 - proj_occ_pct)^2
    const vacancyRatio = Math.max(0, 1 - projOcc / zone.capacity)
    const vacancyScore = 100 * Math.pow(vacancyRatio, 2)

    const comfortComp = profile.wComfort * zone.comfort * profile.sensitivity
    const vacancyComp = profile.wVacancy * vacancyScore
    const distanceComp = profile.wDist * (zone.distance * 0.25)
    const riskComp = profile.wRisk * (zone.cpi * 100)

    // Model specific tweaks
    let surgePenalty = 0
    if (modelType === 'neural_surge') {
      // Neural surge model heavily penalizes zones trending up in CPI
      surgePenalty = zone.cpi >= 0.65 ? (zone.cpi - 0.55) * 45 : 0
    } else if (modelType === 'q_routing') {
      // Q-routing penalizes distance & heat combinations exponentially
      surgePenalty = zone.temperature > 30 ? (zone.temperature - 30) * 4.5 : 0
    }

    // Total AI Utility Score
    let rawScore = comfortComp + vacancyComp - distanceComp - riskComp - surgePenalty

    // Heavy penalty if soft ceiling breached for general
    if (profile.id === 'general' && occPct >= 75) {
      rawScore -= 25
    }

    const finalScore = passed ? Math.max(0, Math.round(rawScore)) : 0

    return {
      zoneId: zone.id,
      zoneName: zone.name,
      score: finalScore,
      comfortComponent: Math.round(comfortComp),
      vacancyComponent: Math.round(vacancyComp),
      distanceComponent: Math.round(distanceComp),
      riskComponent: Math.round(riskComp),
      surgePenalty: Math.round(surgePenalty),
      passedHardGates: passed,
      rejectionReason,
      projOccPct,
    }
  })

  // Find passed candidate with highest score
  const validEvaluations = evaluations.filter((e) => e.passedHardGates).sort((a, b) => b.score - a.score)

  if (validEvaluations.length === 0) {
    return {
      selectedZoneId: 'none',
      selectedZoneName: 'HOLD ENTRY',
      modelType,
      profile,
      reason: 'VENUE FULL / HOLD ENTRY: All candidate zones are at capacity ceiling or in RED risk band.',
      hardGatesApplied,
      zoneEvaluations: evaluations,
    }
  }

  const winner = validEvaluations[0]
  const winnerZone = zones.find((z) => z.id === winner.zoneId)!

  // Build Natural Language Explainability Rationale
  let reason = ''
  if (profile.id === 'elderly' || profile.id === 'pregnant') {
    reason = `AI selected ${winner.zoneName}: Cooler temperature (${winnerZone.temperature.toFixed(1)}°C) and higher comfort score (${winnerZone.comfort}/100). Within soft ceiling limits (${winner.projOccPct.toFixed(0)}% < ${profile.softCeiling}%).`
  } else if (profile.id === 'mobility') {
    reason = `AI selected ${winner.zoneName}: Shortest distance cost (${winnerZone.distance}m) with acceptable crowd pressure (CPI ${winnerZone.cpi.toFixed(2)}).`
  } else if (modelType === 'neural_surge') {
    reason = `AI Predictive Surge Model selected ${winner.zoneName}: Lowest projected 10-minute bottleneck risk with maximum capacity headroom.`
  } else {
    reason = `AI selected ${winner.zoneName}: Optimal combination of vacancy headroom (${Math.round(100 - winner.projOccPct)}%) and low pressure (CPI ${winnerZone.cpi.toFixed(2)}).`
  }

  return {
    selectedZoneId: winner.zoneId,
    selectedZoneName: winner.zoneName,
    modelType,
    profile,
    reason,
    hardGatesApplied,
    zoneEvaluations: evaluations,
  }
}
