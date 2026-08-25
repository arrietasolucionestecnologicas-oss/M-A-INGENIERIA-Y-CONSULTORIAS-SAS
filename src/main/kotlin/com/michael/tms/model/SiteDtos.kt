package com.michael.tms.model

import kotlinx.serialization.Serializable

@Serializable
data class CreateSiteRequest(
    val clientName: String,
    val siteName: String,
    val address: String? = null,
    val latitude: Double? = null,
    val longitude: Double? = null
)

@Serializable
data class UpdateSiteRequest(
    val clientName: String? = null,
    val siteName: String? = null,
    val address: String? = null,
    val latitude: Double? = null,
    val longitude: Double? = null
)

@Serializable
data class SiteResponse(
    val id: String,
    val clientName: String,
    val siteName: String,
    val address: String?,
    val latitude: Double?,
    val longitude: Double?,
    val createdAt: String
)
