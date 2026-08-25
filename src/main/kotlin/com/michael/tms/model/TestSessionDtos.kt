package com.michael.tms.model

import kotlinx.serialization.Serializable

@Serializable
data class CreateTestSessionRequest(
    val testDate: String,
    val ambientTemperatureC: Double? = null,
    val relativeHumidityPct: Double? = null,
    val generalNotes: String? = null
)

@Serializable
data class UpdateTestSessionRequest(
    val testDate: String? = null,
    val ambientTemperatureC: Double? = null,
    val relativeHumidityPct: Double? = null,
    val sessionStatus: SessionStatus? = null,
    val generalNotes: String? = null
)

@Serializable
data class TestSessionResponse(
    val id: String,
    val transformerId: String,
    val testDate: String,
    val responsibleUserId: String,
    val ambientTemperatureC: Double?,
    val relativeHumidityPct: Double?,
    val sessionStatus: String,
    val generalNotes: String?,
    val createdAt: String,
    val updatedAt: String
)
