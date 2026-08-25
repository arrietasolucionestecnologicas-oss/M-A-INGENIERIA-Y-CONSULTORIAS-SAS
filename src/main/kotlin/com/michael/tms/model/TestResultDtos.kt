package com.michael.tms.model

import kotlinx.serialization.Serializable

@Serializable
data class TestResultResponse(
    val id: String,
    val testSessionId: String,
    val testType: String,
    val rawReadings: kotlinx.serialization.json.JsonElement,
    val calculatedResults: kotlinx.serialization.json.JsonElement,
    val verdict: String,
    val instrumentUsed: String?,
    val testedBy: String,
    val createdAt: String
)

// ---------------------------------------------------------------------
// TTR (Relación de Transformación)
// ---------------------------------------------------------------------

@Serializable
data class TtrPhaseReading(
    val measuredRatio: Double,
    val excitationCurrentMa: Double? = null,
    val phaseDeviationDeg: Double? = null
)

@Serializable
data class TtrRawReadings(
    val testVoltageV: Double? = null,
    /** clave externa = posición de TAP (como texto); clave interna = identificador de fase, ej. "H1H2-X1X2" */
    val measurements: Map<String, Map<String, TtrPhaseReading>>
)

@Serializable
data class SubmitTtrRequest(
    val instrumentUsed: String? = null,
    val readings: TtrRawReadings
)

@Serializable
data class TtrPhaseResult(
    val measuredRatio: Double,
    val appliedTheoreticalRatio: Double,
    val errorPercent: Double,
    val status: String
)

@Serializable
data class TtrTapResult(
    val tapVoltage: Double,
    val phases: Map<String, TtrPhaseResult>,
    val tapVerdict: String
)

@Serializable
data class TtrCalculatedResults(
    val theoreticalSource: String,
    val vectorGroupApplied: String?,
    val tolerancePercent: Double,
    val taps: Map<String, TtrTapResult>,
    val overallVerdict: String
)

// ---------------------------------------------------------------------
// Resistencia de Devanados
// ---------------------------------------------------------------------

@Serializable
data class WindingPhaseReading(
    val resistanceOhm: Double
)

@Serializable
data class WindingResistanceRawReadings(
    val tapPosition: Int? = null,
    val windingTemperatureC: Double? = null,
    /** clave = identificador de fase, ej. "H1-H2" */
    val measurements: Map<String, WindingPhaseReading>
)

@Serializable
data class SubmitWindingResistanceRequest(
    val instrumentUsed: String? = null,
    val readings: WindingResistanceRawReadings
)

@Serializable
data class WindingPhaseResult(
    val deviationFromAvgPercent: Double,
    val status: String
)

@Serializable
data class WindingResistanceCalculatedResults(
    val averageResistanceOhm: Double,
    val unbalanceThresholdPercent: Double,
    val phases: Map<String, WindingPhaseResult>,
    val maxUnbalancePercent: Double,
    val overallVerdict: String
)

// ---------------------------------------------------------------------
// Aislamiento (Megger) - DAR / IP
// ---------------------------------------------------------------------

@Serializable
data class InsulationPhaseReading(
    val r30sMegaohm: Double,
    val r60sMegaohm: Double,
    val r10minMegaohm: Double
)

@Serializable
data class InsulationRawReadings(
    val testVoltageKv: Double? = null,
    val oilTemperatureC: Double? = null,
    /** clave = par bajo prueba, ej. "HV-GND", "LV-GND", "HV-LV" */
    val measurements: Map<String, InsulationPhaseReading>
)

@Serializable
data class SubmitInsulationRequest(
    val instrumentUsed: String? = null,
    val readings: InsulationRawReadings
)

@Serializable
data class InsulationPhaseResult(
    val dar: Double,
    val darRating: String,
    val ip: Double,
    val ipRating: String
)

@Serializable
data class InsulationCalculatedResults(
    val measurements: Map<String, InsulationPhaseResult>,
    val overallVerdict: String
)
