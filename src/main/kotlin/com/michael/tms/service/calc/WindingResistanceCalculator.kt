package com.michael.tms.service.calc

import com.michael.tms.model.WindingPhaseResult
import com.michael.tms.model.WindingResistanceCalculatedResults
import com.michael.tms.model.WindingResistanceRawReadings
import com.michael.tms.model.WindingTapResult
import com.michael.tms.security.BadRequestException
import kotlin.math.abs

/**
 * Desbalance entre fases de resistencia de devanados, por TAP. Un envío puede cubrir varios
 * TAPs en una sola solicitud (igual que TTR); cada TAP se evalúa de forma independiente con
 * su propia temperatura de devanado, y el veredicto global exige que todos los TAPs enviados
 * estén APROBADO. Con una sola fase medida en un TAP (caso monofásico o ensayo parcial) no
 * hay base de comparación: se marca APROBADO informativo para ese TAP.
 */
object WindingResistanceCalculator {
    private const val UNBALANCE_THRESHOLD_PERCENT = 5.0

    fun calculate(raw: WindingResistanceRawReadings): WindingResistanceCalculatedResults {
        if (raw.measurements.isEmpty()) {
            throw BadRequestException("Debe incluir al menos un TAP con lecturas de resistencia de devanados")
        }

        val tapResults = raw.measurements.map { tap ->
            if (tap.phases.isEmpty()) {
                throw BadRequestException("El TAP ${tap.tapPosition} no tiene lecturas de fase")
            }

            val values = tap.phases.values.map { it.resistanceOhm }
            val average = values.average()

            val phaseResults = if (tap.phases.size == 1) {
                tap.phases.mapValues { (_, reading) ->
                    WindingPhaseResult(resistanceOhm = reading.resistanceOhm, deviationFromAvgPercent = 0.0, status = "APROBADO")
                }
            } else {
                tap.phases.mapValues { (_, reading) ->
                    val deviation = ((reading.resistanceOhm - average) / average) * 100.0
                    val status = if (abs(deviation) <= UNBALANCE_THRESHOLD_PERCENT) "APROBADO" else "RECHAZADO"
                    WindingPhaseResult(resistanceOhm = reading.resistanceOhm, deviationFromAvgPercent = deviation, status = status)
                }
            }

            val maxUnbalance = phaseResults.values.maxOf { abs(it.deviationFromAvgPercent) }
            val tapVerdict = if (maxUnbalance <= UNBALANCE_THRESHOLD_PERCENT) "APROBADO" else "RECHAZADO"

            WindingTapResult(
                tapPosition = tap.tapPosition,
                windingTemperatureC = tap.windingTemperatureC,
                averageResistanceOhm = average,
                phases = phaseResults,
                maxUnbalancePercent = maxUnbalance,
                tapVerdict = tapVerdict
            )
        }

        val overallVerdict = if (tapResults.all { it.tapVerdict == "APROBADO" }) "APROBADO" else "RECHAZADO"

        return WindingResistanceCalculatedResults(
            unbalanceThresholdPercent = UNBALANCE_THRESHOLD_PERCENT,
            taps = tapResults,
            overallVerdict = overallVerdict
        )
    }
}
