package com.michael.tms.service.calc

import com.michael.tms.model.CustomTapRatioMatrix
import com.michael.tms.model.PhaseType
import com.michael.tms.model.TapConfig
import java.util.UUID

/**
 * Vista de solo lectura del perfil del transformador necesaria para los cálculos de
 * pruebas. Se construye a partir de la fila persistida en cada solicitud de cálculo,
 * nunca se cachea, para que siempre refleje el estado vigente del equipo.
 */
data class TransformerCalcContext(
    val id: UUID,
    val phaseType: PhaseType,
    val vectorGroup: String?,
    val isSpecialDesign: Boolean,
    val tapConfig: TapConfig,
    val customTapRatioMatrix: CustomTapRatioMatrix?,
    val lvNominalVoltage: Double
) {
    val usesCustomMatrix: Boolean
        get() = isSpecialDesign || vectorGroup == "CUSTOM"
}
