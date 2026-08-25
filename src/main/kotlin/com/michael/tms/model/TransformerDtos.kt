package com.michael.tms.model

import kotlinx.serialization.Serializable

@Serializable
data class CreateTransformerRequest(
    val siteId: String,
    val serialNumber: String,
    val manufacturer: String? = null,
    val manufactureYear: Int? = null,
    val phaseType: PhaseType,
    val vectorGroup: String? = null,
    val ratedPowerKva: Double? = null,
    val coolingType: String? = null,
    val hvNominalVoltage: Double,
    val lvNominalVoltage: Double,
    val tapConfig: TapConfig,
    val isSpecialDesign: Boolean = false,
    val customTapRatioMatrix: CustomTapRatioMatrix? = null
)

/**
 * Todos los campos son opcionales: solo los presentes se aplican (semántica PATCH).
 * La validación de consistencia (matriz personalizada vs. tap_config) se re-evalúa
 * siempre sobre el estado ya fusionado (existente + cambios), nunca de forma parcial.
 */
@Serializable
data class UpdateTransformerRequest(
    val siteId: String? = null,
    val serialNumber: String? = null,
    val manufacturer: String? = null,
    val manufactureYear: Int? = null,
    val phaseType: PhaseType? = null,
    val vectorGroup: String? = null,
    val clearVectorGroup: Boolean = false,
    val ratedPowerKva: Double? = null,
    val coolingType: String? = null,
    val hvNominalVoltage: Double? = null,
    val lvNominalVoltage: Double? = null,
    val tapConfig: TapConfig? = null,
    val isSpecialDesign: Boolean? = null,
    val customTapRatioMatrix: CustomTapRatioMatrix? = null,
    val status: TransformerStatus? = null
)

@Serializable
data class TransformerResponse(
    val id: String,
    val siteId: String,
    val serialNumber: String,
    val manufacturer: String?,
    val manufactureYear: Int?,
    val phaseType: String,
    val vectorGroup: String?,
    val ratedPowerKva: Double?,
    val coolingType: String?,
    val hvNominalVoltage: Double,
    val lvNominalVoltage: Double,
    val tapConfig: TapConfig,
    val isSpecialDesign: Boolean,
    val customTapRatioMatrix: CustomTapRatioMatrix?,
    val status: String,
    val createdAt: String,
    val updatedAt: String
)
