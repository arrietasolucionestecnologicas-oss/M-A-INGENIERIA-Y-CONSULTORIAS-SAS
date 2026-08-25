package com.michael.tms.service.calc

import com.michael.tms.model.InsulationCalculatedResults
import com.michael.tms.model.InsulationPhaseResult
import com.michael.tms.model.InsulationRawReadings
import com.michael.tms.security.BadRequestException

/**
 * DAR = R60s / R30s ; IP (Índice de Polarización) = R10min / R60s (R60s equivale a R a 1 minuto).
 * Umbrales de referencia orientativos (IEEE 43): ajustables a futuro sin cambiar el contrato JSON.
 */
object InsulationCalculator {

    fun calculate(raw: InsulationRawReadings): InsulationCalculatedResults {
        if (raw.measurements.isEmpty()) {
            throw BadRequestException("Debe incluir al menos una lectura de aislamiento")
        }

        val phaseResults = raw.measurements.mapValues { (_, reading) ->
            if (reading.r30sMegaohm <= 0.0 || reading.r60sMegaohm <= 0.0) {
                throw BadRequestException("Las lecturas de resistencia de aislamiento deben ser mayores a cero")
            }
            val dar = reading.r60sMegaohm / reading.r30sMegaohm
            val ip = reading.r10minMegaohm / reading.r60sMegaohm
            InsulationPhaseResult(
                dar = dar,
                darRating = ratingForDar(dar),
                ip = ip,
                ipRating = ratingForIp(ip)
            )
        }

        val hasMalo = phaseResults.values.any { it.darRating == "MALO" || it.ipRating == "MALO" }
        val hasCuestionable = phaseResults.values.any { it.darRating == "CUESTIONABLE" || it.ipRating == "CUESTIONABLE" }
        val overallVerdict = when {
            hasMalo -> "RECHAZADO"
            hasCuestionable -> "OBSERVADO"
            else -> "APROBADO"
        }

        return InsulationCalculatedResults(measurements = phaseResults, overallVerdict = overallVerdict)
    }

    private fun ratingForDar(dar: Double): String = when {
        dar < 1.0 -> "MALO"
        dar < 1.25 -> "CUESTIONABLE"
        dar < 1.6 -> "BUENO"
        else -> "EXCELENTE"
    }

    private fun ratingForIp(ip: Double): String = when {
        ip < 1.0 -> "MALO"
        ip < 2.0 -> "CUESTIONABLE"
        ip < 4.0 -> "BUENO"
        else -> "EXCELENTE"
    }
}
