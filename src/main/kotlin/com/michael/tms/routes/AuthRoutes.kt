package com.michael.tms.routes

import com.michael.tms.db.Users
import com.michael.tms.model.ErrorResponse
import com.michael.tms.model.LoginRequest
import com.michael.tms.model.LoginResponse
import com.michael.tms.security.BadRequestException
import com.michael.tms.security.JwtConfig
import com.michael.tms.security.NotFoundException
import com.michael.tms.security.PasswordHashing
import com.michael.tms.service.TenantLookupService
import com.michael.tms.service.UserService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.route

/**
 * A diferencia del resto de /api/v1, este endpoint no depende del header X-Tenant-ID
 * (el cliente aún no lo conoce): el Kill Switch lo exime explícitamente
 * (ver plugins/TenantKillSwitch.kt) y aquí se resuelve el tenant a partir de
 * `tenantSlug`, el código corto que sí conoce el usuario final.
 */
fun Route.authRoutes() {
    route("/auth") {
        post("/login") {
            val request = call.receive<LoginRequest>()

            val tenant = TenantLookupService.findBySlug(request.tenantSlug)
                ?: throw NotFoundException("Código de cliente no reconocido: ${request.tenantSlug}")

            if (!tenant.isActive) {
                call.respond(HttpStatusCode.PaymentRequired, ErrorResponse("Cuenta suspendida. Contacte al administrador."))
                return@post
            }

            val userRow = UserService.findActiveForLogin(tenant.id, request.email)
                ?: throw BadRequestException("Credenciales inválidas")

            if (!PasswordHashing.matches(request.password, userRow[Users.passwordHash])) {
                throw BadRequestException("Credenciales inválidas")
            }

            val token = JwtConfig.generateToken(
                userId = userRow[Users.id].value,
                tenantId = tenant.id,
                role = userRow[Users.role]
            )

            call.respond(
                LoginResponse(
                    token = token,
                    tenantId = tenant.id.toString(),
                    userId = userRow[Users.id].value.toString(),
                    role = userRow[Users.role],
                    fullName = userRow[Users.fullName]
                )
            )
        }
    }
}
