package com.michael.tms.service.calc

import com.michael.tms.model.WindingPhaseResult
import com.michael.tms.model.WindingResistanceCalculatedResults
import com.michael.tms.model.WindingResistanceRawReadings
import com.michael.tms.security.BadRequestException
import kotlin.math.abs

/**
 * Desbalance entre fases de resistencia de devanados. Con una sola fase medida (caso
 * monofásico o ensayo parcial) no hay base de comparación: se marca APROBADO informativo.
 */
object WindingResistanceCalculator {
    private const val UNBALANCE_THRESHOLD_PERCENT = 5.0

    fun calculate(raw: WindingResistanceRawReadings): WindingResistanceCalculatedResults {
        if (raw.measurements.isEmpty()) {
            throw BadRequestException("Debe incluir al menos una lectura de resistencia de devanados")
        }

        val values = raw.measurements.values.map { it.resistanceOhm }
        val average = values.average()

        if (raw.measurements.size == 1) {
            val onlyKey = raw.measurements.keys.first()
            return WindingResistanceCalculatedResults(
                averageResistanceOhm = average,
                unbalanceThresholdPercent = UNBALANCE_THRESHOLD_PERCENT,
                phases = mapOf(onlyKey to WindingPhaseResult(deviationFromAvgPercent = 0.0, status = "APROBADO")),
                maxUnbalancePercent = 0.0,
                overallVerdict = "APROBADO"
            )
        }

        val phaseResults = raw.measurements.mapValues { (_, reading) ->
            val deviation = ((reading.resistanceOhm - average) / average) * 100.0
            val status = if (abs(deviation) <= UNBALANCE_THRESHOLD_PERCENT) "APROBADO" else "RECHAZADO"
            WindingPhaseResult(deviationFromAvgPercent = deviation, status = status)
        }

        val maxUnbalance = phaseResults.values.maxOf { abs(it.deviationFromAvgPercent) }
        val overallVerdict = if (maxUnbalance <= UNBALANCE_THRESHOLD_PERCENT) "APROBADO" else "RECHAZADO"

        return WindingResistanceCalculatedResults(
            averageResistanceOhm = average,
            unbalanceThresholdPercent = UNBALANCE_THRESHOLD_PERCENT,
            phases = phaseResults,
            maxUnbalancePercent = maxUnbalance,
            overallVerdict = overallVerdict
        )
    }
}
