package com.michael.tms.routes

import com.michael.tms.model.CreateUserRequest
import com.michael.tms.model.UpdateUserRequest
import com.michael.tms.model.UserRole
import com.michael.tms.security.requireRole
import com.michael.tms.security.tmsPrincipal
import com.michael.tms.service.UserService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import java.util.UUID

/** Gestión de usuarios: solo ADMINISTRADOR crea, edita o desactiva cuentas del tenant. */
fun Route.userRoutes() {
    route("/users") {
        post {
            val principal = call.requireRole(UserRole.ADMINISTRADOR)
            val request = call.receive<CreateUserRequest>()
            call.respond(HttpStatusCode.Created, UserService.create(principal.tenantId, request))
        }
        get {
            val principal = call.tmsPrincipal()
            call.respond(UserService.list(principal.tenantId))
        }
        get("/{id}") {
            val principal = call.tmsPrincipal()
            val id = UUID.fromString(call.parameters["id"])
            call.respond(UserService.get(principal.tenantId, id))
        }
        patch("/{id}") {
            val principal = call.requireRole(UserRole.ADMINISTRADOR)
            val id = UUID.fromString(call.parameters["id"])
            val request = call.receive<UpdateUserRequest>()
            call.respond(UserService.update(principal.tenantId, id, request))
        }
        delete("/{id}") {
            val principal = call.requireRole(UserRole.ADMINISTRADOR)
            val id = UUID.fromString(call.parameters["id"])
            UserService.delete(principal.tenantId, id)
            call.respond(HttpStatusCode.NoContent)
        }
    }
}
