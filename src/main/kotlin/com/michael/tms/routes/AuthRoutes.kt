package com.michael.tms.routes

import com.michael.tms.db.Users
import com.michael.tms.model.LoginRequest
import com.michael.tms.model.LoginResponse
import com.michael.tms.plugins.TenantIdAttrKey
import com.michael.tms.security.BadRequestException
import com.michael.tms.security.JwtConfig
import com.michael.tms.security.PasswordHashing
import com.michael.tms.service.UserService
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import io.ktor.server.routing.route

fun Route.authRoutes() {
    route("/auth") {
        post("/login") {
            val request = call.receive<LoginRequest>()
            val tenantId = call.attributes[TenantIdAttrKey]

            val userRow = UserService.findActiveForLogin(tenantId, request.email)
                ?: throw BadRequestException("Credenciales inválidas")

            if (!PasswordHashing.matches(request.password, userRow[Users.passwordHash])) {
                throw BadRequestException("Credenciales inválidas")
            }

            val token = JwtConfig.generateToken(
                userId = userRow[Users.id].value,
                tenantId = tenantId,
                role = userRow[Users.role]
            )

            call.respond(
                LoginResponse(
                    token = token,
                    userId = userRow[Users.id].value.toString(),
                    role = userRow[Users.role],
                    fullName = userRow[Users.fullName]
                )
            )
        }
    }
}
