package com.michael.tms.model

import kotlinx.serialization.Serializable

@Serializable
data class LoginRequest(
    /** Código corto público del tenant (ej. "cliente01"). El backend lo resuelve al UUID real antes de emitir el JWT. */
    val tenantSlug: String,
    val email: String,
    val password: String
)

@Serializable
data class LoginResponse(
    val token: String,
    val tenantId: String,
    val userId: String,
    val role: String,
    val fullName: String
)

@Serializable
data class CreateUserRequest(
    val email: String,
    val password: String,
    val fullName: String,
    val role: UserRole,
    val licenseNumber: String? = null
)

@Serializable
data class UpdateUserRequest(
    val fullName: String? = null,
    val role: UserRole? = null,
    val licenseNumber: String? = null,
    val isActive: Boolean? = null,
    val password: String? = null
)

@Serializable
data class UserResponse(
    val id: String,
    val email: String,
    val fullName: String,
    val role: String,
    val licenseNumber: String?,
    val isActive: Boolean,
    val createdAt: String
)
