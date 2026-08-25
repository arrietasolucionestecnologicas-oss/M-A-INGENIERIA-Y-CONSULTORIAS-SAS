package com.michael.tms.model

import kotlinx.serialization.Serializable

@Serializable
data class CreateTenantRequest(
    val companyName: String,
    val taxId: String? = null,
    val plan: TenantPlan = TenantPlan.BASIC,
    val maxUsers: Int = 20
)

@Serializable
data class UpdateTenantRequest(
    val companyName: String? = null,
    val taxId: String? = null,
    val isActive: Boolean? = null,
    val plan: TenantPlan? = null,
    val maxUsers: Int? = null,
    val subscriptionExpiresAt: String? = null
)

@Serializable
data class TenantResponse(
    val id: String,
    val companyName: String,
    val taxId: String?,
    val isActive: Boolean,
    val plan: String,
    val maxUsers: Int,
    val subscriptionExpiresAt: String?,
    val createdAt: String,
    val updatedAt: String
)

@Serializable
data class BootstrapAdminUserRequest(
    val email: String,
    val password: String,
    val fullName: String
)
