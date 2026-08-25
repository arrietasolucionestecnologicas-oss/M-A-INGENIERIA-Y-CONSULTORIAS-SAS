package com.michael.tms.security

import com.michael.tms.model.UserRole
import io.ktor.server.auth.Principal
import java.util.UUID

data class TmsPrincipal(
    val userId: UUID,
    val tenantId: UUID,
    val role: UserRole
) : Principal
