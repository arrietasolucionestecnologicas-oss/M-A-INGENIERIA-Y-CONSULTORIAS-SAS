package com.michael.tms.model

import kotlinx.serialization.Serializable

@Serializable
data class ErrorResponse(val error: String)

@Serializable
data class TapPosition(
    val position: Int,
    val voltage: Double
)

@Serializable
data class TapConfig(
    val nominalVoltage: Double,
    val stepPercentage: Double,
    val numPositions: Int,
    val neutralPosition: Int,
    val positions: List<TapPosition>
)

@Serializable
data class CustomTapPhaseRatio(
    val theoreticalRatio: Double
)

@Serializable
data class CustomTapEntry(
    val tapPosition: Int,
    val phases: Map<String, CustomTapPhaseRatio>
)

@Serializable
data class CustomTapRatioMatrix(
    val source: String? = null,
    val enteredByUserId: String? = null,
    val enteredAt: String? = null,
    val taps: List<CustomTapEntry>
)
