package com.michael.tms.service.calc

import com.michael.tms.db.VectorGroupReference
import com.michael.tms.model.CustomTapEntry
import com.michael.tms.model.TtrCalculatedResults
import com.michael.tms.model.TtrPhaseResult
import com.michael.tms.model.TtrRawReadings
import com.michael.tms.model.TtrTapResult
import com.michael.tms.security.BadRequestException
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import kotlin.math.abs

/**
 * Cálculo híbrido del TTR (IEEE C57.12.90). Si el transformador usa matriz personalizada
 * (equipo especial o grupo CUSTOM), la relación teórica se extrae de custom_tap_ratio_matrix;
 * en caso contrario se calcula a partir del grupo de conexión y la tensión de cada TAP.
 * El valor teórico aplicado se congela en el resultado devuelto (applied_theoretical_ratio) y
 * nunca se recalcula retroactivamente si el perfil del transformador cambia después.
 */
object TtrCalculator {
    private const val TOLERANCE_PERCENT = 0.5

    fun calculate(ctx: TransformerCalcContext, raw: TtrRawReadings): TtrCalculatedResults {
        if (raw.measurements.isEmpty()) {
            throw BadRequestException("Debe incluir al menos una lectura de TAP para calcular el TTR")
        }

        if (ctx.usesCustomMatrix && ctx.customTapRatioMatrix == null) {
            throw BadRequestException(
                "El transformador está marcado como diseño especial o grupo CUSTOM pero no tiene " +
                    "custom_tap_ratio_matrix configurada en su perfil"
            )
        }

        val theoreticalSource = if (ctx.usesCustomMatrix) "CUSTOM_MATRIX" else "VECTOR_GROUP_FORMULA"
        val ratioMultiplier: Double = if (!ctx.usesCustomMatrix) resolveRatioMultiplier(ctx.vectorGroup) else 1.0
        val customMatrixByTap: Map<Int, CustomTapEntry> =
            ctx.customTapRatioMatrix?.taps?.associateBy { it.tapPosition } ?: emptyMap()

        val tapResults = raw.measurements.mapValues { (tapPosStr, phaseReadings) ->
            val tapPosition = tapPosStr.toIntOrNull()
                ?: throw BadRequestException("Posición de TAP inválida: $tapPosStr")

            val tapVoltage = ctx.tapConfig.positions.find { it.position == tapPosition }?.voltage
                ?: throw BadRequestException("La posición de TAP $tapPosition no existe en tap_config del transformador")

            if (phaseReadings.isEmpty()) {
                throw BadRequestException("El TAP $tapPosition no tiene lecturas de fase")
            }

            val phaseResults = phaseReadings.mapValues { (phaseKey, reading) ->
                val theoreticalRatio = if (ctx.usesCustomMatrix) {
                    val entry = customMatrixByTap[tapPosition]
                        ?: throw BadRequestException("custom_tap_ratio_matrix no tiene datos para el TAP $tapPosition")
                    entry.phases[phaseKey]?.theoreticalRatio
                        ?: throw BadRequestException(
                            "custom_tap_ratio_matrix no tiene datos para la fase $phaseKey del TAP $tapPosition"
                        )
                } else {
                    ratioMultiplier * (tapVoltage / ctx.lvNominalVoltage)
                }

                val errorPercent = ((reading.measuredRatio - theoreticalRatio) / theoreticalRatio) * 100.0
                val status = if (abs(errorPercent) <= TOLERANCE_PERCENT) "APROBADO" else "RECHAZADO"

                TtrPhaseResult(
                    measuredRatio = reading.measuredRatio,
                    appliedTheoreticalRatio = theoreticalRatio,
                    errorPercent = errorPercent,
                    status = status
                )
            }

            val tapVerdict = if (phaseResults.values.all { it.status == "APROBADO" }) "APROBADO" else "RECHAZADO"

            TtrTapResult(tapVoltage = tapVoltage, phases = phaseResults, tapVerdict = tapVerdict)
        }

        val overallVerdict = if (tapResults.values.all { it.tapVerdict == "APROBADO" }) "APROBADO" else "RECHAZADO"

        return TtrCalculatedResults(
            theoreticalSource = theoreticalSource,
            vectorGroupApplied = ctx.vectorGroup,
            tolerancePercent = TOLERANCE_PERCENT,
            taps = tapResults,
            overallVerdict = overallVerdict
        )
    }

    /** Para transformadores monofásicos sin grupo vectorial, la relación es directa (multiplicador 1.0). */
    private fun resolveRatioMultiplier(vectorGroup: String?): Double {
        if (vectorGroup == null) return 1.0
        return transaction {
            VectorGroupReference.selectAll()
                .where { (VectorGroupReference.code eq vectorGroup) and (VectorGroupReference.isActive eq true) }
                .singleOrNull()
                ?.get(VectorGroupReference.ratioMultiplier)
        } ?: throw BadRequestException("Grupo de conexión desconocido o inactivo: $vectorGroup")
    }
}
