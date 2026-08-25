package com.michael.tms.plugins

import com.michael.tms.model.ErrorResponse
import com.michael.tms.model.UserRole
import com.michael.tms.security.JwtConfig
import com.michael.tms.security.TmsPrincipal
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.jwt.jwt
import io.ktor.server.response.respond
import java.util.UUID

/**
 * Instala autenticación JWT. Como segunda capa de defensa además del Kill Switch (que ya
 * valida X-Tenant-ID contra tenants.is_active antes de llegar aquí), este validador exige
 * que el tenant_id embebido en el token coincida exactamente con el header X-Tenant-ID de
 * la petición: un token emitido para un tenant no puede reutilizarse contra otro.
 */
fun Application.configureSecurity() {
    JwtConfig.init(environment.config)

    install(Authentication) {
        jwt("auth-jwt") {
            realm = JwtConfig.realm
            verifier(JwtConfig.verifier())
            validate { credential ->
                val userId = credential.payload.getClaim("userId")?.asString()
                val tenantId = credential.payload.getClaim("tenantId")?.asString()
                val role = credential.payload.getClaim("role")?.asString()
                if (userId.isNullOrBlank() || tenantId.isNullOrBlank() || role.isNullOrBlank()) {
                    return@validate null
                }

                val headerTenantId = request.headers["X-Tenant-ID"]
                if (headerTenantId.isNullOrBlank() || headerTenantId != tenantId) {
                    return@validate null
                }

                try {
                    TmsPrincipal(UUID.fromString(userId), UUID.fromString(tenantId), UserRole.valueOf(role))
                } catch (ex: IllegalArgumentException) {
                    null
                }
            }
            challenge { _, _ ->
                call.respond(HttpStatusCode.Unauthorized, ErrorResponse("Token inválido, expirado o X-Tenant-ID no coincide"))
            }
        }
    }
}
